import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { captureTrace, CdpSession } from "../cdp-core";

class TraceSession {
    listeners = new Map<string, Array<(p: any) => void>>();
    methods: string[] = [];
    closed = 0;
    startError: Error | null = null;
    end: () => Promise<unknown> = async () => {
        this.emit("Tracing.dataCollected", { value: [{ name: "last-chunk" }] });
        this.emit("Tracing.tracingComplete", {});
        return {};
    };
    on(name: string, fn: (p: any) => void) {
        this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]);
    }
    off(name: string, fn: (p: any) => void) {
        this.listeners.set(name, (this.listeners.get(name) ?? []).filter(f => f !== fn));
    }
    emit(name: string, params: any) { for (const fn of this.listeners.get(name) ?? []) fn(params); }
    async send(name: string) {
        this.methods.push(name);
        if (name === "Tracing.start") {
            if (this.startError) throw this.startError;
            this.emit("Tracing.dataCollected", { value: [{ name: "first-chunk" }] });
            return {};
        }
        if (name === "Tracing.end") return this.end();
        throw new Error("Unexpected CDP call " + name);
    }
    close() { this.closed++; }
}

let session: TraceSession;
let dir: string;
let file: string;
beforeEach(() => {
    session = new TraceSession();
    dir = mkdtempSync(join(tmpdir(), "cdp-trace-completion-"));
    file = join(dir, "trace.json.gz");
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        webSocketDebuggerUrl: "ws://mock-only/never-connect",
    })));
    spyOn(CdpSession, "connect").mockResolvedValue(session as unknown as CdpSession);
});
afterEach(() => {
    mock.restore();
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
});
function cleaned() {
    expect(session.closed).toBe(1);
    expect([...session.listeners.values()].flat()).toHaveLength(0);
}

test("complete trace retains final chunks, handles completion before end ACK, and clears its timer", async () => {
    const timers = spyOn(globalThis, "setTimeout");
    const clears = spyOn(globalThis, "clearTimeout");
    const result = await captureTrace(file, 0);
    expect(result.completed).toBe(true);
    expect(result.events).toBe(2);
    expect(result.requestedDurationMs).toBe(0);
    expect(result.recordingElapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.completionWaitMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(gunzipSync(readFileSync(file)).toString()).traceEvents)
        .toEqual([{ name: "first-chunk" }, { name: "last-chunk" }]);
    const deadline = timers.mock.calls.findIndex(call => call[1] === 120_000);
    expect(deadline).toBeGreaterThanOrEqual(0);
    expect(clears).toHaveBeenCalledWith(timers.mock.results[deadline].value);
    expect(session.methods).toEqual(["Tracing.start", "Tracing.end"]);
    cleaned();
});

test("end ACK without tracingComplete rejects instead of writing a partial trace", async () => {
    session.end = async () => ({});
    await expect(captureTrace(file, 0, { completionTimeoutMs: 5 })).rejects.toThrow("incomplete trace not written");
    expect(existsSync(file)).toBe(false);
    cleaned();
    session.emit("Tracing.tracingComplete", {}); // late event cannot resurrect the capture
    expect(existsSync(file)).toBe(false);
});

test("timeout leaves a pre-existing output artifact intact", async () => {
    writeFileSync(file, "previous successful artifact");
    session.end = async () => ({});
    await expect(captureTrace(file, 0, { completionTimeoutMs: 5 })).rejects.toThrow("tracingComplete");
    expect(readFileSync(file, "utf8")).toBe("previous successful artifact");
    cleaned();
});

test("completion event without Tracing.end ACK also times out", async () => {
    session.end = () => {
        session.emit("Tracing.tracingComplete", {});
        return new Promise(() => {});
    };
    await expect(captureTrace(file, 0, { completionTimeoutMs: 5 })).rejects.toThrow("Tracing.end");
    expect(existsSync(file)).toBe(false);
    cleaned();
});

test("failed Tracing.start closes its session without writing output", async () => {
    session.startError = new Error("another trace is active");
    await expect(captureTrace(file, 0)).rejects.toThrow("another trace is active");
    expect(session.methods).toEqual(["Tracing.start"]);
    expect(existsSync(file)).toBe(false);
    cleaned();
});

test("failed Tracing.end closes its session and cancels the completion deadline", async () => {
    const timers = spyOn(globalThis, "setTimeout");
    const clears = spyOn(globalThis, "clearTimeout");
    session.end = async () => { throw new Error("end failed"); };
    await expect(captureTrace(file, 0)).rejects.toThrow("end failed");
    const deadline = timers.mock.calls.findIndex(call => call[1] === 120_000);
    expect(clears).toHaveBeenCalledWith(timers.mock.results[deadline].value);
    expect(existsSync(file)).toBe(false);
    cleaned();
});

test("delayed completion after end ACK includes all late chunks", async () => {
    session.end = async () => {
        queueMicrotask(() => {
            session.emit("Tracing.dataCollected", { value: [{ name: "late" }] });
            session.emit("Tracing.tracingComplete", {});
        });
        return {};
    };
    const result = await captureTrace(file, 0, { completionTimeoutMs: 100 });
    expect(result.events).toBe(2);
    expect(JSON.parse(gunzipSync(readFileSync(file)).toString()).traceEvents[1].name).toBe("late");
    cleaned();
});

test("host-monotonic elapsed metadata records hooks extending the requested window", async () => {
    const result = await captureTrace(file, 0, {
        during: async () => { await new Promise(resolve => setTimeout(resolve, 8)); },
    });
    expect(result.requestedDurationMs).toBe(0);
    expect(result.recordingElapsedMs).toBeGreaterThanOrEqual(5);
    cleaned();
});

test("completion latency includes a delayed end ACK even when the event arrived first", async () => {
    session.end = async () => {
        session.emit("Tracing.tracingComplete", {});
        await new Promise(resolve => setTimeout(resolve, 8));
        return {};
    };
    const result = await captureTrace(file, 0);
    expect(result.completionWaitMs).toBeGreaterThanOrEqual(5);
    cleaned();
});

test("buffer-full telemetry stays separate from receiving tracingComplete", async () => {
    session.end = async () => {
        session.emit("Tracing.bufferUsage", { percentFull: 1, eventCount: 20 });
        session.emit("Tracing.tracingComplete", {});
        return {};
    };
    const result = await captureTrace(file, 0);
    expect(result.completed).toBe(true);
    expect(result.bufferFull).toBe(true);
    cleaned();
});

test("output serialization failure does not leave a CDP session open", async () => {
    await expect(captureTrace(join(dir, "absent", "trace.json.gz"), 0)).rejects.toThrow();
    cleaned();
});

test("invalid completion deadline is rejected before connecting", async () => {
    for (const completionTimeoutMs of [0, -1, NaN, Infinity]) {
        await expect(captureTrace(file, 0, { completionTimeoutMs })).rejects.toThrow("positive and finite");
    }
    expect(CdpSession.connect).not.toHaveBeenCalled();
    expect(session.closed).toBe(0);
});
