import { afterEach, describe, expect, it } from 'bun:test';
import { deformViews } from '../../src/worker/core/hle-lib/libs/granny-deform/kernel';
import { aabbKernel, aabbVariant, setAabbVariant } from '../../src/worker/core/hle-lib/libs/granny-deform/aabb-kernel';
import { __test, grannyDeformDescriptor } from '../../src/worker/core/hle-lib/libs/granny-deform/descriptor';
import { validatePrologueBytes } from '../../src/worker/core/hle-lib/lib-patcher';

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map(b => parseInt(b, 16)));
const T = 0x100, M = 0x140, MIN = 0x200, MAX = 0x240;

const RECORDED: [string, string, number][] = [
    ['4c9285c1a1600bc29f54344296c8d341db99f4419bed20c28a43e3418035e1c1e296f0c11ed15f4098ba2f414dad17c2ffe803412b6c974114daae41d5c01f422d9159c1254ba7c1',
     '0fb188c40eb277c4af0d62c40eca194593f60345fb329444', 0xc4620daf],
    ['d3a7df3aa5f08437a96c17c1cbef35c211c6d4cae3aa08c77d97f63fa9d48540e37a39b7c5451b4a925b283c3517a13b66770abff26015bac4aa5ac64cb93535a9ffd73acd9701c4',
     'dc478a4b75f284bf81faa7c9dc79e94d9381253e85a424c1', 0xc9a7fa81],
    ['0000803f460a00800000803f00000000000000004528ef960000803f00000080000000006cbcbfa800000080700b0080000000806eba00800000008000000080000000000000803f',
     '0000803f460a00800000803f0000803f460a00800000803f', 0x3f800000],
    ['07221e3effff7fff0000803f762e803e975e56bf031354d8ffff7fff0000803fe6d3683f000000000000000000000000000000000000803f00000000000000000000803fce05c23f',
     '37bba0d8ffff7fff0000803f15d62ebfffff7fff0000803f', 0x3f800000],
    ['000080bf7c89a7bf000000008febb83f0000803f9550e6bf7eecc1bf331a2abf163514a08a2a5e3e0000803f002c16a0806aad3e000080bf000080bfeb5e553f5def223fbf9da43f',
     '84c874c07ca63fc01a306dbf69f42840222b94bf4e3a513f', 0xbf6d301a],
    ['31722e4136ce19c27a5d96c167e302c27f011bc20d62d5c167362ac22df6eac161ac3041977bd0c12e4ddec106851ec2faf7ff4156853bc235bc26c21f723d42e2df2ec22921eac1',
     '69fa69448fc299c45a338c44b38dec44af21adc3e35f0345', 0x448c335a],
    ['f4a0ca4608efa3bedb5705c0bb928842ef7d89369a868c39f79480bf7b5f2945bef0d435ba3a5d418b3a4e3920288f3e7d7700c5cbdfd3c9993f073a1fdf103cda908ac89397e936',
     'c37fdfc7c32d8ccf24b8e0c6d69fca467c5a37cea51867c2', 0xc6e0b824],
    ['000000000000803f00000080000000001d4ae6a700000080e20303280000803f93d054a9a07f4ba30000000000000000ffff7f7fffff7f7fffff7f7fffff7fffffff7fffffff7fff',
     '1c4ae6e7ffff7fff9f7f4be31c4ae667ffff7f7f9f7f4b63', 0xe34b7f9f],
    ['730d0b6bb82444deaaad46dffbbd21bf722a4df6ffff7fff0000803f0000803f17f759bfffff7fffffff7f7fffff7fffffff7fff0000803f5a275cbf382018728e0c7b614046ea3e',
     '000080ffffff7fff000080ff0000807f382018720000807f', 0xff800000],
    ['0000803f1c110dbf0000803f000000007451503f000080bf000080bf0000000000000000e422943f000080bf00000000504fefbf2fabce3e000000000000803f0000803f00000000',
     '360baa3f8e88c6bf787a0ac0ba28e83fc2c6a83f1878e03f', 0xc00a7a78],
    ['0bc1f641f74430c1e41fe241c68f0ec13a6825c2a32545c27a052cc2a57fbcc0a9b4b9bf153dfd41522839c2ce9478c1ffff7f7fffff7f7fffff7f7fffff7fffffff7fffffff7fff',
     '000080ff000080ff000080ff0000807f0000807f0000807f', 0xff800000],
    ['1e7598c4ce48babd3d953f3f05733645172bb13d58f0d039e7bf91bbb3d89c492f867b422eb0c9c33ea4eac1b90c6e3dfb6b033e6200b6cbd1eaffc4fbf9d93f2da68448945c00ba',
     '3b04fcc99704dfd54a30f3ca8ae9d446198ba2521dd1264e', 0xcaf3304a],
    ['0000803f0000803f000000000000803f91c3b699000000800000000081310080000000000000803fbe3406800000803f0000803f1e08000032e6469c0000803fd637370137050080',
     '000000400000803f0000803f000000400000803f0000803f', 0x3f800000],
    ['000000000000803f0000803fca6f1ae31f5229ee0000803f000000000000803f00000000ffff7fff00000000ffff7f7f8bc1a9bf0000803f203abcbe5eb3283e000000000000803f',
     '1f5229ee0000803fe74908ff1dd14c63000000400000807f', 0xff0849e7],
    ['0000803f0000803f000080bf000080bf6dfd422000000000000000000000803f000080bfdf4c9c3feca2d7bf000080bf4c6986bfea41fabf0eec99bf000080bf000080bf0000803f',
     '00000040ea41fabf217eccbfa63403400eec993f379c1140', 0xbfcc7e21],
];

function run(input: Uint8Array, variant: number): { box: string; eax: number } {
    const mem = new Uint8Array(0x400);
    mem.set(input.subarray(0, 12), T);
    mem.set(input.subarray(12, 48), M);
    mem.set(input.subarray(48, 60), MIN);
    mem.set(input.subarray(60, 72), MAX);
    const v = deformViews(mem)!;
    setAabbVariant(variant);
    const eax = aabbKernel(v, v, [T, M, MIN, MAX]) >>> 0;
    const out = [...mem.subarray(MIN, MIN + 12), ...mem.subarray(MAX, MAX + 12)];
    return { box: out.map(b => b.toString(16).padStart(2, '0')).join(''), eax };
}

afterEach(() => setAabbVariant(0));

describe('granny box transform, 2.7 operand order', () => {
    it('reproduces calls recorded from the original code', () => {
        for (const [input, box, eax] of RECORDED) {
            const got = run(hex(input), 1);
            expect(got.box).toBe(box);
            expect(got.eax).toBe(eax);
        }
    });

    it('differs from the 2.1 order on the recorded calls', () => {
        let differing = 0;
        for (const [input, box, eax] of RECORDED) {
            const got = run(hex(input), 0);
            if (got.box !== box || got.eax !== eax) differing++;
        }
        expect(differing).toBeGreaterThan(0);
    });

    it('is reset with the descriptor', () => {
        setAabbVariant(1);
        grannyDeformDescriptor.onReset?.();
        expect(aabbVariant()).toBe(0);
    });

    it('has a relocatable prologue', () => {
        expect(__test.AABB_B_PREFIX.length).toBe(__test.AABB_B_MASK.length);
        expect(validatePrologueBytes(__test.AABB_B_PREFIX.slice(0, __test.AABB_B_PROLOGUE_LEN))).toBeNull();
        expect(grannyDeformDescriptor.functions.granny_aabb_transform_b.prologueLen).toBe(__test.AABB_B_PROLOGUE_LEN);
    });
});

describe('granny SSE kernel frame', () => {
    const coreHead = Array.from(__test.SSE_PREFIX.subarray(0, 3));
    const loads = [0x8b, 0x75, 0x0c, 0x8b, 0x5d, 0x14];
    const head = (pushes: number[]): Uint8Array => {
        const h = [...coreHead, ...pushes, ...loads];
        while (h.length < __test.SSE_CORE_AT) h.push(0x90);
        return Uint8Array.from(h);
    };
    const tail = (pushes: number[]): Uint8Array => Uint8Array.from([...pushes.slice().reverse().map(p => p + 8), 0x5d, 0xc3, 0xcc, 0xcc]);
    const A = [0x56, 0x57, 0x53, 0x51, 0x56, 0x57];
    const B = [0x53, 0x56, 0x57, 0x53, 0x51, 0x56, 0x57];

    it('accepts the 2.1 and the 2.7 frame', () => {
        expect(Array.from(head(A))).toEqual(Array.from(__test.SSE_PREFIX.subarray(0, __test.SSE_CORE_AT)));
        expect(__test.sseFrameLength(head(A), tail(A))).toBe(__test.SSE_BODY_LEN);
        expect(__test.sseFrameLength(head(B), tail(B))).toBe(__test.SSE_BODY_LEN + 1);
        expect(validatePrologueBytes(head(B).slice(0, __test.PROLOGUE_LEN))).toBeNull();
    });

    it('rejects a frame whose pops do not mirror its pushes', () => {
        expect(__test.sseFrameLength(head(B), tail(A))).toBe(0);
        expect(__test.sseFrameLength(head(A), tail(B))).toBe(0);
        expect(__test.sseFrameLength(head([0x56]), tail([0x56]))).toBe(0);
        const broken = head(A);
        broken[10] = 0x8d;
        expect(__test.sseFrameLength(broken, tail(A))).toBe(0);
    });

    it('masks only the frame', () => {
        expect(__test.SSE_MASK.length).toBe(__test.SSE_PREFIX.length);
        expect(__test.SSE_MASK.indexOf('?')).toBe(3);
        expect(__test.SSE_MASK.lastIndexOf('?')).toBe(__test.SSE_CORE_AT - 1);
        for (const off of __test.SSE_SCALE_OPERANDS) expect(off + 4).toBeLessThanOrEqual(__test.SSE_CORE_END);
    });
});

describe('granny detection', () => {
    it('counts repeated pattern hits', () => {
        const bytes = new Uint8Array(64);
        const pattern = Uint8Array.from([0xaa, 0x00, 0xbb]);
        bytes.set([0xaa, 0x11, 0xbb], 5);
        expect(__test.scanAll(bytes, pattern, 'x?x')).toEqual([5]);
        bytes.set([0xaa, 0x22, 0xbb], 40);
        expect(__test.scanAll(bytes, pattern, 'x?x')).toEqual([5, 40]);
        expect(__test.scanAll(bytes, pattern, 'xxx')).toEqual([]);
    });

    it('walks the world-pose family through its call sites', () => {
        const parts = __test.WORLDPOSE_PARTS;
        for (let k = 1; k < parts.length; k++) {
            const [from, off] = parts[k].via!;
            expect(from).toBeLessThan(k);
            expect(parts[from].calls.some(([o, to]) => o === off && to === k)).toBe(true);
        }
        for (const part of parts) {
            for (const [off, to] of part.calls) {
                expect(off + 4).toBeLessThanOrEqual(part.len);
                expect(to).toBeLessThan(parts.length);
                expect(part.relocs.includes(off)).toBe(false);
            }
        }
        expect(__test.WORLDPOSE_MASK[0x22]).toBe('x');
        expect(__test.WORLDPOSE_MASK.slice(0x23, 0x27)).toBe('????');
        expect(__test.WORLDPOSE_PREFIX[0x22]).toBe(0xe8);
    });
});
