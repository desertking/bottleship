import { ThunkDispatcher } from "../../../src/worker/core/thunking/thunk-dispatcher";
import { createOpenGLContext, type OpenGLContext } from "../../../src/worker/modules/opengl32/context";
import { createStateExports } from "../../../src/worker/modules/opengl32/state";
import { createMatrixExports } from "../../../src/worker/modules/opengl32/matrix";
import { createImmediateExports, registerWriteBufferGLFunctions } from "../../../src/worker/modules/opengl32/immediate";
import { createTextureExports } from "../../../src/worker/modules/opengl32/texture";
import { createListExports } from "../../../src/worker/modules/opengl32/lists";
import { registerWriteBufferGLStateFunctions } from "../../../src/worker/modules/opengl32/wbuf-state";
import { GLRingRun } from "../../../src/worker/modules/opengl32/ring-run";
import { GL_COMPILE } from "../../../src/worker/modules/opengl32/constants";
import type { ThunkImplementation } from "../../../src/worker/core/thunking/thunk-dispatcher";

const RING_CTRL = 0x3000;
const RING_DATA = 0x10000;
const RING_CAP = 0x100000;
const ZERO_ARG = new Set(["glPushMatrix", "glPopMatrix", "glLoadIdentity", "glEnd"]);

export interface GLRing {
    ctx: OpenGLContext;
    gl: Record<string, ThunkImplementation>;
    put(name: string, ...args: number[]): void;
    drain(): void;
    mem: Uint8Array;
    foreign: number[];
}

export function glRing(useRun: boolean): GLRing {
    const mem = new Uint8Array(RING_DATA + RING_CAP + 0x1000);
    const m32 = new Uint32Array(mem.buffer);
    const stubs: Array<{ dllName: string; functionName: string; functionId: number; address: number; argCount: number; stackCleanupBytes: number }> = [];
    const ids = new Map<string, number>();
    const stubFor = (dll: string, fn: string) => {
        let s = stubs.find(x => x.dllName === dll.toLowerCase() && x.functionName === fn);
        if (!s) {
            const argCount = ZERO_ARG.has(fn) ? 0 : -1;
            s = { dllName: dll.toLowerCase(), functionName: fn, functionId: 100 + stubs.length, address: 0x1000 + stubs.length * 16, argCount, stackCleanupBytes: 0 };
            stubs.push(s);
        }
        return s;
    };
    const generator = {
        findStubsByName: (dll: string, fn: string) => [stubFor(dll, fn)].map(s => s.argCount < 0 ? { ...s, argCount: undefined } : s),
        getAllStubs: () => stubs,
        getStubById: (id: number) => stubs.find(s => s.functionId === id),
    };
    const d = new ThunkDispatcher({ add_listener: () => { } } as any, generator as any) as any;
    d.cachedMem8 = mem;
    d.cachedDataView = new DataView(mem.buffer);
    d.cachedMem32 = m32;
    d.cachedWasmBuffer = mem.buffer;
    d.cachedReg32Raw = new Int32Array(mem.buffer, 64, 8);
    d.memLength = mem.length;
    d.writeBufControlAddr = RING_CTRL;
    d.writeBufDataBase = RING_DATA;
    d.writeBufCapacity = RING_CAP;
    for (let i = 0; i < 32; i++) d.writeBufTrampolineAddrs[i] = 0x2000 + i * 0x40;
    d.registerWbufDynarecIntrinsic = () => { };

    const ctx = createOpenGLContext({ getCurrentMemory: () => mem, dispatcher: d } as any);
    const gl: Record<string, ThunkImplementation> = {};
    Object.assign(gl, createStateExports(ctx), createMatrixExports(ctx), createImmediateExports(ctx), createTextureExports(ctx), createListExports(ctx));
    const raw = { ...gl };
    for (const [name, impl] of Object.entries(raw)) {
        if (/^gl(NewList|EndList|CallLists?|DeleteLists|GenLists|ListBase|IsList)$/.test(name)) continue;
        gl[name] = (c, m, args) => {
            if (ctx.replayingList) return impl(c, m, args);
            if (ctx.compilingList !== null) {
                ctx.compilingCommands.push({ fn: name, args: Array.isArray(args) ? [...args] : [] });
                if (ctx.compilingListMode === GL_COMPILE) return 0;
            }
            return impl(c, m, args);
        };
    }
    const runner = useRun ? new GLRingRun(ctx) : undefined;
    registerWriteBufferGLFunctions(d, ctx, runner);
    registerWriteBufferGLStateFunctions(d, gl, raw, ctx, runner);
    const foreign: number[] = [];
    d.registerWriteBufferFunction("other", "Foreign", 1, (_m8: Uint8Array, mm: Uint32Array, p: number) => {
        foreign.push(mm[p >> 2]!, r.ctx.immediateFlatCount);
    }, true);
    for (const s of stubs) ids.set(s.functionName, s.functionId);

    let head = 0;
    const r: GLRing = {
        ctx, gl, mem, foreign,
        put(name: string, ...args: number[]) {
            const id = ids.get(name);
            if (id === undefined) throw new Error(`${name} is not on the ring`);
            m32[(RING_DATA + head) >> 2] = id;
            head += 4;
            const n = ZERO_ARG.has(name) ? 1 : args.length;
            for (let i = 0; i < n; i++) { m32[(RING_DATA + head) >> 2] = (args[i] ?? 0) >>> 0; head += 4; }
            m32[RING_CTRL >> 2] = head;
        },
        drain() {
            d.drainWriteBuffer();
            head = 0;
            m32[RING_CTRL >> 2] = 0;
            d.wbufTail = 0;
        },
    };
    return r;
}

const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);
export const fbits = (v: number): number => { _f[0] = v; return _u[0]!; };
