import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDialogExports } from '../../src/worker/modules/user32/dialog';
import { createWindowExports } from '../../src/worker/modules/user32/window';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';

const WM_PAINT = 0x000f;
const DLG = 0x10048;
const SUBCLASS_WNDPROC = 0x00592340;
const DLGPROC = 0x005a0840;
const ESP = 0x800;

let invocations: Array<{ proc: number; args: number[] }>;
let mem: Uint8Array;
let dialogApi: Record<string, any>;

function dialog(wndProc: number): WindowInfo {
    return {
        handle: DLG, title: '', style: 0x90000040, x: 243, y: 159, width: 315, height: 229,
        children: [], visible: true, wndProc, nativeClassName: '#32770', extraBytes: [0, DLGPROC, 0],
    } as unknown as WindowInfo;
}

describe('DefDlgProc hands WM_PAINT to the DlgProc of a subclassed dialog', () => {
    beforeEach(() => {
        invocations = [];
        mem = new Uint8Array(0x4000);
        windows.clear();
        (System.getInstance() as unknown as { process: unknown }).process = {
            getModule: () => undefined,
            v86: { mem8: mem },
            getCurrentMemory: () => mem,
            dispatcher: {
                callbackManager: {
                    getStubPoolRange: () => ({ base: 0x21000000, end: 0x21010000 }),
                    saveSuspendedThunkContext: () => 55,
                    invokeCallback: (proc: number, args: number[]) => {
                        invocations.push({ proc, args });
                        return { callbackId: 0x1000 };
                    },
                },
            },
        };
        Mem.bind(() => mem);
        createWindowExports();
        dialogApi = createDialogExports();
    });

    afterEach(() => {
        (System.getInstance() as unknown as { process: unknown }).process = undefined;
        windows.clear();
    });

    test('a dialog whose window procedure was replaced paints through its DlgProc', () => {
        windows.set(DLG, dialog(SUBCLASS_WNDPROC));
        const r = dialogApi['DefDlgProcA']({ esp: ESP } as never, mem, [DLG, WM_PAINT, 0, 0]);
        expect(invocations).toEqual([{ proc: DLGPROC, args: [DLG, WM_PAINT, 0, 0] }]);
        expect((r as { suspendedForCallback?: boolean }).suspendedForCallback).toBe(true);
    });

    test('negative: a dialog still on its own DlgProc is not called a second time', () => {
        windows.set(DLG, dialog(DLGPROC));
        try {
            dialogApi['DefDlgProcA']({ esp: ESP } as never, mem, [DLG, WM_PAINT, 0, 0]);
        } catch { expect(windows.has(DLG)).toBe(true); }
        expect(invocations.filter((i) => i.proc === DLGPROC)).toEqual([]);
    });
});
