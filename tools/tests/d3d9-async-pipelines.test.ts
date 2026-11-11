import { afterEach, describe, expect, it } from "bun:test";
import { D3D9BackendExecutor } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";
import { RenderCommandType } from "../../src/worker/backends/webgpu/render-frame";
import { createRenderPipelineMaybeAsync } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

type Flags = { __d3d9AsyncPipelines?: boolean };

function makeExecutor(device: Record<string, unknown>) {
    return new D3D9BackendExecutor({
        getDevice: () => device,
        getQueue: () => ({ submit() {} }),
        getFormat: () => "bgra8unorm",
    } as never);
}

function deferred<T>() {
    let resolve!: (v: T) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}

const recipe = (tag: string) => ({ descriptor: { label: tag } as unknown as GPURenderPipelineDescriptor, source: "" });

afterEach(() => { delete (globalThis as Flags).__d3d9AsyncPipelines; });

describe("D3D9 async pipeline creation", () => {
    it("uses createRenderPipelineAsync by default and the sync call when switched off", () => {
        const calls: string[] = [];
        const device = {
            createRenderPipeline: () => { calls.push("sync"); return { sync: true }; },
            createRenderPipelineAsync: () => { calls.push("async"); return Promise.resolve({ async: true }); },
        } as unknown as GPUDevice;
        const a = createRenderPipelineMaybeAsync(device, {} as GPURenderPipelineDescriptor);
        expect(a instanceof Promise).toBe(true);
        (globalThis as Flags).__d3d9AsyncPipelines = false;
        const b = createRenderPipelineMaybeAsync(device, {} as GPURenderPipelineDescriptor);
        expect(b instanceof Promise).toBe(false);
        expect(calls).toEqual(["async", "sync"]);
    });

    it("falls back to the sync call on a device without the async entry point", () => {
        const device = { createRenderPipeline: () => ({ sync: true }) } as unknown as GPUDevice;
        expect(createRenderPipelineMaybeAsync(device, {} as GPURenderPipelineDescriptor) instanceof Promise).toBe(false);
    });

    it("a pending id has no pipeline until its compile resolves, then it is installed", async () => {
        const executor = makeExecutor({});
        const d = deferred<GPURenderPipeline>();
        const id = executor.registerPipeline(d.promise, false, false, 1, [], [], undefined, 0, recipe("p"));
        expect(executor.getPipeline(id)).toBeNull();
        expect(executor.isPipelinePending(id)).toBe(true);
        const ready = { ready: true } as unknown as GPURenderPipeline;
        d.resolve(ready);
        await d.promise;
        await Promise.resolve();
        expect(executor.getPipeline(id)).toBe(ready);
        expect(executor.getPipelineInfo(id)?.pipeline).toBe(ready);
        expect(executor.hasPendingPipelines()).toBe(false);
    });

    it("a compile that resolves after the device resources were dropped installs nothing", async () => {
        const executor = makeExecutor({});
        const d = deferred<GPURenderPipeline>();
        executor.registerPipeline(d.promise, false, false, 1, [], [], undefined, 0, recipe("p"));
        executor.dropDeviceResources();
        const fresh = executor.registerPipeline({ fresh: true } as unknown as GPURenderPipeline, false);
        d.resolve({ stale: true } as unknown as GPURenderPipeline);
        await d.promise;
        await Promise.resolve();
        expect(executor.getPipeline(fresh)).toEqual({ fresh: true } as never);
        expect(executor.hasPendingPipelines()).toBe(false);
    });

    it("a failed compile leaves the draw dropped and the id no longer pending", async () => {
        const executor = makeExecutor({});
        const d = deferred<GPURenderPipeline>();
        const id = executor.registerPipeline(d.promise, false, false, 1, [], [], undefined, 0, recipe("p"));
        d.reject(new Error("compile failed"));
        await d.promise.catch(() => undefined);
        await Promise.resolve();
        expect(executor.getPipeline(id)).toBeNull();
        expect(executor.isPipelinePending(id)).toBe(false);
    });

    it("an off-screen pass builds the pending pipelines it names synchronously from their recipe", () => {
        const built: string[] = [];
        const device = { createRenderPipeline: (d: { label: string }) => { built.push(d.label); return { label: d.label }; } };
        const executor = makeExecutor(device);
        const named = executor.registerPipeline(new Promise<GPURenderPipeline>(() => {}), false, false, 1, [], [], undefined, 0, recipe("named"));
        const other = executor.registerPipeline(new Promise<GPURenderPipeline>(() => {}), false, false, 1, [], [], undefined, 0, recipe("other"));
        const frame = {
            commandCount: 1,
            commandTypes: [RenderCommandType.SetPipeline],
            commandA: [named],
            arenaDrawBindings: [],
            arenaIndexedRuns: [],
        };
        (executor as unknown as { materializeFramePipelines(f: unknown, d: unknown): void }).materializeFramePipelines(frame, device);
        expect(built).toEqual(["named"]);
        expect(executor.getPipeline(named)).toEqual({ label: "named" } as never);
        expect(executor.isPipelinePending(other)).toBe(true);
    });
});
