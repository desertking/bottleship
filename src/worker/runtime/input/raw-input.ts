export const WM_INPUT = 0x00ff;
export const RAWINPUT_HEADER_SIZE = 16;
export const RAW_MOUSE_HANDLE = 0x52490001;
export const RAW_KEYBOARD_HANDLE = 0x52490002;
export const RIDEV_REMOVE = 0x0001;
export const RIDEV_NOLEGACY = 0x0030;
export const RIDEV_INPUTSINK = 0x0100;
export const RIM_INPUT = 0;
export const RIM_INPUTSINK = 1;

export interface RawInputRegistration {
    usagePage: number;
    usage: number;
    flags: number;
    hwnd: number;
}

interface RawInputWindows {
    getWindow(hwnd: number): { hwnd: number; creatorThreadId?: number } | undefined;
    getForegroundHwnd(): number;
    getFocusHwnd(): number;
    postMessage(hwnd: number, msg: number, wParam: number, lParam: number, x?: number, y?: number): void;
}

const PACKET_CAPACITY = 1024;
const PACKET_STRIDE = 40;

export class RawInputManager {
    private readonly registrations = new Map<number, RawInputRegistration>();
    private readonly bytes = new Uint8Array(PACKET_CAPACITY * PACKET_STRIDE);
    private readonly view = new DataView(this.bytes.buffer);
    private readonly slots = new Map<number, number>();
    private readonly owners = new Uint32Array(PACKET_CAPACITY);
    private readonly threads = new Uint32Array(PACKET_CAPACITY);
    private readonly lengths = new Uint8Array(PACKET_CAPACITY);
    private readonly free = new Uint16Array(PACKET_CAPACITY);
    private freeCount = 0;
    private nextHandle = 0x71000000;
    private mouseX = 0;
    private mouseY = 0;
    private buttons = 0;
    public droppedPackets = 0;

    constructor(private readonly windows: RawInputWindows) {
        this.reset();
    }

    reset(): void {
        this.registrations.clear();
        this.slots.clear();
        this.freeCount = PACKET_CAPACITY;
        for (let i = 0; i < PACKET_CAPACITY; i++) this.free[i] = i;
        this.seedMouse(0, 0, 0);
        this.droppedPackets = 0;
    }

    seedMouse(x: number, y: number, buttons: number): void {
        this.mouseX = x | 0;
        this.mouseY = y | 0;
        this.buttons = buttons & 31;
    }

    get pendingCount(): number { return this.slots.size; }

    isRegistered(usage: number): boolean { return this.registrations.has(usage); }

    getRegistered(): readonly RawInputRegistration[] {
        return [...this.registrations.values()].sort((a, b) => a.usage - b.usage);
    }

    validateRegistration(r: RawInputRegistration): number {
        if (r.flags & ~0x3731) return 87;
        if (r.flags & RIDEV_REMOVE) {
            if (r.flags !== RIDEV_REMOVE || r.hwnd !== 0) return 87;
        }
        if ((r.flags & 0x1100) && !r.hwnd) return 87;
        if (r.usagePage !== 1 || (r.usage !== 2 && r.usage !== 6)) return 50;
        const noLegacy = (r.flags & RIDEV_NOLEGACY) === RIDEV_NOLEGACY;
        if (r.usage === 2 && (r.flags & 0x0200) && !noLegacy) return 87;
        if ((r.flags & 0x0400) && (r.usage !== 6 || !noLegacy)) return 87;
        if (r.flags & 0x3400) return 50;
        if (r.usage === 6 && (r.flags & 0x0200)) return 50;
        if ((r.flags & RIDEV_NOLEGACY) && !noLegacy) return 50;
        if (r.hwnd && !this.windows.getWindow(r.hwnd)) return 1400;
        return 0;
    }

    register(records: readonly RawInputRegistration[]): number {
        for (const r of records) {
            const error = this.validateRegistration(r);
            if (error) return error;
        }
        for (const r of records) {
            if (r.flags & RIDEV_REMOVE) this.registrations.delete(r.usage);
            else this.registrations.set(r.usage, { ...r });
        }
        return 0;
    }

    suppressesLegacy(usage: number): boolean {
        const r = this.registrations.get(usage);
        return !!r && (r.flags & RIDEV_NOLEGACY) === RIDEV_NOLEGACY;
    }

    suppressesMouseActivation(): boolean {
        return !!((this.registrations.get(2)?.flags ?? 0) & 0x0200);
    }

    private target(usage: number): number {
        const r = this.registrations.get(usage);
        if (!r) return 0;
        const foreground = this.windows.getForegroundHwnd();
        if (!this.windows.getWindow(foreground) && !(r.flags & RIDEV_INPUTSINK)) return 0;
        // All WindowManager windows belong to the one guest process. A different
        // window/thread in that process is still foreground input for the app.
        // Do not use getKeyboardTargetWindow: its fallback can activate a window.
        const hwnd = r.hwnd || this.windows.getFocusHwnd() || foreground;
        if (!this.windows.getWindow(hwnd)) {
            if (r.hwnd) this.removeWindow(hwnd);
            return 0;
        }
        return hwnd;
    }

    private allocate(hwnd: number, type: number, size: number, inputCode: number): number {
        if (!this.freeCount || this.nextHandle >= 0xffffffff) {
            this.droppedPackets++;
            return 0;
        }
        const slot = this.free[--this.freeCount];
        const handle = this.nextHandle++;
        const base = slot * PACKET_STRIDE;
        this.bytes.fill(0, base, base + PACKET_STRIDE);
        this.view.setUint32(base, type, true);
        this.view.setUint32(base + 4, size, true);
        this.view.setUint32(base + 8, type === 0 ? RAW_MOUSE_HANDLE : RAW_KEYBOARD_HANDLE, true);
        this.view.setUint32(base + 12, inputCode, true);
        this.owners[slot] = hwnd;
        this.threads[slot] = this.windows.getWindow(hwnd)?.creatorThreadId ?? 0;
        this.lengths[slot] = size;
        this.slots.set(handle, slot);
        return handle;
    }

    feedMouse(x: number, y: number, buttons: number, wheel: number, screenX: number, screenY: number): void {
        const dx = (x - this.mouseX) | 0;
        const dy = (y - this.mouseY) | 0;
        const changed = (buttons ^ this.buttons) & 31;
        this.seedMouse(x, y, buttons);
        if (!dx && !dy && !changed && !wheel) return;
        const hwnd = this.target(2);
        if (!hwnd) return;
        let flags = wheel ? 0x0400 : 0;
        for (let bit = 0; bit < 5; bit++) {
            if (changed & (1 << bit)) flags |= 1 << (bit * 2 + ((buttons & (1 << bit)) ? 0 : 1));
        }
        const inputCode = this.windows.getWindow(this.windows.getForegroundHwnd()) ? RIM_INPUT : RIM_INPUTSINK;
        const handle = this.allocate(hwnd, 0, 40, inputCode);
        if (!handle) return;
        const base = this.slots.get(handle)! * PACKET_STRIDE;
        this.view.setUint16(base + 20, flags, true);
        this.view.setUint16(base + 22, wheel & 0xffff, true);
        this.view.setInt32(base + 28, dx, true);
        this.view.setInt32(base + 32, dy, true);
        this.windows.postMessage(hwnd, WM_INPUT, inputCode, handle, screenX, screenY);
    }

    feedKeyboard(vk: number, scan: number, flags: number, message: number): void {
        const hwnd = this.target(6);
        if (!hwnd) return;
        const inputCode = this.windows.getWindow(this.windows.getForegroundHwnd()) ? RIM_INPUT : RIM_INPUTSINK;
        const handle = this.allocate(hwnd, 1, 32, inputCode);
        if (!handle) return;
        const base = this.slots.get(handle)! * PACKET_STRIDE;
        this.view.setUint16(base + 16, scan, true);
        this.view.setUint16(base + 18, flags, true);
        this.view.setUint16(base + 22, vk, true);
        this.view.setUint32(base + 24, message, true);
        this.windows.postMessage(hwnd, WM_INPUT, inputCode, handle);
    }

    getPacket(handle: number, threadId: number): Uint8Array | null {
        const slot = this.slots.get(handle >>> 0);
        if (slot === undefined || (threadId && this.threads[slot] && this.threads[slot] !== threadId)) return null;
        return this.bytes.subarray(slot * PACKET_STRIDE, slot * PACKET_STRIDE + this.lengths[slot]);
    }

    release(handle: number, hwnd?: number, threadId?: number): void {
        const slot = this.slots.get(handle >>> 0);
        if (slot === undefined || (hwnd !== undefined && this.owners[slot] !== (hwnd >>> 0))) return;
        if (threadId && this.threads[slot] && this.threads[slot] !== threadId) return;
        this.slots.delete(handle >>> 0);
        this.free[this.freeCount++] = slot;
    }

    releaseBackground(handle: number, hwnd: number, threadId: number): void {
        const slot = this.slots.get(handle >>> 0);
        if (slot === undefined || this.view.getUint32(slot * PACKET_STRIDE + 12, true) !== RIM_INPUTSINK) return;
        this.release(handle, hwnd, threadId);
    }

    removeWindow(hwnd: number): void {
        for (const [usage, r] of this.registrations) if (r.hwnd === hwnd) this.registrations.delete(usage);
        for (const [handle, slot] of this.slots) if (this.owners[slot] === hwnd) this.release(handle);
    }
}
