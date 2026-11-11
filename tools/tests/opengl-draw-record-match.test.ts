import { expect, test } from "bun:test";
import { createOpenGLContext, CMD_I32, CMD_F32, CI_MODE, CI_FLAGS } from "../../src/worker/modules/opengl32/context";
import { drawFlags, drawRecordMatches, writeDrawRecord } from "../../src/worker/modules/opengl32/immediate";

const INT_FIELDS = [
    "depthFunc", "blendSrc", "blendDst", "alphaFunc", "cullFace", "frontFace", "shadeModel", "fogMode",
    "polygonModeFront", "stencilFunc", "stencilRef", "stencilMask", "stencilFail", "stencilZFail", "stencilZPass",
    "stencilWriteMask", "scissorX", "scissorY", "scissorW", "scissorH", "viewportX", "viewportY", "viewportW", "viewportH",
] as const;
const FLOAT_FIELDS = ["alphaRef", "fogDensity", "fogStart", "fogEnd", "depthRangeNear", "depthRangeFar"] as const;
const CAPS = [0x0B71, 0x0BE2, 0x0BC0, 0x0B44, 0x0B60, 0x0B90, 0x0C11];
const FLOATS = [0, -0, 0.5, 1, 1 + 1e-9, 0.1, NaN, 3];
const INTS = [0, 1, 0x0201, 0x0203, -1, 0xFFFFFFFF, 2.5, 0x2100];

function rng(seed: number) {
    return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
}

function fullEqual(I: Int32Array, F: Float32Array, a: number, b: number): boolean {
    if (I[a * CMD_I32 + CI_MODE] !== I[b * CMD_I32 + CI_MODE]) return false;
    for (let k = CI_FLAGS; k < CMD_I32; k++) if (I[a * CMD_I32 + k] !== I[b * CMD_I32 + k]) return false;
    for (let k = 0; k < CMD_F32; k++) if (F[a * CMD_F32 + k] !== F[b * CMD_F32 + k]) return false;
    return true;
}

test("drawRecordMatches agrees with writing the record and comparing every slot", () => {
    const ctx = createOpenGLContext({ getCurrentMemory: () => new Uint8Array(16) } as any) as any;
    const next = rng(99);
    const pick = <T,>(xs: readonly T[]): T => xs[(next() * xs.length) | 0]!;
    const I = new Int32Array(2 * CMD_I32), F = new Float32Array(2 * CMD_F32);
    let matches = 0;
    for (let n = 0; n < 20000; n++) {
        const mutate = () => {
            const k = next();
            if (k < 0.3) ctx[pick(INT_FIELDS)] = pick(INTS);
            else if (k < 0.45) ctx[pick(FLOAT_FIELDS)] = pick(FLOATS);
            else if (k < 0.55) ctx.fogColor[(next() * 4) | 0] = pick(FLOATS);
            else if (k < 0.7) { const c = pick(CAPS); if (next() < 0.5) ctx.enableFlags.add(c); else ctx.enableFlags.delete(c); }
            else if (k < 0.75) ctx.depthMask = next() < 0.5;
            else if (k < 0.8) ctx.colorMaskG = next() < 0.5;
            else {
                const u = ctx.textureUnits[(next() * 2) | 0];
                const j = next();
                if (j < 0.3) u.enabled2d = !u.enabled2d;
                else if (j < 0.5) u.boundTexture = pick([0, 3, 7]);
                else if (j < 0.7) u.texEnvMode = pick([0x2100, 0x8570, 0x1E01]);
                else if (j < 0.85) u.envColor[(next() * 4) | 0] = pick(FLOATS);
                else u.combineRgb = pick([0x2100, 0x1E01, 0x84E7]);
            }
        };
        const mode = pick([4, 7, 1]);
        writeDrawRecord(ctx, I, F, 0, 0, mode, drawFlags(ctx));
        const steps = (next() * 3) | 0;
        for (let s = 0; s < steps; s++) mutate();
        const mode2 = next() < 0.9 ? mode : pick([4, 7, 1]);
        const flags = drawFlags(ctx);
        writeDrawRecord(ctx, I, F, CMD_I32, CMD_F32, mode2, flags);
        const expected = fullEqual(I, F, 0, 1);
        expect(drawRecordMatches(ctx, I, F, 0, 0, mode2, flags)).toBe(expected);
        if (expected) matches++;
        if (next() < 0.02) for (let s = 0; s < 5; s++) mutate();
    }
    expect(matches).toBeGreaterThan(1000);
});
