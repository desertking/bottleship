import { afterEach, describe, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { StreamBindingTable } from "../../src/worker/backends/webgpu/shared/vertex-streams";
import { attachD3D9Split, resetD3D9SplitStreamForTests } from "../../src/worker/modules/d3d9/split";
import { SplitDecoder } from "../../src/worker/backends/webgpu/d3d9/split-codec";

const noRefs = { idOf: () => undefined, twinOf: () => undefined };

type Env = { vb: Map<number, number>; ib: Map<number, [number, number]>; recording: boolean };

function makeDevice(env: Env, role: string): any {
    const dev: any = Object.create(D3D9Device.prototype);
    dev.role = role;
    dev.isExtended = false;
    dev.vertexBuffers = { getIndex: (p: number) => env.vb.get(p >>> 0) ?? null };
    dev.indexBuffers = {
        getIndex: (p: number) => env.ib.get(p >>> 0)?.[0] ?? null,
        getFormat: (i: number) => [...env.ib.values()].find(([x]) => x === i)?.[1] ?? 0,
    };
    dev.suppressStateBlockRecording = false;
    dev.stateBlockRecorder = { isRecording: () => env.recording };
    dev.stateBlockLog = [];
    dev.recordStateBlock = (op: unknown) => { dev.stateBlockLog.push(op); };
    dev.streams = new StreamBindingTable();
    dev.stateTracker = {
        index: -1,
        markStreamsDirty() {},
        setIndexSource(i: number | null) { const v = i ?? -1; const c = v !== this.index; this.index = v; return c; },
    };
    dev.boundIndexPtr = 0;
    dev.boundIndexSlot = -1;
    dev.boundIndexFormat = 0;
    dev.currentPipelineKey = null;
    dev.currentPipelineId = null;
    return dev;
}

function snapshot(dev: any) {
    return JSON.stringify({
        ptr: [...dev.streams.ptr], idx: [...dev.streams.bufferIndex], off: [...dev.streams.offsetBytes],
        stride: [...dev.streams.strideBytes], ib: dev.boundIndexPtr, ibIdx: dev.stateTracker.index, sb: dev.stateBlockLog,
    });
}

function rng(seed: number) {
    let a = seed | 0;
    return (n: number) => {
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return (((t ^ t >>> 14) >>> 0) / 4294967296 * n) | 0;
    };
}

function run(seed: number, mutate?: (front: any) => void) {
    const env: Env = { vb: new Map([[0x1000, 1], [0x2000, 2]]), ib: new Map([[0x5000, [1, 101]], [0x6000, [2, 102]]]), recording: false };
    const front = makeDevice(env, "front");
    const twin = makeDevice(env, "render");
    let records = 0;
    const dispatcher = {
        registerQueuePayloadHandler: () => -2,
        enqueuePayloadById: (_id: number, _h0: number, _h1: number, _h2: number, _h3: number, src: Uint8Array, off: number, len: number) => {
            const d = new SplitDecoder(src.slice(off, off + len), 0, len, noRefs);
            d.value();
            const argc = d.value() as number;
            const args: number[] = [];
            for (let i = 0; i < argc; i++) args.push(d.value() as number);
            if (argc === 1) twin.setIndices(args[0]);
            else twin.setStreamSource(args[0], args[1], args[2], args[3]);
            records++;
            return true;
        },
        executeWbufQueue: () => {},
        setWbufSplitClient: () => {},
    };
    resetD3D9SplitStreamForTests();
    attachD3D9Split(front as never, null, dispatcher, null);
    mutate?.(front);
    const r = rng(seed);
    const vbs = [0, 0x1000, 0x2000, 0x3000];
    const ibs = [0, 0x5000, 0x6000, 0x7000];
    let calls = 0;
    for (let i = 0; i < 400; i++) {
        const k = r(20);
        if (k === 0) env.recording = !env.recording;
        else if (k === 1) env.vb.set(0x2000, 3 + r(3));
        else if (k === 2) env.ib.set(0x6000, [2, r(2) ? 101 : 102]);
        else if (k < 12) { front.setStreamSource(r(3), vbs[r(4)]!, r(2) * 16, r(2) ? 32 : 24); calls++; }
        else { front.setIndices(ibs[r(4)]!); calls++; }
        if (snapshot(front) !== snapshot(twin)) return { ok: false, step: i, records, calls };
    }
    return { ok: true, records, calls };
}

afterEach(() => {
    resetD3D9SplitStreamForTests();
    delete (globalThis as { __noSplitRedundantSkip?: boolean }).__noSplitRedundantSkip;
});

describe("split recorder: redundant stream/index sets", () => {
    test("front and render twin stay identical while redundant sets are not recorded", () => {
        let skipped = 0;
        for (let seed = 1; seed <= 40; seed++) {
            const res = run(seed);
            expect(res).toMatchObject({ ok: true });
            skipped += res.calls - res.records;
        }
        expect(skipped).toBeGreaterThan(500);
    });

    test("the kill switch records every call", () => {
        (globalThis as { __noSplitRedundantSkip?: boolean }).__noSplitRedundantSkip = true;
        const res = run(7);
        expect(res.ok).toBe(true);
        expect(res.records).toBe(res.calls);
    });

    test("a check that ignores the offset lets the twin drift", () => {
        let diverged = 0;
        for (let seed = 1; seed <= 40; seed++) {
            const res = run(seed, (front) => {
                front.streamSourceUnchanged = (n: number, p: number) =>
                    !front.recordingStateBlock && front.streams.ptr[n] === p >>> 0;
            });
            if (!res.ok) diverged++;
        }
        expect(diverged).toBeGreaterThan(0);
    });
});
