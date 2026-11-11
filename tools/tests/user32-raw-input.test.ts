import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { InputManager } from '../../src/worker/runtime/input/input-manager';
import { MessageQueue } from '../../src/worker/runtime/windowing/message-queue';
import { TimeService } from '../../src/worker/runtime/time';
import { RAW_MOUSE_HANDLE, RAW_KEYBOARD_HANDLE, WM_INPUT } from '../../src/worker/runtime/input/raw-input';
import { createInputExports } from '../../src/worker/modules/user32/input';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { createMessageExports } from '../../src/worker/modules/user32/message';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { INPUT_BUFFER_SIZE, INPUT_INDEX, KEY_BITFIELD_BASE, beginInputWrite, endInputWrite } from '../../src/input/sab-layout';

const ERROR = 0xffffffff, SIZE = 0x100, RECORD = 0x200, OUT = 0x400;
const mem = new Uint8Array(0x2000);
const dv = new DataView(mem.buffer);
const exports = createInputExports();
const windowExports = createWindowExports();
const messageExports = createMessageExports();
const system = System.getInstance();
let savedInput: InputManager, savedProcess: typeof system.process;
let im: InputManager, queue: MessageQueue, view: Int32Array, lastError: number, thread: number;
let denied: [number, number] | null;
let restoreSpies: Array<() => void>;
let foreground: number;
let savedWindow: WindowInfo | undefined;

function call(name: string, args: number[]): number {
    return (exports[name] ?? windowExports[name])({} as never, mem, args) as number;
}
function record(usage = 2, flags = 0, hwnd = 10, ptr = RECORD): void {
    dv.setUint16(ptr, 1, true);
    dv.setUint16(ptr + 2, usage, true);
    dv.setUint32(ptr + 4, flags, true);
    dv.setUint32(ptr + 8, hwnd, true);
}
function register(usage = 2, flags = 0): void {
    record(usage, flags);
    expect(call('RegisterRawInputDevices', [RECORD, 1, 12])).toBe(1);
}
function publish(dx = 0, dy = 0, keys: number[] = [], buttons = 0, wheel = 0): void {
    beginInputWrite(view);
    view[INPUT_INDEX.dinputDX] += dx;
    view[INPUT_INDEX.dinputDY] += dy;
    view[INPUT_INDEX.buttons] = buttons;
    view[INPUT_INDEX.mouseWheel] += wheel;
    for (let i = 0; i < 8; i++) view[KEY_BITFIELD_BASE + i] = 0;
    for (const vk of keys) view[KEY_BITFIELD_BASE + (vk >> 5)] |= 1 << (vk & 31);
    endInputWrite(view);
    im.poll();
}
function drain() {
    const messages = [];
    for (let m = queue.dequeue(); m; m = queue.dequeue()) messages.push(m);
    return messages;
}
function mousePacket(): number {
    register();
    publish(4, -2);
    return drain().find(m => m.message === WM_INPUT)!.lParam;
}

beforeEach(() => {
    savedInput = system.inputManager;
    savedProcess = system.process;
    denied = null;
    system.process = { addressSpace: { validateRange: (ptr: number, size: number) =>
        ptr >= 0 && ptr + size <= mem.length && (!denied || ptr + size <= denied[0] || ptr >= denied[1]),
    } } as never;
    mem.fill(0xcc);
    Mem.bind(() => mem);
    lastError = 0;
    thread = 7;
    foreground = 10;
    savedWindow = windows.get(10);
    const e = spyOn(system.scheduler, 'setLastError').mockImplementation(value => { lastError = value; });
    const t = spyOn(system.scheduler, 'getCurrentThreadId').mockImplementation(() => thread);
    restoreSpies = [() => e.mockRestore(), () => t.mockRestore()];
    queue = new MessageQueue();
    const win = { hwnd: 10, creatorThreadId: 7, visible: true, style: 0, rect: { x: 0, y: 0, w: 640, h: 480 }, wndClass: { style: 0 } };
    im = new InputManager({
        getWindow: (hwnd: number) => hwnd === 10 ? win : undefined,
        getKeyboardTargetWindow: () => {
            if (!foreground) throw new Error('Raw Input must not invoke the auto-activating legacy fallback in background');
            return win;
        },
        getForegroundHwnd: () => foreground,
        getFocusHwnd: () => foreground ? 10 : 0,
        getCaptureHwnd: () => 0,
        getMouseTargetWindow: () => win,
        getActiveWindow: () => win,
        getTopLevelAncestor: () => 10,
        getActiveHwnd: () => 10,
        setRawInputDiscardCallback: (fn: (handle: number) => void) => queue.setRawInputDiscardCallback(fn),
        postMessage: (hwnd: number, msg: number, wp: number, lp: number, x = 0, y = 0) => queue.enqueue(hwnd, msg, wp, lp, x, y, 7),
        postInputMessage: (hwnd: number, msg: number, wp: number, lp: number, x = 0, y = 0, _thread = 0, keyState?: Uint8Array, extra = 0) =>
            queue.enqueue(hwnd, msg, wp, lp, x, y, 7, keyState, extra, true, 0, true),
    } as never, () => thread);
    system.inputManager = im;
    const sab = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    view = new Int32Array(sab);
    im.setInputBuffer(sab);
});

afterEach(() => {
    for (const restore of restoreSpies) restore();
    system.inputManager = savedInput;
    system.process = savedProcess;
    if (savedWindow) windows.set(10, savedWindow);
    else windows.delete(10);
});

describe('user32 Raw Input ABI', () => {
    test('enumeration reports two real virtual devices with exact 8-byte stride', () => {
        expect(call('GetRawInputDeviceList', [0, SIZE, 8])).toBe(0);
        expect(dv.getUint32(SIZE, true)).toBe(2);
        dv.setUint32(SIZE, 1, true);
        expect(call('GetRawInputDeviceList', [OUT, SIZE, 8])).toBe(ERROR);
        expect(lastError).toBe(122);
        expect(mem[OUT]).toBe(0xcc);
        expect(dv.getUint32(SIZE, true)).toBe(2);
        dv.setUint32(SIZE, 10, true);
        expect(call('GetRawInputDeviceList', [OUT, SIZE, 8])).toBe(2);
        expect([0, 4, 8, 12].map(o => dv.getUint32(OUT + o, true))).toEqual([RAW_MOUSE_HANDLE, 0, RAW_KEYBOARD_HANDLE, 1]);
        expect(dv.getUint32(SIZE, true)).toBe(10);
        expect(mem[OUT + 16]).toBe(0xcc);
    });

    test('registration is atomic and validates all extents before mutation', () => {
        record(2, 0x30);
        record(6, 0, 999, RECORD + 12);
        expect(call('RegisterRawInputDevices', [RECORD, 2, 12])).toBe(0);
        expect(lastError).toBe(1400);
        expect(im.rawInput.getRegistered()).toEqual([]);
        for (const args of [[0, 1, 12], [RECORD + 1, 1, 12], [mem.length - 4, 1, 12], [RECORD, 0xffffffff, 12]]) {
            expect(call('RegisterRawInputDevices', args)).toBe(0);
            expect(lastError).toBe(998);
        }
        for (const args of [[RECORD, 0, 12], [RECORD, 1, 16]]) {
            expect(call('RegisterRawInputDevices', args)).toBe(0);
            expect(lastError).toBe(87);
        }
        denied = [RECORD + 8, RECORD + 12];
        expect(call('RegisterRawInputDevices', [RECORD, 1, 12])).toBe(0);
        expect(lastError).toBe(998);
    });

    test('registered-device query uses documented insufficient-buffer result', () => {
        register(6, 0x30);
        expect(call('GetRegisteredRawInputDevices', [0, SIZE, 12])).toBe(ERROR);
        expect(lastError).toBe(122);
        expect(dv.getUint32(SIZE, true)).toBe(1);
        expect(call('GetRegisteredRawInputDevices', [OUT, SIZE, 12])).toBe(1);
        expect([dv.getUint16(OUT, true), dv.getUint16(OUT + 2, true), dv.getUint32(OUT + 4, true), dv.getUint32(OUT + 8, true)]).toEqual([1, 6, 0x30, 10]);
        expect(mem[OUT + 12]).toBe(0xcc);
    });

    test.each(['A', 'W'])('device names %s count characters including NUL', suffix => {
        const fn = `GetRawInputDeviceInfo${suffix}`;
        expect(call(fn, [RAW_MOUSE_HANDLE, 0x20000007, 0, SIZE])).toBe(0);
        const length = dv.getUint32(SIZE, true);
        expect(length).toBe('\\\\?\\ROOT#BOTTLESHIP_MOUSE#0000'.length + 1);
        expect(call(fn, [RAW_MOUSE_HANDLE, 0x20000007, OUT, SIZE])).toBe(length);
        const stride = suffix === 'W' ? 2 : 1;
        expect(mem[OUT + (length - 1) * stride]).toBe(0);
        expect(mem[OUT + length * stride]).toBe(0xcc);
    });

    test('RID_DEVICE_INFO writes exactly 32 bytes and requires initialized cbSize', () => {
        dv.setUint32(SIZE, 32, true);
        expect(call('GetRawInputDeviceInfoW', [RAW_KEYBOARD_HANDLE, 0x2000000b, OUT, SIZE])).toBe(ERROR);
        expect(lastError).toBe(87);
        dv.setUint32(OUT, 32, true);
        expect(call('GetRawInputDeviceInfoW', [RAW_KEYBOARD_HANDLE, 0x2000000b, OUT, SIZE])).toBe(32);
        expect([0, 4, 8, 12, 16, 20, 24, 28].map(o => dv.getUint32(OUT + o, true))).toEqual([32, 1, 4, 0, 1, 12, 3, 101]);
        expect(mem[OUT + 32]).toBe(0xcc);
    });

    test('unsupported buffer and HID preparsed data fail, never report empty success', () => {
        expect(call('GetRawInputBuffer', [0, SIZE, 16])).toBe(ERROR);
        expect(lastError).toBe(50);
        expect(dv.getUint32(SIZE, true)).toBe(0xcccccccc);
        expect(call('GetRawInputDeviceInfoA', [RAW_MOUSE_HANDLE, 0x20000005, 0, SIZE])).toBe(ERROR);
        expect(lastError).toBe(50);
        expect(call('GetRawInputDeviceInfoA', [123, 0x20000007, 0, SIZE])).toBe(ERROR);
        expect(lastError).toBe(6);
        expect(call('DefRawInputProc', [0, 0, 16])).toBe(0);
        expect(call('DefRawInputProc', [0, 0, 24])).toBe(ERROR);
        expect(lastError).toBe(87);
    });

    test.each(['A', 'W'])('WM_INPUT → GetRawInputData → DefWindowProc%s owns the packet lifetime', suffix => {
        const h = mousePacket();
        expect(call('GetRawInputData', [h, 0x10000003, 0, SIZE, 16])).toBe(0);
        expect(dv.getUint32(SIZE, true)).toBe(40);
        expect(call('GetRawInputData', [h, 0x10000003, OUT, SIZE, 16])).toBe(40);
        expect(dv.getInt32(OUT + 28, true)).toBe(4);
        expect(dv.getInt32(OUT + 32, true)).toBe(-2);
        expect(mem[OUT + 40]).toBe(0xcc);
        mem.fill(0xcc, OUT, OUT + 40);
        expect(call('GetRawInputData', [h, 0x10000005, OUT, SIZE, 16])).toBe(16);
        expect(mem[OUT + 16]).toBe(0xcc);
        thread = 8;
        expect(call('GetRawInputData', [h, 0x10000003, 0, SIZE, 16])).toBe(ERROR);
        expect(lastError).toBe(6);
        call(`DefWindowProc${suffix}`, [10, WM_INPUT, 0, h]);
        thread = 7;
        expect(im.rawInput.pendingCount).toBe(1);
        expect(call(`DefWindowProc${suffix}`, [10, WM_INPUT, 0, h])).toBe(0);
        expect(call('GetRawInputData', [h, 0x10000003, 0, SIZE, 16])).toBe(ERROR);
        expect(lastError).toBe(6);
    });

    test('GetRawInputData bad sizes, commands and inaccessible tail cause no partial writes', () => {
        const h = mousePacket();
        dv.setUint32(SIZE, 39, true);
        expect(call('GetRawInputData', [h, 0x10000003, OUT, SIZE, 16])).toBe(ERROR);
        expect(lastError).toBe(122);
        expect(dv.getUint32(SIZE, true)).toBe(39);
        dv.setUint32(SIZE, 40, true);
        for (const [command, header] of [[0, 16], [0x10000003, 24]]) {
            expect(call('GetRawInputData', [h, command, OUT, SIZE, header])).toBe(ERROR);
            expect(lastError).toBe(87);
        }
        denied = [OUT + 36, OUT + 40];
        expect(call('GetRawInputData', [h, 0x10000003, OUT, SIZE, 16])).toBe(ERROR);
        expect(lastError).toBe(998);
        expect(Array.from(mem.slice(OUT, OUT + 40))).toEqual(Array(40).fill(0xcc));
    });
});

describe('InputManager Raw Input producer', () => {
    test('actual Unity registration flags 0x100 retain legacy input in foreground', () => {
        register(2, 0x100);
        register(6, 0x100);
        publish(1, 0, [65], 1);
        const msgs = drain();
        expect(msgs.filter(m => m.message === WM_INPUT).map(m => m.wParam)).toEqual([0, 0]);
        expect(msgs.some(m => m.message === 0x100)).toBe(true);
        expect(msgs.some(m => m.message === 0x201)).toBe(true);
        foreground = 0;
        publish(1, 0, []);
        const background = drain();
        expect(background.map(m => [m.message, m.wParam])).toEqual([[WM_INPUT, 1], [WM_INPUT, 1]]);
        expect(foreground).toBe(0);
        for (const m of background) {
            const bytes = im.rawInput.getPacket(m.lParam, 7)!;
            expect(bytes[12]).toBe(1);
        }
        foreground = 10;
        publish(0, 0, [], 1);
        expect(drain().some(m => m.message === 0x201)).toBe(true);
    });

    test.each(['A', 'W'])('DispatchMessage%s frees background packet only after suspended WndProc completion', suffix => {
        register(2, 0x100);
        foreground = 0;
        publish(3, 4);
        const m = drain()[0];
        windows.set(10, { handle: 10, title: '', style: 0, x: 0, y: 0, width: 640, height: 480, children: [], visible: true, wndProc: 0x401000 });
        let complete: ((value: number) => unknown) | undefined;
        (system.process as any).dispatcher = { callbackManager: {
            getStubPoolRange: () => ({ base: 0x10000000, end: 0x10000100 }),
            saveSuspendedThunkContext: () => 1,
            invokeCallback: (_proc: number, args: number[], _ret: number, onReturn: (value: number) => unknown) => {
                expect(args).toEqual([10, WM_INPUT, 1, m.lParam]);
                complete = onReturn;
                return { callbackId: 42 };
            },
        } };
        [10, WM_INPUT, 1, m.lParam, 0, 0, 0].forEach((v, i) => dv.setUint32(OUT + i * 4, v, true));
        const result = messageExports[`DispatchMessage${suffix}`]({ esp: 0x1800 } as never, mem, [OUT]) as any;
        expect(result.suspendedForCallback).toBe(true);
        expect(im.rawInput.getPacket(m.lParam, 7)).not.toBeNull();
        expect(call('GetRawInputData', [m.lParam, 0x10000003, 0, SIZE, 16])).toBe(0);
        expect(complete!(123)).toBe(123);
        expect(im.rawInput.getPacket(m.lParam, 7)).toBeNull();
    });

    test('background dispatch without guest WndProc cleans up; foreground still requires DefWindowProc', () => {
        register(2, 0x100);
        publish(1, 0);
        const fg = drain()[0];
        [10, WM_INPUT, 0, fg.lParam, 0].forEach((v, i) => dv.setUint32(OUT + i * 4, v, true));
        messageExports.DispatchMessageW({ esp: 0x1800 } as never, mem, [OUT]);
        expect(im.rawInput.getPacket(fg.lParam, 7)).not.toBeNull();
        call('DefWindowProcW', [10, WM_INPUT, 0, fg.lParam]);
        foreground = 0;
        publish(1, 0);
        const bg = drain()[0];
        [10, WM_INPUT, 1, bg.lParam, 0].forEach((v, i) => dv.setUint32(OUT + i * 4, v, true));
        messageExports.DispatchMessageW({ esp: 0x1800 } as never, mem, [OUT]);
        expect(im.rawInput.pendingCount).toBe(0);
    });

    test.each(['missing-manager', 'failed-frame', 'failed-callback'])('background dispatch cleanup handles %s', mode => {
        register(2, 0x100);
        foreground = 0;
        publish(1, 0);
        const m = drain()[0];
        windows.set(10, { handle: 10, title: '', style: 0, x: 0, y: 0, width: 10, height: 10, children: [], visible: true, wndProc: 0x401000 });
        if (mode !== 'missing-manager') (system.process as any).dispatcher = { callbackManager: {
            getStubPoolRange: () => ({ base: 0x10000000, end: 0x10000100 }),
            saveSuspendedThunkContext: () => mode === 'failed-frame' ? 0 : 1,
            invokeCallback: () => ({ callbackId: 0 }),
        } };
        [10, WM_INPUT, 1, m.lParam, 0].forEach((v, i) => dv.setUint32(OUT + i * 4, v, true));
        messageExports.DispatchMessageW({ esp: 0x1800 } as never, mem, [OUT]);
        expect(im.rawInput.getPacket(m.lParam, 7)).toBeNull();
    });

    test('NOLEGACY emits raw mouse/keyboard while preserving polled state and DirectInput', () => {
        register(2, 0x30);
        register(6, 0x30);
        im.setDInputMouseBufferSize(16);
        im.setDInputKeyboardBufferSize(16);
        publish(5, -3, [65], 1, 100);
        const messages = drain();
        expect(messages.map(m => m.message)).toEqual([WM_INPUT, WM_INPUT]);
        expect(im.getKeyState(65) & 0x8000).toBe(0x8000);
        expect(im.getKeyState(1) & 0x8000).toBe(0x8000);
        expect(im.drainDInputMouseEvents(16).length).toBeGreaterThan(0);
        expect(im.drainDInputKeyboardEvents(16).map(e => [e.dwOfs, e.dwData])).toEqual([[0x1e, 0x80]]);
        expect(view[INPUT_INDEX.dinputDX]).toBe(5);
        expect(view[INPUT_INDEX.dinputDY]).toBe(-3);
        im.poll();
        expect(drain()).toEqual([]);
    });

    test('normal registration retains legacy key messages; raw ignores legacy enqueue gate', () => {
        register(6);
        publish(0, 0, [65]);
        expect(drain().map(m => m.message)).toEqual([WM_INPUT, 0x100]);
        im.setShouldEnqueueMessagesGetter(() => false);
        publish();
        expect(drain().map(m => m.message)).toEqual([WM_INPUT]);
    });

    test('right Ctrl has E0 without duplicate aggregate modifier and reports break', () => {
        register(6, 0x30);
        publish(0, 0, [0xa3]);
        const down = drain();
        expect(down).toHaveLength(1);
        const packet = im.rawInput.getPacket(down[0].lParam, 7)!;
        const p = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        expect([p.getUint16(16, true), p.getUint16(18, true), p.getUint16(22, true)]).toEqual([0x1d, 2, 0x11]);
        publish();
        const up = drain();
        expect(up).toHaveLength(1);
        const bytes = im.rawInput.getPacket(up[0].lParam, 7)!;
        expect(bytes[18]).toBe(3);
    });

    test('initial accumulated mouse motion is not replayed at registration', () => {
        beginInputWrite(view);
        view[INPUT_INDEX.dinputDX] = 400;
        view[INPUT_INDEX.dinputDY] = 300;
        endInputWrite(view);
        register(2, 0x30);
        drain();
        publish(2, -1);
        const messages = drain();
        expect(messages).toHaveLength(1);
        const bytes = im.rawInput.getPacket(messages[0].lParam, 7)!;
        const p = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect([p.getInt32(28, true), p.getInt32(32, true)]).toEqual([2, -1]);
    });

    test('cursor warp does not manufacture relative Raw Input motion', () => {
        register(2, 0x30);
        im.moveCursorTo(100, 200);
        expect(drain().some(m => m.message === WM_INPUT)).toBe(false);
        publish();
        expect(drain().some(m => m.message === WM_INPUT)).toBe(false);
        publish(3, 4);
        expect(drain().filter(m => m.message === WM_INPUT)).toHaveLength(1);
    });

    test('NOLEGACY removal restores key messages and stops raw delivery', () => {
        register(6, 0x30);
        publish(0, 0, [65]);
        expect(drain().map(m => m.message)).toEqual([WM_INPUT]);
        record(6, 1, 0);
        expect(call('RegisterRawInputDevices', [RECORD, 1, 12])).toBe(1);
        publish();
        expect(drain().map(m => m.message)).toEqual([0x101]);
    });

    test('mouse-only INPUTSINK cannot regain foreground through legacy keyboard typematic', () => {
        let now = 10000;
        const time = spyOn(TimeService.getInstance(), 'nowMs').mockImplementation(() => now);
        restoreSpies.push(() => time.mockRestore());
        register(2, 0x100);
        publish(0, 0, [65]);
        drain();
        foreground = 0;
        now += 500;
        im.poll();
        expect(drain()).toEqual([]);
        expect(foreground).toBe(0);
    });

    test.each([0, 10])('typematic with foreground=%i emits raw make packets even when legacy delivery is gated', fg => {
        const clock = TimeService.getInstance();
        let now = 10000;
        const time = spyOn(clock, 'nowMs').mockImplementation(() => now);
        restoreSpies.push(() => time.mockRestore());
        register(6, 0x130);
        foreground = fg;
        im.setShouldEnqueueMessagesGetter(() => false);
        publish(0, 0, [65]);
        expect(drain().map(m => m.message)).toEqual([WM_INPUT]);
        now += 500;
        im.poll();
        const messages = drain();
        expect(messages.map(m => m.message)).toEqual([WM_INPUT]);
        const packet = im.rawInput.getPacket(messages[0].lParam, 7)!;
        expect(packet[18]).toBe(0);
        expect(packet[12]).toBe(fg ? 0 : 1);
        publish();
        drain();
        now += 1000;
        im.poll();
        expect(drain()).toEqual([]);
    });
});
