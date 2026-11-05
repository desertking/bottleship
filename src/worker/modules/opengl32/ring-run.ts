import type { ThunkImplementation, X86Context } from "../../core/thunking/thunk-dispatcher";
import type { WriteBufRunConsumer, WriteBufRunTables } from "../../core/thunking/wbuf-run";
import { type OpenGLContext, VERT_FLOATS } from "./context";
import { GL_INVALID_OPERATION } from "./constants";

export const GL_RUN_BEGIN = 1;
export const GL_RUN_VERTEX3 = 2;
export const GL_RUN_VERTEX2 = 3;
export const GL_RUN_TEXCOORD2 = 4;
export const GL_RUN_NORMAL3 = 5;
export const GL_RUN_COLOR4F = 6;
export const GL_RUN_COLOR3F = 7;
export const GL_RUN_COLOR4UB = 8;
const GL_RUN_END = 9;
const GL_RUN_PUSH = 10;
const GL_RUN_POP = 11;
const GL_RUN_TRANSLATE = 12;
const GL_RUN_ENABLE = 13;
const GL_RUN_DISABLE = 14;
const GL_RUN_FIRST_CALL = 16;
const NOOP: ThunkImplementation = () => 0;
const DEDICATED: Record<string, number> = {
    glEnd: GL_RUN_END, glPushMatrix: GL_RUN_PUSH, glPopMatrix: GL_RUN_POP,
    glTranslatef: GL_RUN_TRANSLATE, glEnable: GL_RUN_ENABLE, glDisable: GL_RUN_DISABLE,
};

export class GLRingRun implements WriteBufRunConsumer {
    private f32: Float32Array<ArrayBufferLike> = new Float32Array(0);
    private readonly calls: ThunkImplementation[] = [];
    private readonly callArgs: number[][] = [];
    private readonly noCtx = null as unknown as X86Context;
    private readonly none: number[] = [];
    private readonly one: number[] = [0];
    private readonly three: number[] = [0, 0, 0];
    private end: ThunkImplementation = NOOP;
    private push: ThunkImplementation = NOOP;
    private pop: ThunkImplementation = NOOP;
    private translate: ThunkImplementation = NOOP;
    private enable: ThunkImplementation = NOOP;
    private disable: ThunkImplementation = NOOP;

    constructor(private readonly ctx: OpenGLContext) {}

    callOp(impl: ThunkImplementation, argCount: number, name = ""): number {
        const dedicated = DEDICATED[name];
        if (dedicated !== undefined && argCount === (dedicated === GL_RUN_TRANSLATE ? 3 : dedicated >= GL_RUN_ENABLE ? 1 : 0)) {
            switch (dedicated) {
                case GL_RUN_END: this.end = impl; break;
                case GL_RUN_PUSH: this.push = impl; break;
                case GL_RUN_POP: this.pop = impl; break;
                case GL_RUN_TRANSLATE: this.translate = impl; break;
                case GL_RUN_ENABLE: this.enable = impl; break;
                case GL_RUN_DISABLE: this.disable = impl; break;
            }
            return dedicated;
        }
        const op = GL_RUN_FIRST_CALL + this.calls.length;
        if (op > 255) return 0;
        this.calls.push(impl);
        this.callArgs.push(new Array(argCount).fill(0));
        return op;
    }

    run(mem8: Uint8Array, mem32: Uint32Array, base: number, offset: number, head: number, t: WriteBufRunTables): number {
        const ctx = this.ctx;
        if (ctx.compilingList !== null) return offset;
        let f32 = this.f32;
        if (f32.buffer !== mem32.buffer || f32.byteOffset !== mem32.byteOffset || f32.length !== mem32.length) {
            f32 = this.f32 = new Float32Array(mem32.buffer, mem32.byteOffset, mem32.length);
        }
        const owners = t.owners, ops = t.ops, argCounts = t.argCounts;
        const color = ctx.currentColor, normal = ctx.currentNormal;
        while (offset < head) {
            const p = (base + offset) >> 2;
            const id = mem32[p]!;
            if (id >= owners.length || owners[id] !== this) break;
            const a = p + 1;
            const op = ops[id]!;
            switch (op) {
                case GL_RUN_VERTEX3:
                    this.vertex(f32[a]!, f32[a + 1]!, f32[a + 2]!);
                    break;
                case GL_RUN_TEXCOORD2: {
                    const tc = ctx.currentTexCoord[ctx.activeTextureUnit]!;
                    tc[0] = f32[a]!;
                    tc[1] = f32[a + 1]!;
                    break;
                }
                case GL_RUN_VERTEX2:
                    this.vertex(f32[a]!, f32[a + 1]!, 0);
                    break;
                case GL_RUN_NORMAL3:
                    normal[0] = f32[a]!;
                    normal[1] = f32[a + 1]!;
                    normal[2] = f32[a + 2]!;
                    break;
                case GL_RUN_COLOR4F:
                    color[0] = f32[a]!;
                    color[1] = f32[a + 1]!;
                    color[2] = f32[a + 2]!;
                    color[3] = f32[a + 3]!;
                    break;
                case GL_RUN_COLOR3F:
                    color[0] = f32[a]!;
                    color[1] = f32[a + 1]!;
                    color[2] = f32[a + 2]!;
                    color[3] = 1.0;
                    break;
                case GL_RUN_COLOR4UB:
                    color[0] = (mem32[a]! & 0xFF) / 255;
                    color[1] = (mem32[a + 1]! & 0xFF) / 255;
                    color[2] = (mem32[a + 2]! & 0xFF) / 255;
                    color[3] = (mem32[a + 3]! & 0xFF) / 255;
                    break;
                case GL_RUN_BEGIN:
                    if (ctx.immediateMode) {
                        ctx.error = GL_INVALID_OPERATION;
                    } else {
                        ctx.immediateMode = true;
                        ctx.immediatePrimMode = mem32[a]! >>> 0;
                        ctx.immediateFlatCount = 0;
                    }
                    break;
                case GL_RUN_END:
                    this.end(this.noCtx, mem8, this.none);
                    break;
                case GL_RUN_PUSH:
                    this.push(this.noCtx, mem8, this.none);
                    break;
                case GL_RUN_POP:
                    this.pop(this.noCtx, mem8, this.none);
                    break;
                case GL_RUN_TRANSLATE: {
                    const args = this.three;
                    args[0] = mem32[a]! >>> 0;
                    args[1] = mem32[a + 1]! >>> 0;
                    args[2] = mem32[a + 2]! >>> 0;
                    this.translate(this.noCtx, mem8, args);
                    break;
                }
                case GL_RUN_ENABLE:
                    this.one[0] = mem32[a]! >>> 0;
                    this.enable(this.noCtx, mem8, this.one);
                    break;
                case GL_RUN_DISABLE:
                    this.one[0] = mem32[a]! >>> 0;
                    this.disable(this.noCtx, mem8, this.one);
                    break;
                default: {
                    const k = op - GL_RUN_FIRST_CALL;
                    const impl = this.calls[k];
                    if (impl === undefined) return offset;
                    const args = this.callArgs[k]!;
                    for (let i = 0; i < args.length; i++) args[i] = mem32[a + i]! >>> 0;
                    impl(this.noCtx, mem8, args);
                    break;
                }
            }
            offset += (argCounts[id]! + 1) << 2;
        }
        return offset;
    }

    private vertex(x: number, y: number, z: number): void {
        const ctx = this.ctx;
        let buf = ctx.immediateFlatBuf;
        const b = ctx.immediateFlatCount * VERT_FLOATS;
        if (b + VERT_FLOATS > buf.length) {
            const grown = new Float32Array(buf.length * 2);
            grown.set(buf);
            ctx.immediateFlatBuf = grown;
            buf = grown;
        }
        const c = ctx.currentColor, n = ctx.currentNormal, t0 = ctx.currentTexCoord[0]!, t1 = ctx.currentTexCoord[1]!;
        buf[b] = x; buf[b + 1] = y; buf[b + 2] = z; buf[b + 3] = 1;
        buf[b + 4] = c[0]!; buf[b + 5] = c[1]!; buf[b + 6] = c[2]!; buf[b + 7] = c[3]!;
        buf[b + 8] = n[0]!; buf[b + 9] = n[1]!; buf[b + 10] = n[2]!;
        buf[b + 11] = t0[0]!; buf[b + 12] = t0[1]!;
        buf[b + 13] = t1[0]!; buf[b + 14] = t1[1]!;
        ctx.immediateFlatCount++;
    }
}
