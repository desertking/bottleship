import { describe, expect, it } from 'bun:test';
import { round24 } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import {
    BANK_FLOATS, PLAIN_HI, PLAIN_LO, multiplyBank, plainBank, plainFloats, sameBank,
} from '../../src/worker/core/hle-lib/libs/dxa-transforms/kernel';
import { __test } from '../../src/worker/core/hle-lib/libs/dxa-transforms/descriptor';

const floats = (hex: string): Float32Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new Float32Array(bytes.buffer);
};

/** Bank contents before and after the guest function, recorded from the original code under an x86 emulator. */
const RECORDED = [
    { m: 'd8f51f2a0000804e4619bac1000080ce884ed3bcef82563b2fe25e3b000080ce00000080231a12c40000804e335658a74f1862b8000080bfcfce59c300000080',
      before: '000080260000008069f91bc1b96e15bbfb4873bba42100c182dec9bf00000000cc4047af000080bf000080ce37b83e3c94cd403b000000806b4c7240eb3c08c252e9803f1fac78bc000080a65d7795bfe9d1423d000000800000008069b002c20000804e0000000000000080e14444438118b9bd80707f3e00000080000080bf0000008000000000000080bf000080bfce75d0bf000080ce00000000388e1036874589c3000000800000804e4f5284bb9f8d843d7cfe6942b5ce2a3c000080a642133ecc0000804e000000000000804e00c11b4474720a4200000000015766433ecc08be000000802c05403a000000805ac6143c83766bba000080cede7e9cc4789bdac0dd58da3e00000080d0bae63f7dab7bbb4bdc893f000080a6bcb595c10000000030844cc100000080000080bf00008026f1948c3e952d67c0fc4142bd0000000000000000000080bf0000803fb8dd9d3f2640a63e49091db394fb5cc117f7c53ffb031a3b00000080af42c942b01f593f12e958c5e4553cc100000080000080a60000000000008026d6909445e4a697c0000000000000000000000080b7469a3b4c9503b40000803fe6f60fc0000080ce14df244346b9d2c33dd50bbc716e94bf000080a6000080ce8b836240',
      after: '4472154ab96e154a69f91bd06bb40445a42100d06af100bd5ddec9cebdc1af436f01b250c37076cb000080ddcfce5952eb3c0851eb3c08516b4c724f84264ec452e9803f1fac78bc000080a65d7795bfe9d1423d000000800000008069b002c20000804e0000000000000080e14444438118b9bd80707f3e00000080000080bf0000804e0000804e000080cecfce5943000080dd13a756ca231a12530000804e0111bad074c3f34a0000805dcfce59d27cfe69514e66423e2a492a4bb01373c200000000000080dd231a12d3d6ff7fce64ba43d2015766d2d1069ec6d8940ac2b7968bbc68fe613b2c0540499f5d23be3c679f53c27e9c53000080ddcfce59529924b0ced0bae6cef23979c39828dabe81539e50bcb595506c5b1dc449dc89bf30843cd00000804e8a70e94530844c4134dda44dfc41424c962d67cfd29e4444000080ce000080ce000080cecfce5943952d625094fb5c50700565c3d247a6be7b41c9d1af42c9d1fdcbafbfb27a1fbb12e958d45bbf36c1274e3cd00393bc45d69094d4d69094d405ff7f35cbce59aa95843dab275afa3d00000000bcef8539e5f60f4fe6f60f4f0000804ecfce59c344e12452939c0c4c49b9d2d280011248d5c89d5044bb62cf000080ddcfce5952' },
    { m: 'ad569c32a9b78d3acb44ec445a3180bc9379a1ba0000803f00000080a35e23c20000803fcaafb73c91e65242000080bfc06d9e3d000080bf756a4b3f0000803f',
      before: '000000800000803f496541c1f094fdc066827cbd000080cef69eb93a3b528d430000008000000080000080bf0000803f0000804e1b8b35ba86befe4154cc4d3b000000005856b24a33639f3e00008026830e82bcdd04843fc2c6bf301f9c023f000080bf40cea643bd26593a000000809af554befbae25be247aa13c00000080e9c03c3a476f4c3c95499db8000080ce5b4e843df4d035c47a15e94131376ac20000803f00000080ee45883e8a8f8f428ff70fc47ac1ddc4000080bf2e5281adbc2526bcd5ef78bed4ebe43c60b049bdb6916fc0fd6dbd3fdaad424808a505a7000080ce6a00b83e24214d413f9a33c5050f96be959ef2b900000000f3801f437bcca0ba270771bf90509342000000000f432dbd3bb630ba39ad0ec01d11d83c000080bf0000000064cdf537c998d8bc3086a9c00000804e000080ce1cd391b1a5262d3d000000005f1d493e0000000000000000000000804e0671aab4a573c400000000b5470bbd000080ce92eac6be120a2b40000080ce2a681ebaa96d29bf0000803f5ec3f1bb9aa2da3968ce4ebbb506a9bb000000804aec0b435a594942d0c02c3d5f6c4ebf7e905e400000000063a6743d6a8535430000803f506de841000000800000803f000000000000804e',
      after: '187db2c69353a243ab561dc41a3b94c1b7b78dc95a0080ce57b0b7cb0200804e4b45ecc4a35e23c291e656c22c56523ea32f6b479479a1c90d00804ec36d9e4c000000005856b24a33639f3e00008026830e82bcdd04843fc2c6bf301f9c023f000080bf40cea643bd26593a000000809af554befbae25be247aa13c000000805a31804ba35e23510000804e000080ce911e5747fa06d044814fc5447bf72c4465fafa43f33a37c508fd62c26e2390422c82ecc4c6aaddc4d11727c48516d84471475342264ee23f3ae6c03fde725c3e96acb34d1905be3fef61204b60b01a488884bd4649cdaf49c8ff7fce266f9ecc75be1fc02394cbc5fbcb1fc3437b1f43dbf507480e0771bf2db972454ee06d4209ae83c527f789bf5d38ebc241b2dfbf3a8d643db8618a3ffad578bfbd87d4bdc244ecd30000804e9bcf52d13ab5e5ce1f9db943116f5ab8615c26412d27233ea5037441947c1b47b4a57344b4a573c4cb44ecd37f567d4191e652d1756a4bceb2b78dc9000080cec9afb7cb0000804e5dcb493fa451f63d7432833f3dc1a73d55238148537e00c5f6f8e445cb8421430169cd45c76f4ebf26613743ada96440873cec44b3457bc4e669de4127ab17c35a3180cba35e23d1000080ce0000804e' },
];

const BLOCKS: Array<[number, number]> = [[0, 4], [8, 4], [12, 4], [16, 4], [20, 4], [24, 4], [28, 1]];

/** The guest arithmetic, one x87 operation per step, precision control single. */
function guest(bank: Float32Array, m: Float32Array): Float32Array {
    const out = new Float32Array(bank);
    for (const [reg, vectors] of BLOCKS) {
        for (let r = 0; r < vectors; r++) {
            for (let c = 0; c < 4; c++) {
                let acc = round24(m[c * 4]! * bank[(reg + r) * 4]!);
                for (let k = 1; k < 4; k++) acc = round24(acc + round24(m[c * 4 + k]! * bank[(reg + r) * 4 + k]!));
                out[(reg + r) * 4 + c] = acc;
            }
        }
    }
    return out;
}

function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('dxa-transforms kernel', () => {
    it('reproduces the recorded guest results bit for bit', () => {
        for (const rec of RECORDED) {
            const out = new Float32Array(BANK_FLOATS);
            multiplyBank(floats(rec.before), floats(rec.m), out);
            expect(Array.from(new Uint32Array(out.buffer))).toEqual(Array.from(new Uint32Array(floats(rec.after).buffer)));
        }
    });

    it('matches the single-precision x87 model across the admitted value range', () => {
        const rnd = lcg(20261110);
        const value = (): number => {
            const k = Math.floor(rnd() * 6);
            if (k === 0) return rnd() < 0.5 ? 0 : -0;
            if (k === 1) return (rnd() < 0.5 ? -1 : 1) * (rnd() < 0.5 ? PLAIN_LO : PLAIN_HI);
            return Math.fround((rnd() * 2 - 1) * 2 ** Math.floor(rnd() * 79 - 50));
        };
        for (let n = 0; n < 2000; n++) {
            const bank = new Float32Array(BANK_FLOATS), m = new Float32Array(16);
            for (let i = 0; i < BANK_FLOATS; i++) bank[i] = value();
            for (let i = 0; i < 16; i++) m[i] = value();
            if (!plainBank(bank) || !plainFloats(m, 0, 16)) continue;
            const out = new Float32Array(BANK_FLOATS);
            multiplyBank(bank, m, out);
            expect(sameBank(out, guest(bank, m))).toBe(true);
            for (let i = 16; i < 32; i++) expect(Object.is(out[i], bank[i])).toBe(true);
        }
    });

    it('turns down values outside the plain range', () => {
        const v = new Float32Array([1, 0, -0, 2 ** 30, -(2 ** -50)]);
        expect(plainFloats(v, 0, v.length)).toBe(true);
        for (const bad of [NaN, Infinity, -Infinity, 2 ** 31, 2 ** -51, 1e-45]) {
            expect(plainFloats(new Float32Array([1, bad]), 0, 2)).toBe(false);
        }
        const bank = new Float32Array(BANK_FLOATS);
        bank[20] = NaN;
        expect(plainBank(bank)).toBe(true);
        bank[112] = Infinity;
        expect(plainBank(bank)).toBe(false);
    });

    it('carries a consistent signature per function', () => {
        for (const shape of Object.values(__test.SHAPES)) {
            expect(shape.mask.length).toBe(shape.prefix.length);
            expect(shape.sha.length).toBe(64);
            for (const off of [...shape.device, ...shape.renderer, ...shape.other]) expect(off + 4).toBeLessThanOrEqual(shape.bodyLen);
            expect(__test.PROLOGUE_LEN).toBeLessThan(shape.prefix.length);
        }
    });
});
