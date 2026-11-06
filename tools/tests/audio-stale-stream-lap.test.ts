import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    createAudioRingBuffer, getCtrl, setCtrl, writeRingData,
    CTRL_DATA_LENGTH, CTRL_FLAGS, CTRL_LOOP_MODE, CTRL_PLAY_CURSOR, CTRL_STATE, CTRL_WRITE_CURSOR,
    FLAG_CIRCULAR, FLAG_STREAMING, STATE_PLAYING,
} from "../../src/audio/audio-ring-buffer";

let Processor: any;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(key: string, value: unknown): void {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

beforeAll(async () => {
    installGlobal("AudioWorkletProcessor", class {
        port = { postMessage(_msg: unknown) {}, onmessage: null as any };
    });
    installGlobal("registerProcessor", (name: string, ctor: unknown) => {
        if (name === "bottleship-audio") Processor = ctor;
    });
    installGlobal("sampleRate", 48000);
    installGlobal("currentTime", 0);
    installGlobal("self", { postMessage(_msg: unknown) {} });
    await import("../../src/audio/bottleship-audio-worklet.ts?stale-stream-lap");
});

afterAll(() => {
    for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const QUANTUM = 128;
const FRAMES = 1000;

function loopingStream(streaming: boolean) {
    const processor = new Processor();
    const sab = createAudioRingBuffer(FRAMES * 4, { channels: 1, sampleRate: 48000, bitsPerSample: 32 }, true);
    writeRingData(sab, 0, new Uint8Array(new Float32Array(FRAMES).fill(0.25).buffer), FRAMES * 4);
    setCtrl(sab, CTRL_DATA_LENGTH, FRAMES * 4);
    setCtrl(sab, CTRL_LOOP_MODE, -1);
    setCtrl(sab, CTRL_FLAGS, FLAG_CIRCULAR | (streaming ? FLAG_STREAMING : 0));
    setCtrl(sab, CTRL_WRITE_CURSOR, (FRAMES - 1) * 4);
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);
    processor.port.onmessage({ data: { type: "register", id: 7, sab } });
    const quantum = () => {
        const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
        processor.process([], [out], {});
        return out[0];
    };
    return { sab, quantum };
}

describe("a looping stream whose producer stopped refilling it", () => {
    test("goes quiet once the play cursor passes the last written byte, keeps moving, and resumes on the next write", () => {
        const v = loopingStream(true);
        expect(v.quantum().some((s) => s > 0.1)).toBe(true);
        for (let i = 0; i < 12; i++) v.quantum();
        const silent = v.quantum();
        expect(silent.every((s) => s === 0)).toBe(true);
        const cursorBefore = getCtrl(v.sab, CTRL_PLAY_CURSOR);
        v.quantum();
        expect(getCtrl(v.sab, CTRL_PLAY_CURSOR)).not.toBe(cursorBefore);
        const play = getCtrl(v.sab, CTRL_PLAY_CURSOR) / 4;
        setCtrl(v.sab, CTRL_WRITE_CURSOR, ((play + 600) % FRAMES) * 4);
        v.quantum();
        expect(v.quantum().some((s) => s > 0.1)).toBe(true);
    });

    test("negative control: a looping buffer that is not a stream keeps repeating its content", () => {
        const v = loopingStream(false);
        for (let i = 0; i < 30; i++) expect(v.quantum().every((s) => s > 0.1)).toBe(true);
    });
});
