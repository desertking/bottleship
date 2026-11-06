import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createMessageExports } from '../../src/worker/modules/user32/message';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';

const WM_ACTIVATE = 0x0006, WA_INACTIVE = 0, WA_ACTIVE = 1, WA_CLICKACTIVE = 2;
const OUT = 0x400, HWND = 0x10001, OTHER = 0x10009;
const mem = new Uint8Array(0x2000);
const dv = new DataView(mem.buffer);
const messageExports = createMessageExports();
const system = System.getInstance();
let savedProcess: typeof system.process;
let savedWindow: WindowInfo | undefined;
let active = 0;
let calls: number[][] = [];
let restore: () => void;

beforeEach(() => {
    savedProcess = system.process;
    savedWindow = windows.get(HWND);
    Mem.bind(() => mem);
    calls = [];
    windows.set(HWND, { handle: HWND, title: '', style: 0, x: 0, y: 0, width: 540, height: 580, children: [], visible: false, wndProc: 0x401000 } as never);
    system.process = {
        addressSpace: { validateRange: () => true },
        dispatcher: { callbackManager: {
            getStubPoolRange: () => ({ base: 0x10000000, end: 0x10000100 }),
            saveSuspendedThunkContext: () => 1,
            invokeCallback: (_proc: number, args: number[]) => { calls.push(args); return { callbackId: 42 }; },
        } },
    } as never;
    const spy = spyOn(system.windowManager, 'getActiveHwnd').mockImplementation(() => active);
    restore = () => spy.mockRestore();
});

afterEach(() => {
    restore();
    system.process = savedProcess;
    if (savedWindow) windows.set(HWND, savedWindow);
    else windows.delete(HWND);
    delete (globalThis as { __noStaleActivateDrop?: boolean }).__noStaleActivateDrop;
});

function dispatch(wParam: number): unknown {
    [HWND, WM_ACTIVATE, wParam, OTHER, 0, 0, 0].forEach((v, i) => dv.setUint32(OUT + i * 4, v, true));
    return messageExports.DispatchMessageW({ esp: 0x1800 } as never, mem, [OUT]);
}

test('a queued activation that a later switch already superseded never reaches the WndProc', () => {
    active = OTHER;
    expect(dispatch(WA_ACTIVE)).toEqual({ value: 0, stackCleanup: 4 });
    expect(dispatch(WA_CLICKACTIVE | (1 << 16))).toEqual({ value: 0, stackCleanup: 4 });
    expect(calls).toEqual([]);
});

test('negative: the activation of the window that is active is delivered', () => {
    active = HWND;
    dispatch(WA_ACTIVE);
    expect(calls).toEqual([[HWND, WM_ACTIVATE, WA_ACTIVE, OTHER]]);
});

test('negative: a deactivation is always delivered', () => {
    active = OTHER;
    dispatch(WA_INACTIVE);
    expect(calls).toEqual([[HWND, WM_ACTIVATE, WA_INACTIVE, OTHER]]);
});

test('negative: the kill switch delivers the stale activation', () => {
    (globalThis as { __noStaleActivateDrop?: boolean }).__noStaleActivateDrop = true;
    active = OTHER;
    dispatch(WA_ACTIVE);
    expect(calls).toEqual([[HWND, WM_ACTIVATE, WA_ACTIVE, OTHER]]);
});
