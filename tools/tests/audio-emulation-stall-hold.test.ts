import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    createAudioRingBuffer, createListenerSab, setCtrl, writeRingData,
    CTRL_DATA_LENGTH, CTRL_LOOP_MODE, CTRL_STATE, STATE_PLAYING, LCTRL_EMULATION_BEAT, LISTENER_SLOTS,
} from "../../src/audio/audio-ring-buffer";
import { tickEmulationBeat } from "../../src/worker/modules/dsound/emulation-beat";

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
    await import("../../src/audio/bottleship-audio-worklet.ts?emulation-stall");
});

afterAll(() => {
    for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

const QUANTUM = 128;
const STALL_QUANTA = Math.ceil((48000 * 0.25) / QUANTUM) + 2;

function loopingVoice(beating: boolean) {
    const processor = new Processor();
    const listener = createListenerSab();
    const lctrl = new Int32Array(listener, 0, LISTENER_SLOTS);
    if (beating) tickEmulationBeat(lctrl);
    processor.port.onmessage({ data: { type: "register_listener", sab: listener } });
    const sab = createAudioRingBuffer(200 * 4, { channels: 1, sampleRate: 48000, bitsPerSample: 32 }, true);
    writeRingData(sab, 0, new Uint8Array(new Float32Array(200).fill(0.25).buffer), 200 * 4);
    setCtrl(sab, CTRL_DATA_LENGTH, 200 * 4);
    setCtrl(sab, CTRL_LOOP_MODE, -1);
    setCtrl(sab, CTRL_STATE, STATE_PLAYING);
    processor.port.onmessage({ data: { type: "register", id: 9, sab } });
    const quantum = () => {
        const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
        processor.process([], [out], {});
        return out[0];
    };
    const position = () => processor.ringBuffers.get(9).position as number;
    return { lctrl, quantum, position };
}

describe("audio output while the emulation stalls", () => {
    test("a looping buffer goes quiet and holds while the emulation beat stops, then resumes", () => {
        const v = loopingVoice(true);
        for (let i = 0; i < 4; i++) {
            tickEmulationBeat(v.lctrl);
            expect(v.quantum().some((s) => s > 0.1)).toBe(true);
        }
        for (let i = 0; i < STALL_QUANTA; i++) v.quantum();
        const held = v.position();
        for (let i = 0; i < 10; i++) {
            expect(v.quantum().every((s) => s === 0)).toBe(true);
            expect(v.position()).toBe(held);
        }
        tickEmulationBeat(v.lctrl);
        v.quantum();
        expect(v.quantum().some((s) => s > 0.1)).toBe(true);
        expect(v.position()).not.toBe(held);
    });

    test("negative control: with the beat kept alive the loop never stops", () => {
        const v = loopingVoice(true);
        for (let i = 0; i < STALL_QUANTA + 10; i++) {
            tickEmulationBeat(v.lctrl);
            expect(v.quantum().every((s) => s > 0.1)).toBe(true);
        }
    });

    test("negative control: a producer that never publishes a beat keeps the old looping behaviour", () => {
        const v = loopingVoice(false);
        for (let i = 0; i < STALL_QUANTA + 10; i++) {
            expect(v.quantum().every((s) => s > 0.1)).toBe(true);
        }
    });
});
