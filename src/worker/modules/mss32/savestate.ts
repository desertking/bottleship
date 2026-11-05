import type { MSSContext } from "./context";
import type { MSSSample, MSSStream, MSSTimer } from "./types";
import { incrementalStreamPosition, playSample } from "./playback-engine";
import { openVfsStreamSource, seekIncrementalStream, startIncrementalStream } from "./stream-engine";

/** @transient(constant: sample fields that are host timing, not session data) */
const HOST_SAMPLE_FIELDS = new Set<keyof MSSSample>([
    'startTime', 'lastDebugLogTime', 'lastDebugPos', 'lastAudioPositionTime', 'lastAudioPositionBytes',
    'lastRingCursorBytes', 'lastRingCursorTime',
]);

const SCALARS = [
    'nextSampleId', 'nextStreamId', 'nextWaveOutId', 'nextFileHandleId', 'nextTimerId', 'nextRedbookId', 'nextSequenceId',
    'initialized', 'digitalDriverHandle', 'directSoundHwnd', 'driverDummyBuffer', 'driverWaveFormat', 'driverNoopStub',
    'driverNoopTable', 'driverSampleArray', 'driverMaxSamples', 'driverOutputRate', 'driverTypeTag', 'sampleTypeTag',
    'driverBuildBuffer', 'driverDecodeBuffer', 'driverAuxBuffer1', 'driverAuxBuffer2', 'driverAuxBuffer3',
    'speakerType3D', 'roomType3D', 'midiDriverHandle', 'midiMasterVolume', 'lastErrorPtr', 'lastErrorStr', 'distanceFactor3D',
] as const satisfies readonly (keyof MSSContext)[];

export interface MssSavestate {
    scalars: Record<string, unknown>;
    samples: Array<Record<string, unknown>>;
    streams: Array<Record<string, unknown>>;
    waveOuts: Array<{ handle: number; deviceId: number; headers: Array<[number, { ptr: number; len: number; flags: number }]> }>;
    redbook: Array<Record<string, number>>;
    timers: Array<Omit<MSSTimer, 'pumpOnReturn' | 'inFlight'> & { running: boolean }>;
    sequences: Array<Record<string, number>>;
    rib: Array<[number, { module: number; interfaces: Array<[string, { entryCount: number; entries: number[] }]> }]>;
    provider3DNamePtrs: number[];
    listener3D: Record<string, number> | null;
    preferences: number[];
    memAllocatedByMss: number[];
    wavFormatByDataPtr: number[][];
    fileCallbacks: MSSContext['fileCallbacks'];
    memCallbacks: MSSContext['memCallbacks'];
    streamUserData: Array<[number, number[]]>;
    streamCallbacks: number[][];
    sequenceUserData: Array<[number, number[]]>;
    sequenceCallbacks: number[][];
    updateInterval: number | null;
}

function plainSample(s: MSSSample): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) {
        if (HOST_SAMPLE_FIELDS.has(k as keyof MSSSample) || v === undefined) continue;
        out[k] = ArrayBuffer.isView(v) ? (v as Uint8Array).slice() : structuredClone(v);
    }
    return out;
}

export function captureMss(ctx: MSSContext): MssSavestate {
    if (ctx.pendingTimerCallbacks.length || ctx.pendingEOSCallbacks.length || ctx.pendingStreamCallbacks.length || ctx.insideAilServe) {
        throw new Error('mss32: a Miles callback is queued or running');
    }
    if (ctx.fileHandles.size > 0) throw new Error('mss32: open Miles file handles are not part of a v1 savestate');
    const streams: Array<Record<string, unknown>> = [];
    for (const st of ctx.streams.values()) {
        if (st.source && (st.source.kind !== 'vfs' || !st.filename)) {
            throw new Error('mss32: a stream fed through the game\'s own file callbacks is not part of a v1 savestate');
        }
        const plain = plainSample({ ...st, source: undefined, decodedData: st.source ? null : st.decodedData } as unknown as MSSSample);
        plain.resume = st.source ? { position: incrementalStreamPosition(st) } : null;
        streams.push(plain);
    }
    const scalars: Record<string, unknown> = {};
    for (const k of SCALARS) scalars[k] = ctx[k];
    return {
        scalars,
        samples: [...ctx.samples.values()].map(plainSample),
        streams,
        waveOuts: [...ctx.waveOuts.values()].map(w => ({ handle: w.handle, deviceId: w.deviceId, headers: [...(w.preparedHeaders ?? [])] })),
        redbook: [...ctx.redbookHandles.values()].map(r => ({ ...r })),
        timers: [...ctx.timers.values()].map(t => ({
            handle: t.handle, callback: t.callback, user: t.user, freq: t.freq, period: t.period, active: t.active,
            timerId: t.timerId, running: t.timerId !== undefined,
        })),
        sequences: [...ctx.sequences.values()].map(q => ({ ...q })),
        rib: [...ctx.ribProviders].map(([k, r]) => [k, { module: r.module, interfaces: [...r.interfaces].map(([n, i]) => [n, { entryCount: i.entryCount, entries: [...i.entries] }]) }]),
        provider3DNamePtrs: [...ctx.provider3DNamePtrs],
        listener3D: ctx.listener3D ? { ...ctx.listener3D } : null,
        preferences: [...ctx.preferences],
        memAllocatedByMss: [...ctx.memAllocatedByMss],
        wavFormatByDataPtr: [...ctx.wavFormatByDataPtr],
        fileCallbacks: ctx.fileCallbacks ? { ...ctx.fileCallbacks } : null,
        memCallbacks: { ...ctx.memCallbacks },
        streamUserData: [...ctx.streamUserData].map(([k, v]) => [k, [...v]]),
        streamCallbacks: [...ctx.streamCallbacks],
        sequenceUserData: [...ctx.sequenceUserData].map(([k, v]) => [k, [...v]]),
        sequenceCallbacks: [...ctx.sequenceCallbacks],
        updateInterval: typeof ctx.updateInterval === 'number' ? ctx.updateInterval : null,
    };
}

export async function restoreMss(ctx: MSSContext, s: MssSavestate): Promise<void> {
    const c = ctx as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(s.scalars)) c[k] = v;
    ctx.samples = new Map();
    ctx.samplesById = new Map();
    for (const raw of s.samples) {
        const sample = { ...raw } as unknown as MSSSample;
        ctx.samples.set(sample.handle, sample);
        ctx.samplesById.set(sample.id, sample);
    }
    ctx.streams = new Map();
    ctx.streamsById = new Map();
    const resumes: Array<{ stream: MSSStream; position: number }> = [];
    for (const raw of s.streams) {
        const { resume, ...rest } = raw as Record<string, unknown> & { resume?: { position: number } | null };
        const stream = { ...rest, source: null } as unknown as MSSStream;
        ctx.streams.set(stream.handle, stream);
        ctx.streamsById.set(stream.id, stream);
        if (resume) resumes.push({ stream, position: resume.position });
    }
    ctx.waveOuts = new Map(s.waveOuts.map(w => [w.handle, { handle: w.handle, deviceId: w.deviceId, preparedHeaders: new Map(w.headers) }]));
    ctx.redbookHandles = new Map(s.redbook.map(r => [r.id, { id: r.id, volume: r.volume, playToken: r.playToken }]));
    ctx.timers = new Map();
    for (const t of s.timers) {
        const timer: MSSTimer = { handle: t.handle, callback: t.callback, user: t.user, freq: t.freq, period: t.period, active: t.active, timerId: t.timerId, inFlight: false };
        if (t.running) {
            const onReturn = () => { if (timer.pumpOnReturn === onReturn) timer.inFlight = false; };
            timer.pumpOnReturn = onReturn;
        }
        ctx.timers.set(t.handle, timer);
    }
    ctx.sequences = new Map(s.sequences.map(q => [q.handle, { handle: q.handle, status: q.status, volume: q.volume, loopCount: q.loopCount, tempo: q.tempo }]));
    ctx.ribProviders = new Map(s.rib.map(([k, r]) => [k, { module: r.module, interfaces: new Map(r.interfaces) }]));
    ctx.provider3DNamePtrs = [...s.provider3DNamePtrs];
    ctx.listener3D = s.listener3D ? { ...s.listener3D } as unknown as MSSContext['listener3D'] : null;
    ctx.preferences = [...s.preferences];
    ctx.memAllocatedByMss = new Set(s.memAllocatedByMss);
    ctx.wavFormatByDataPtr = new Map(s.wavFormatByDataPtr.map(([k, v]) => [k, v]));
    ctx.fileCallbacks = s.fileCallbacks ? { ...s.fileCallbacks } : null;
    ctx.memCallbacks = { ...s.memCallbacks };
    ctx.streamUserData = new Map(s.streamUserData);
    ctx.streamCallbacks = new Map(s.streamCallbacks.map(([k, v]) => [k, v]));
    ctx.sequenceUserData = new Map(s.sequenceUserData);
    ctx.sequenceCallbacks = new Map(s.sequenceCallbacks.map(([k, v]) => [k, v]));
    ctx.updateInterval = s.updateInterval;
    ctx.pendingTimerCallbacks = [];
    ctx.pendingEOSCallbacks = [];
    ctx.pendingStreamCallbacks = [];
    for (const sample of ctx.samples.values()) {
        if (sample.isPlaying) playSample(ctx, sample);
    }
    for (const { stream, position } of resumes) {
        const playing = stream.isPlaying && !stream.isPaused;
        if (!stream.filename || !(await openVfsStreamSource(ctx, stream, stream.filename))) {
            throw new Error(`mss32: stream ${stream.filename ?? '?'} cannot be reopened`);
        }
        seekIncrementalStream(stream, position);
        if (playing) startIncrementalStream(ctx, stream);
    }
}
