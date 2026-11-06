import { beforeEach, describe, expect, test } from "bun:test";
import "../../src/worker/modules/user32/index";
import { createInputExports } from "../../src/worker/modules/user32/input";
import { acceleratorTable, matchAccelerator, resetAcceleratorTables } from "../../src/worker/modules/user32/accelerators";

const BASE = 0x10000;

function imageWithAcceleratorTable(): Uint8Array {
    const mem = new Uint8Array(0x20000);
    const v = new DataView(mem.buffer);
    v.setUint16(BASE, 0x5a4d, true);
    v.setUint32(BASE + 0x3c, 0x40, true);
    const pe = BASE + 0x40;
    v.setUint32(pe, 0x4550, true);
    const opt = pe + 24;
    v.setUint16(opt, 0x10b, true);
    const rsrcRva = 0x1000;
    v.setUint32(opt + 112, rsrcRva, true);
    v.setUint32(opt + 116, 0x200, true);
    const root = BASE + rsrcRva;
    const dir = (at: number, id: number, child: number, sub: boolean) => {
        v.setUint16(at + 14, 1, true);
        v.setUint32(at + 16, id, true);
        v.setUint32(at + 20, (sub ? 0x80000000 : 0) | child, true);
    };
    dir(root, 9, 0x18, true);
    dir(root + 0x18, 1, 0x30, true);
    dir(root + 0x30, 0x409, 0x48, false);
    const dataRva = rsrcRva + 0x60;
    v.setUint32(root + 0x48, dataRva, true);
    v.setUint32(root + 0x48 + 4, 16, true);
    const tbl = BASE + dataRva;
    v.setUint16(tbl, 0x01, true);
    v.setUint16(tbl + 2, 0x70, true);
    v.setUint16(tbl + 4, 40001, true);
    v.setUint16(tbl + 8, 0x01 | 0x08 | 0x80, true);
    v.setUint16(tbl + 10, 0x50, true);
    v.setUint16(tbl + 12, 40002, true);
    return mem;
}

const call = (name: string, mem: Uint8Array, args: number[]) =>
    (createInputExports()[name] as (c: unknown, m: Uint8Array, a: number[]) => number)({ esp: 0 }, mem, args);

beforeEach(() => resetAcceleratorTables());

describe("accelerator tables", () => {
    test("LoadAcceleratorsA finds the RT_ACCELERATOR resource and returns a usable table", () => {
        const mem = imageWithAcceleratorTable();
        const handle = call("LoadAcceleratorsA", mem, [BASE, 1]) >>> 0;
        expect(handle).not.toBe(0);
        expect(acceleratorTable(handle)).toEqual([
            { flags: 0x01, key: 0x70, cmd: 40001 },
            { flags: 0x09, key: 0x50, cmd: 40002 },
        ]);
    });

    test("negative control: a module without that table still answers NULL", () => {
        const mem = imageWithAcceleratorTable();
        expect(call("LoadAcceleratorsA", mem, [BASE, 2])).toBe(0);
    });

    test("a virtual-key entry matches only with its own modifiers", () => {
        const table = [{ flags: 0x09, key: 0x50, cmd: 7 }];
        expect(matchAccelerator(table, 0x100, 0x50, { shift: false, control: true, alt: false })?.cmd).toBe(7);
        expect(matchAccelerator(table, 0x100, 0x50, { shift: false, control: false, alt: false })).toBeNull();
        expect(matchAccelerator(table, 0x101, 0x50, { shift: false, control: true, alt: false })).toBeNull();
    });
});
