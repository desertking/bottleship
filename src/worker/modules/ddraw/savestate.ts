import { System } from '../../core/system';
import { savestateParticipants, stateKeys, type FieldPolicy } from '../../savestate/participant';
import { CaptureRefusal, objectCodecs } from '../../savestate/object-codecs';
import type { SaveValue } from '../../savestate/value-codec';
import type { DDrawContext } from './context';
import { surfaceAt } from './helpers';
import {
    BITMAP_TEXTURE_FIELDS, Direct3DDevice3Object, Direct3DDevice7Object, Direct3DTexture2Object, Direct3DViewport3Object, DirectDrawSurfaceObject, PRIVATE_DATA_FIELDS, RENDER_SURFACE_FIELDS, SURFACE_FIELDS,
    gpuHoldsLatest, isRenderSurface, type DirectDrawSurfaceState, type SavedSurfaceObject,
} from './com-objects';
import { recountLostSurfaces } from '../../core/gpu/gpu-device-loss-contract';
import {
    DirectDrawClipperObject, DirectDrawObject, DirectDrawPaletteObject, type SavedClipper, type SavedPalette,
} from './com-objects-ddraw';
import { captureTearOffs, restoreTearOffs } from './com-tearoff';
import { BaseComObject, type ComBaseState } from '../../core/com/base-com-object';

import { registerImmediateModeCodecs } from './d3d/savestate';
import type { TextureHandleEntry } from './context';

const TEXTURE_HANDLE_FIELDS = {
    handle: 'save', width: 'save', height: 'save', pitch: 'save', format: 'save',
    srcColorKey: 'save', gpuTexture: 'host', gpuTextureView: 'host', gpuTextureFormat: 'host',
    mode: 'derive', version: 'derive', lastUploadVersion: 'derive', surfaceState: 'derive', restoredSurface: 'derive',
} as const satisfies Record<keyof TextureHandleEntry, FieldPolicy>;

type SavedTextureHandle = Pick<TextureHandleEntry, 'handle' | 'width' | 'height' | 'pitch' | 'format' | 'srcColorKey'>;

export interface DDrawState {
    display: DDrawContext['display'];
    desktopMode: DDrawContext['desktopMode'];
    cooperative: DDrawContext['cooperative'];
    gdiSurfaceVisible: boolean;
    surfaces: DDrawContext['surfaces'];
    ddraw7ObjectAddr: number;
    usedVidMem: number;
    nextTextureHandle: number;
    textureHandles: Array<{ keys: number[]; entry: SavedTextureHandle }>;
    matrices: number[];
    suppressPresent: boolean;
    gammaRamp: { red: Float32Array; green: Float32Array; blue: Float32Array; isIdentity: boolean } | null;
    deferredSurfacePtrFrees: number[];
    bitmapSurfaces: Array<[number, number]>;
}

export interface DDrawHost {
    context(): DDrawContext;
    bitmapSurfaces(): Map<number, number>;
    surfaceStates(): Iterable<DirectDrawSurfaceState>;
}

export const DDRAW_CONTEXT_FIELDS = {
    process: 'host', vtables: 'host', resourceProvider: 'host', presenter: 'host', backend: 'host', executor: 'host',
    display: 'save', desktopMode: 'save', cooperative: 'save', gdiSurfaceVisible: 'save', surfaces: 'save',
    ddraw7ObjectAddr: 'save', usedVidMem: 'save', textureHandles: 'save', nextTextureHandle: 'save', matrices: 'save', defaults: 'host',
    deferredUploadManager: 'host', suppressPresent: 'save', gammaRamp: 'save', deferredSurfacePtrFrees: 'save',
} as const satisfies Record<keyof DDrawContext, FieldPolicy>;

export function liveSurfaceStates(objects: Iterable<unknown>): DirectDrawSurfaceState[] {
    const seen = new Set<DirectDrawSurfaceState>();
    const visit = (st: DirectDrawSurfaceState) => {
        if (seen.has(st)) return;
        seen.add(st);
        for (const m of st.mipSublevels ?? []) visit(m);
    };
    for (const o of objects) if (o instanceof DirectDrawSurfaceObject) visit(o.getState());
    return [...seen];
}

export async function readBackGpuLatest(host: DDrawHost): Promise<number> {
    const executor = host.context().executor;
    let read = 0;
    for (const st of host.surfaceStates()) {
        if (!gpuHoldsLatest(st) || !executor) continue;
        await executor.syncSurfaceToMemory(st);
        read++;
    }
    return read;
}

const keys = <T>(k: Record<keyof T, true>) => stateKeys<T>(k);

export const DDRAW_SCHEMA = {
    context: DDRAW_CONTEXT_FIELDS,
    state: keys<DDrawState>({
        display: true, desktopMode: true, cooperative: true, gdiSurfaceVisible: true, surfaces: true, ddraw7ObjectAddr: true,
        usedVidMem: true, nextTextureHandle: true, suppressPresent: true, gammaRamp: true, deferredSurfacePtrFrees: true,
        bitmapSurfaces: true, textureHandles: true, matrices: true,
    }),
    mode: keys<DDrawContext['display']>({ width: true, height: true, bpp: true, refresh: true }),
    cooperative: keys<DDrawContext['cooperative']>({ hwnd: true, flags: true, exclusive: true }),
    surface: SURFACE_FIELDS,
    bitmapTexture: BITMAP_TEXTURE_FIELDS,
    renderSurface: RENDER_SURFACE_FIELDS,
    privateData: PRIVATE_DATA_FIELDS,
    surfaceObject: keys<SavedSurfaceObject>({ base: true, state: true, texture2: true, texture: true, owner: true }),
    comBase: keys<ComBaseState>({ refCount: true, handle: true, iid: true, vtable: true, ifaceRefs: true, liveIfaces: true, destroyed: true }),
    clipper: keys<SavedClipper>({ base: true, hwnd: true, clipList: true }),
    palette: keys<SavedPalette>({ base: true, entries: true, rgba: true, caps: true, version: true }),
    textureHandle: TEXTURE_HANDLE_FIELDS,
    bitmapSurfaceRow: ['bitmapHandle', 'surfaceAddr'],
} as const;

export function captureDDrawState(host: DDrawHost): DDrawState {
    const c = host.context();
    const textureHandles = new Map<TextureHandleEntry, number[]>();
    for (const [key, entry] of c.textureHandles) {
        let keys = textureHandles.get(entry);
        if (!keys) {
            keys = [];
            textureHandles.set(entry, keys);
        }
        keys.push(key);
    }
    return {
        display: { ...c.display },
        desktopMode: { ...c.desktopMode },
        cooperative: { ...c.cooperative },
        gdiSurfaceVisible: c.gdiSurfaceVisible,
        surfaces: { ...c.surfaces },
        ddraw7ObjectAddr: c.ddraw7ObjectAddr,
        usedVidMem: c.usedVidMem,
        nextTextureHandle: c.nextTextureHandle,
        matrices: [...c.matrices],
        textureHandles: [...textureHandles].map(([entry, keys]) => {
            const { handle, width, height, pitch, format, srcColorKey } = entry;
            const owner = c.resourceProvider.getComObject(handle);
            if (!(owner instanceof DirectDrawSurfaceObject)) {
                throw new CaptureRefusal(`ddraw: texture handle 0x${handle.toString(16)} has no live surface`);
            }
            return { keys, entry: structuredClone({ handle, width, height, pitch, format, ...(srcColorKey && { srcColorKey }) }) };
        }),
        suppressPresent: c.suppressPresent,
        gammaRamp: c.gammaRamp
            ? { red: c.gammaRamp.red.slice(), green: c.gammaRamp.green.slice(), blue: c.gammaRamp.blue.slice(), isIdentity: c.gammaRamp.isIdentity }
            : null,
        deferredSurfacePtrFrees: [...c.deferredSurfacePtrFrees],
        bitmapSurfaces: [...host.bitmapSurfaces()],
    };
}

export function restoreDDrawState(host: DDrawHost, s: DDrawState): void {
    const c = host.context();
    if (c.textureHandles.size > 0 || c.surfaces.primary !== 0) throw new Error('ddraw: a savestate loads only into a fresh worker, before DirectDraw is used');
    c.display = { ...s.display };
    c.desktopMode = { ...s.desktopMode };
    c.cooperative = { ...s.cooperative };
    c.gdiSurfaceVisible = s.gdiSurfaceVisible;
    c.surfaces = { ...s.surfaces };
    c.ddraw7ObjectAddr = s.ddraw7ObjectAddr;
    c.usedVidMem = s.usedVidMem;
    c.nextTextureHandle = s.nextTextureHandle;
    for (const addr of s.matrices) c.matrices.add(addr);
    for (const { keys, entry } of s.textureHandles) {
        const owner = c.resourceProvider.getComObject(entry.handle);
        if (!(owner instanceof DirectDrawSurfaceObject)) throw new Error('ddraw: missing restored texture surface');
        const restored: TextureHandleEntry = {
            ...structuredClone(entry), gpuTexture: null, gpuTextureView: null, restoredSurface: owner.getState(),
        };
        for (const key of keys) c.textureHandles.set(key, restored);
    }
    for (const obj of c.resourceProvider?.getAllComObjects().values() ?? []) {
        if (!(obj instanceof Direct3DDevice3Object || obj instanceof Direct3DDevice7Object)) continue;
        for (let stage = 0; stage < 8; stage++) {
            const surface = surfaceAt(c.resourceProvider, obj.getTexture(stage));
            if (!surface) continue;
            const state = surface.getState();
            state.boundByDevices ??= new Map();
            state.boundByDevices.set(`${obj.handle}:${stage}`, { deviceHandle: obj.handle, stage });
        }
    }
    c.suppressPresent = s.suppressPresent;
    c.gammaRamp = s.gammaRamp
        ? { red: s.gammaRamp.red.slice(), green: s.gammaRamp.green.slice(), blue: s.gammaRamp.blue.slice(), isIdentity: s.gammaRamp.isIdentity }
        : undefined;
    c.deferredSurfacePtrFrees = [...s.deferredSurfacePtrFrees];
    const bitmaps = host.bitmapSurfaces();
    bitmaps.clear();
    for (const [h, addr] of s.bitmapSurfaces) bitmaps.set(h, addr);
    recountLostSurfaces(host.surfaceStates());
    System.getInstance().requestHostResize(c.display.width, c.display.height, {
        modeSet: true, bpp: c.display.bpp, refreshRate: c.display.refresh,
    });
}

function refusing<T>(run: () => T): T {
    try {
        return run();
    } catch (e) {
        if (e instanceof CaptureRefusal) throw e;
        throw new CaptureRefusal(e instanceof Error ? e.message : String(e));
    }
}

export function registerDDrawCodecs(): void {
    registerImmediateModeCodecs();
    objectCodecs.add<Direct3DTexture2Object>({
        tag: 'ddraw-texture2',
        matches: (o): o is Direct3DTexture2Object => o instanceof Direct3DTexture2Object,
        capture: (o) => ({ base: BaseComObject.captureComBase(o), surfaceHandle: o.getSurfaceHandle() }),
        restore: (s: { base: ComBaseState; surfaceHandle: number }) =>
            BaseComObject.restoreComBase(() => new Direct3DTexture2Object(0, s.surfaceHandle), s.base),
    });
    objectCodecs.add<Direct3DViewport3Object>({
        tag: 'ddraw-viewport3',
        matches: (o): o is Direct3DViewport3Object => o instanceof Direct3DViewport3Object,
        capture: (o) => ({ ...Direct3DViewport3Object.captureObject(o), tearOffs: captureTearOffs(o) }),
        restore: (state: ReturnType<typeof Direct3DViewport3Object.captureObject> & {
            tearOffs: Array<[string, number]> | null;
        }) => {
            const o = Direct3DViewport3Object.restoreObject(state);
            restoreTearOffs(o, state.tearOffs);
            return o;
        },
    });
    objectCodecs.add<DirectDrawSurfaceObject>({
        tag: 'ddraw-surface',
        matches: (o): o is DirectDrawSurfaceObject => o instanceof DirectDrawSurfaceObject,
        capture: (o, ref) => DirectDrawSurfaceObject.captureObject(o, ref),
        restore: (d: SavedSurfaceObject) => DirectDrawSurfaceObject.restoreObject(d),
        link: (o, _d, ctx) => DirectDrawSurfaceObject.linkObject(o, ref => ctx.object(ref)),
    });
    objectCodecs.add<DirectDrawObject>({
        tag: 'ddraw-object',
        matches: (o): o is DirectDrawObject => o instanceof DirectDrawObject,
        capture: (o) => ({ ...DirectDrawObject.captureObject(o), tearOffs: captureTearOffs(o) }),
        restore: (d: { base: ComBaseState; tearOffs: Array<[string, number]> | null }) => {
            const o = DirectDrawObject.restoreObject(d);
            restoreTearOffs(o, d.tearOffs);
            return o;
        },
    });
    objectCodecs.add<DirectDrawClipperObject>({
        tag: 'ddraw-clipper',
        matches: (o): o is DirectDrawClipperObject => o instanceof DirectDrawClipperObject,
        capture: (o) => DirectDrawClipperObject.captureObject(o),
        restore: (d: SavedClipper) => DirectDrawClipperObject.restoreObject(d),
    });
    objectCodecs.add<DirectDrawPaletteObject>({
        tag: 'ddraw-palette',
        matches: (o): o is DirectDrawPaletteObject => o instanceof DirectDrawPaletteObject,
        capture: (o) => DirectDrawPaletteObject.captureObject(o),
        restore: (d: SavedPalette) => DirectDrawPaletteObject.restoreObject(d),
    });
}

export function registerDDrawParticipant(host: DDrawHost): void {
    registerDDrawCodecs();
    savestateParticipants.add({
        id: 'ddraw', version: 2, order: 60, migrations: {
            1: {
                schemaHash: '844462508bc4ae1e',
                migrate: (v) => ({ ...(v as object), textureHandles: [], matrices: [] }),
            },
        }, covers: ['ddraw'], schema: DDRAW_SCHEMA as unknown as SaveValue,
        prepare: async () => { await readBackGpuLatest(host); },
        capture: () => refusing(() => captureDDrawState(host)) as unknown as SaveValue,
        restore: (s) => restoreDDrawState(host, s as unknown as DDrawState),
    });
}
