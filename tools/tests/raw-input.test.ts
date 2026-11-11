import { describe, expect, test } from 'bun:test';
import { RawInputManager, RAW_MOUSE_HANDLE, RAW_KEYBOARD_HANDLE, WM_INPUT } from '../../src/worker/runtime/input/raw-input';
import { MessageQueue } from '../../src/worker/runtime/windowing/message-queue';

const record = (usage = 2, flags = 0, hwnd = 10) => ({ usagePage: 1, usage, flags, hwnd });

function rig() {
    const queue = new MessageQueue();
    const windows = new Map([[10, { hwnd: 10, creatorThreadId: 7 }], [20, { hwnd: 20, creatorThreadId: 8 }]]);
    let focus = 10;
    let foreground = 10;
    const raw = new RawInputManager({
        getWindow: hwnd => windows.get(hwnd),
        getFocusHwnd: () => focus,
        getForegroundHwnd: () => foreground,
        postInputMessage: (hwnd, msg, wp, lp, x, y) => queue.enqueue(hwnd, msg, wp, lp, x, y, windows.get(hwnd)?.creatorThreadId, undefined, 0, true, 0, true),
    });
    queue.setRawInputDiscardCallback(handle => raw.release(handle));
    const next = () => queue.dequeue(0, 0, 7)!;
    const packet = (handle: number, thread = 7) => {
        const bytes = raw.getPacket(handle, thread)!;
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    return { raw, queue, windows, next, packet,
        focus: (hwnd: number) => { focus = hwnd; foreground = hwnd; },
        foreground: (hwnd: number) => { foreground = hwnd; },
    };
}

describe('Raw Input registration', () => {
    test('atomic validation, last registration wins and removal reenables legacy', () => {
        const { raw } = rig();
        expect(raw.register([record(2, 0x30), record(6, 0, 999)])).toBe(1400);
        expect(raw.getRegistered()).toEqual([]);
        expect(raw.register([record(2), record(2, 0x30, 20), record(6)])).toBe(0);
        expect(raw.getRegistered()).toEqual([record(2, 0x30, 20), record(6)]);
        expect(raw.suppressesLegacy(2)).toBe(true);
        expect(raw.suppressesMouseActivation()).toBe(false);
        expect(raw.suppressesLegacy(6)).toBe(false);
        expect(raw.register([record(2, 1, 0)])).toBe(0);
        expect(raw.suppressesLegacy(2)).toBe(false);
    });

    test.each([
        [record(2, 0x8000), 87], [record(2, 1), 87], [record(2, 0x31, 0), 87],
        [record(2, 0x100, 0), 87], [record(2, 0x1000, 0), 87],
        [record(2, 0x200), 87], [record(6, 0x400), 87],
        [record(2, 0x100, 999), 1400], [record(2, 0x1000), 50], [record(2, 0x2000), 50],
        [record(6, 0x200), 50], [record(6, 0x430), 50],
        [record(2, 0x10), 50], [record(2, 0x20), 50], [record(4), 50],
        [{ ...record(), usagePage: 2 }, 50],
    ])('rejects unsupported or invalid registration %#', (r, error) => {
        expect(rig().raw.register([r as ReturnType<typeof record>])).toBe(error as number);
    });

    test('accepts mouse NOLEGACY + CAPTUREMOUSE and follows focus for NULL target', () => {
        const r = rig();
        expect(r.raw.register([record(2, 0x230, 0)])).toBe(0);
        expect(r.raw.suppressesMouseActivation()).toBe(true);
        r.focus(20);
        r.raw.feedMouse(1, 2, 0, 0, 0, 0);
        expect(r.queue.dequeue(0, 0, 8)?.hwnd).toBe(20);
        r.focus(0);
        r.raw.feedMouse(2, 3, 0, 0, 0, 0);
        expect(r.queue.dequeue()).toBeNull();
    });
});

describe('RIDEV_INPUTSINK routing', () => {
    test.each([2, 6])('usage %i routes foreground/background with matching message and header codes', usage => {
        const r = rig();
        expect(r.raw.register([record(usage, 0x100)])).toBe(0);
        const feed = () => usage === 2 ? r.raw.feedMouse(0, 0, 0, 120, 0, 0) : r.raw.feedKeyboard(65, 30, 0, 0x100);
        feed();
        const fg = r.next();
        expect([fg.hwnd, fg.wParam, r.packet(fg.lParam).getUint32(12, true)]).toEqual([10, 0, 0]);
        r.foreground(0);
        feed();
        const bg = r.next();
        expect([bg.hwnd, bg.wParam, r.packet(bg.lParam).getUint32(12, true)]).toEqual([10, 1, 1]);
        expect(r.raw.suppressesLegacy(usage)).toBe(false);
        r.foreground(20);
        feed();
        const otherWindowSameApp = r.next();
        expect(otherWindowSameApp.wParam).toBe(0);
    });

    test('ordinary registration cannot deliver with no foreground, even with stale focus', () => {
        const r = rig();
        r.raw.register([record(), record(6)]);
        r.foreground(0);
        r.raw.feedMouse(1, 2, 0, 0, 0, 0);
        r.raw.feedKeyboard(65, 30, 0, 0x100);
        expect(r.queue.dequeue()).toBeNull();
    });

    test('INPUTSINK + NOLEGACY combines routing with explicit legacy suppression', () => {
        const r = rig();
        expect(r.raw.register([record(2, 0x130), record(6, 0x130)])).toBe(0);
        expect(r.raw.suppressesLegacy(2)).toBe(true);
        expect(r.raw.suppressesLegacy(6)).toBe(true);
        r.foreground(0);
        r.raw.feedMouse(1, 2, 0, 0, 0, 0);
        expect(r.next().wParam).toBe(1);
    });

    test('background cleanup validates actual packet kind and owner, including early DefWindowProc', () => {
        const r = rig();
        r.raw.register([record(6, 0x100)]);
        r.raw.feedKeyboard(65, 30, 0, 0x100);
        const fg = r.next().lParam;
        r.raw.releaseBackground(fg, 10, 7);
        expect(r.raw.getPacket(fg, 7)).not.toBeNull();
        r.foreground(0);
        r.raw.feedKeyboard(65, 30, 1, 0x101);
        const bg = r.next().lParam;
        r.raw.releaseBackground(bg, 20, 7);
        r.raw.releaseBackground(bg, 10, 8);
        expect(r.raw.getPacket(bg, 7)).not.toBeNull();
        r.raw.release(bg, 10, 7);
        r.raw.releaseBackground(bg, 10, 7);
        expect(r.raw.getPacket(bg, 7)).toBeNull();
        expect(r.raw.pendingCount).toBe(1);
    });

    test('destroyed target cannot keep receiving background input; removal reenables legacy', () => {
        const r = rig();
        r.raw.register([record(2, 0x130)]);
        r.foreground(0);
        r.raw.feedMouse(1, 0, 0, 0, 0, 0);
        r.windows.delete(10);
        r.raw.feedMouse(2, 0, 0, 0, 0, 0);
        expect(r.raw.pendingCount).toBe(0);
        expect(r.raw.getRegistered()).toEqual([]);
        expect(r.raw.suppressesLegacy(2)).toBe(false);
    });
});

describe('Raw Input packet layout and lifetime', () => {
    test('40-byte mouse packet contains relative motion, five button edges and signed wheel', () => {
        const r = rig();
        r.raw.register([record()]);
        r.raw.feedMouse(-7, 12, 31, -120, 40, 50);
        const m = r.next();
        expect([m.message, m.wParam, m.ptX, m.ptY]).toEqual([WM_INPUT, 0, 40, 50]);
        const p = r.packet(m.lParam);
        expect(p.byteLength).toBe(40);
        expect([0, 4, 8, 12].map(o => p.getUint32(o, true))).toEqual([0, 40, RAW_MOUSE_HANDLE, 0]);
        expect(p.getUint16(16, true)).toBe(0);
        expect(p.getUint16(20, true)).toBe(0x555);
        expect(p.getInt16(22, true)).toBe(-120);
        expect(p.getInt32(28, true)).toBe(-7);
        expect(p.getInt32(32, true)).toBe(12);
        r.raw.feedMouse(-7, 12, 0, 0, 0, 0);
        expect(r.packet(r.next().lParam).getUint16(20, true)).toBe(0x2aa);
    });

    test('no stale pre-registration delta; signed accumulator wrap is relative', () => {
        const r = rig();
        r.raw.feedMouse(0x7fffffff, 100, 0, 0, 0, 0);
        r.raw.register([record()]);
        r.raw.feedMouse(-0x80000000, 99, 0, 0, 0, 0);
        const p = r.packet(r.next().lParam);
        expect(p.getInt32(28, true)).toBe(1);
        expect(p.getInt32(32, true)).toBe(-1);
    });

    test('32-byte keyboard packet, repeated reads, owner checks and explicit release', () => {
        const r = rig();
        r.raw.register([record(6)]);
        r.raw.feedKeyboard(0x11, 0x1d, 3, 0x101);
        const h = r.next().lParam;
        const p = r.packet(h);
        expect(p.byteLength).toBe(32);
        expect([0, 4, 8, 12].map(o => p.getUint32(o, true))).toEqual([1, 32, RAW_KEYBOARD_HANDLE, 0]);
        expect([16, 18, 20, 22].map(o => p.getUint16(o, true))).toEqual([0x1d, 3, 0, 0x11]);
        expect(p.getUint32(24, true)).toBe(0x101);
        expect(r.raw.getPacket(h, 8)).toBeNull();
        r.raw.release(h, 20, 7);
        r.raw.release(h, 10, 8);
        expect(r.raw.getPacket(h, 7)).not.toBeNull();
        r.raw.release(h, 10, 7);
        r.raw.release(h, 10, 7);
        expect(r.raw.getPacket(h, 7)).toBeNull();
        expect(r.raw.pendingCount).toBe(0);
    });

    test('peek and dequeue retain packets; window destruction and queue clear release them', () => {
        const r = rig();
        r.raw.register([record(), record(6)]);
        r.raw.feedMouse(1, 0, 0, 0, 0, 0);
        const h = r.queue.peek()!.lParam;
        expect(r.raw.pendingCount).toBe(1);
        expect(r.next().lParam).toBe(h);
        expect(r.raw.pendingCount).toBe(1);
        r.raw.removeWindow(10);
        expect(r.raw.pendingCount).toBe(0);
        expect(r.raw.getRegistered()).toEqual([]);
        r.raw.register([record()]);
        r.raw.feedMouse(2, 0, 0, 0, 0, 0);
        r.queue.clear();
        expect(r.raw.pendingCount).toBe(0);
        r.raw.feedMouse(3, 0, 0, 0, 0, 0);
        r.queue.removeWindow(10);
        expect(r.raw.pendingCount).toBe(0);
    });

    test('queue eviction reclaims raw storage, without freeing delivered handles', () => {
        const r = rig();
        r.raw.register([record()]);
        r.raw.feedMouse(1, 0, 0, 0, 0, 0);
        const delivered = r.next().lParam;
        for (let i = 2; i < 2000; i++) r.raw.feedMouse(i, 0, 0, 0, 0, 0);
        expect(r.raw.droppedPackets).toBe(0);
        expect(r.raw.pendingCount).toBe(257);
        expect(r.raw.getPacket(delivered, 7)).not.toBeNull();
        r.queue.clear();
        expect(r.raw.pendingCount).toBe(1);
    });

    test('pool bounds leaked delivered packets and reset never aliases stale handles', () => {
        const r = rig();
        r.raw.register([record(6)]);
        for (let i = 0; i < 1024; i++) {
            r.raw.feedKeyboard(65, 30, 0, 0x100);
            r.next();
        }
        expect(r.raw.pendingCount).toBe(1024);
        r.raw.feedKeyboard(65, 30, 0, 0x100);
        expect(r.raw.droppedPackets).toBe(1);
        r.raw.reset();
        r.raw.register([record(6)]);
        r.raw.feedKeyboard(65, 30, 0, 0x100);
        expect(r.next().lParam).toBeGreaterThan(0x710003ff);
        expect(r.raw.getPacket(0x71000000, 7)).toBeNull();
    });
});
