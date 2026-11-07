export type AdapterSource = { requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null> };

export const ADAPTER_ATTEMPTS = 5;
export const ADAPTER_BACKOFF_MS = 300;
const PREFERENCES: (GPURequestAdapterOptions | undefined)[] = [undefined, { powerPreference: "high-performance" }, { powerPreference: "low-power" }];

export async function requestAdapterWithRetry(
    gpu: AdapterSource,
    attempts = ADAPTER_ATTEMPTS,
    backoffMs = ADAPTER_BACKOFF_MS,
    sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<GPUAdapter | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        for (const options of PREFERENCES) {
            try {
                const adapter = await gpu.requestAdapter(options);
                if (adapter) return adapter;
            } catch (e) {
                lastError = e;
            }
        }
        if (attempt + 1 < attempts) await sleep(backoffMs * (attempt + 1));
    }
    if (lastError) throw lastError;
    return null;
}
