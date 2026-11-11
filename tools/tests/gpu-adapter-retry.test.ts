import { expect, test } from 'bun:test';
import { requestAdapterWithRetry } from '../../src/gpu-adapter-retry';

const fakeAdapter = { features: new Set() } as unknown as GPUAdapter;

test('a transient null adapter is retried with backoff and other power preferences', async () => {
    const seen: (string | undefined)[] = [];
    let calls = 0;
    const waits: number[] = [];
    const gpu = { requestAdapter: async (o?: GPURequestAdapterOptions) => { seen.push(o?.powerPreference); return ++calls === 7 ? fakeAdapter : null; } };
    expect(await requestAdapterWithRetry(gpu, 5, 100, async ms => { waits.push(ms); })).toBe(fakeAdapter);
    expect(seen.slice(0, 3)).toEqual([undefined, 'high-performance', 'low-power']);
    expect(waits).toEqual([100, 200]);
});

test('a GPU that never offers an adapter still ends in null after the bounded attempts', async () => {
    let calls = 0;
    const waits: number[] = [];
    const gpu = { requestAdapter: async () => { calls++; return null; } };
    expect(await requestAdapterWithRetry(gpu, 5, 100, async ms => { waits.push(ms); })).toBeNull();
    expect(calls).toBe(15);
    expect(waits).toEqual([100, 200, 300, 400]);
});

test('a throwing request is retried and the last error surfaces when nothing succeeds', async () => {
    let calls = 0;
    const ok = { requestAdapter: async () => { if (++calls < 3) throw new Error('busy'); return fakeAdapter; } };
    expect(await requestAdapterWithRetry(ok, 5, 1, async () => {})).toBe(fakeAdapter);
    const bad = { requestAdapter: async () => { throw new Error('gone'); } };
    await expect(requestAdapterWithRetry(bad, 2, 1, async () => {})).rejects.toThrow('gone');
});
