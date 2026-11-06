import { System } from '../../core/system';
import { findResourceInPE } from '../kernel32/resource';

const RT_ACCELERATOR = 9;
const FVIRTKEY = 0x01;
const FSHIFT = 0x04;
const FCONTROL = 0x08;
const FALT = 0x10;
const LAST_ENTRY = 0x80;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSCHAR = 0x0106;
const WM_COMMAND = 0x0111;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;
const ERROR_INVALID_HANDLE = 6;

export interface AccelEntry {
    flags: number;
    key: number;
    cmd: number;
}

// @transient(accelerator tables; a restored session reloads them from the module resources)
const tables = new Map<number, AccelEntry[]>();
// @transient(accelerator handle counter)
let nextHandle = 0x1acc0001;

export function resetAcceleratorTables(): void {
    tables.clear();
    nextHandle = 0x1acc0001;
}

export function registerAcceleratorTable(entries: AccelEntry[]): number {
    const handle = nextHandle++;
    tables.set(handle, entries.map((e) => ({ ...e })));
    return handle;
}

export function acceleratorTable(handle: number): AccelEntry[] | undefined {
    return tables.get(handle >>> 0);
}

export function destroyAcceleratorTable(handle: number): boolean {
    return tables.delete(handle >>> 0);
}

export function parseResourceAccelerators(view: DataView, at: number, size: number): AccelEntry[] {
    const entries: AccelEntry[] = [];
    for (let off = 0; off + 8 <= size; off += 8) {
        const flags = view.getUint16(at + off, true);
        entries.push({ flags: flags & 0x7f, key: view.getUint16(at + off + 2, true), cmd: view.getUint16(at + off + 4, true) });
        if (flags & LAST_ENTRY) break;
    }
    return entries;
}

export function loadAccelerators(mem: Uint8Array, hInstance: number, name: number | string): number {
    const scheduler = System.getInstance().scheduler;
    const entry = findResourceInPE(mem, hInstance, RT_ACCELERATOR, name);
    if (!entry || entry.size < 8) {
        scheduler.setLastError(ERROR_RESOURCE_NAME_NOT_FOUND);
        return 0;
    }
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const entries = parseResourceAccelerators(view, entry.moduleBase + entry.dataRVA, entry.size);
    if (!entries.length) {
        scheduler.setLastError(ERROR_RESOURCE_NAME_NOT_FOUND);
        return 0;
    }
    return registerAcceleratorTable(entries);
}

export function copyAccelerators(mem: Uint8Array, handle: number, dst: number, count: number): number {
    const entries = tables.get(handle >>> 0);
    if (!entries) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_HANDLE);
        return 0;
    }
    if (!dst) return entries.length;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const n = Math.min(entries.length, Math.max(0, count | 0));
    for (let i = 0; i < n; i++) {
        view.setUint8(dst + i * 6, entries[i].flags);
        view.setUint16(dst + i * 6 + 2, entries[i].key, true);
        view.setUint16(dst + i * 6 + 4, entries[i].cmd, true);
    }
    return n;
}

export function createAccelerators(mem: Uint8Array, src: number, count: number): number {
    if (!src || count <= 0) {
        System.getInstance().scheduler.setLastError(87);
        return 0;
    }
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const entries: AccelEntry[] = [];
    for (let i = 0; i < count; i++) {
        entries.push({
            flags: view.getUint8(src + i * 6) & 0x7f,
            key: view.getUint16(src + i * 6 + 2, true),
            cmd: view.getUint16(src + i * 6 + 4, true),
        });
    }
    return registerAcceleratorTable(entries);
}

export interface AcceleratorKeyState {
    shift: boolean;
    control: boolean;
    alt: boolean;
}

export function matchAccelerator(
    entries: readonly AccelEntry[],
    message: number,
    wParam: number,
    keys: AcceleratorKeyState,
): AccelEntry | null {
    const virt = message === WM_KEYDOWN || message === WM_SYSKEYDOWN;
    const char = message === WM_CHAR || message === WM_SYSCHAR;
    if (!virt && !char) return null;
    for (const e of entries) {
        if (virt) {
            if (!(e.flags & FVIRTKEY) || e.key !== (wParam & 0xffff)) continue;
            if (!!(e.flags & FSHIFT) !== keys.shift) continue;
            if (!!(e.flags & FCONTROL) !== keys.control) continue;
            if (!!(e.flags & FALT) !== keys.alt) continue;
            return e;
        }
        if (e.flags & FVIRTKEY || e.key !== (wParam & 0xffff)) continue;
        if (!!(e.flags & FALT) !== (message === WM_SYSCHAR)) continue;
        return e;
    }
    return null;
}

export function translateAccelerator(mem: Uint8Array, hWnd: number, hAccel: number, lpMsg: number): number {
    const entries = tables.get(hAccel >>> 0);
    if (!entries || !lpMsg || !hWnd) return 0;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const message = view.getUint32(lpMsg + 4, true);
    const wParam = view.getUint32(lpMsg + 8, true);
    const input = System.getInstance().inputManager;
    const down = (vk: number) => (input.getKeyState(vk) & 0x8000) !== 0;
    const hit = matchAccelerator(entries, message, wParam, {
        shift: down(VK_SHIFT), control: down(VK_CONTROL), alt: down(VK_MENU),
    });
    if (!hit) return 0;
    System.getInstance().windowManager.postMessage(hWnd >>> 0, WM_COMMAND, (1 << 16) | hit.cmd, 0);
    System.getInstance().scheduler.wakeMessageWaiters();
    return 1;
}
