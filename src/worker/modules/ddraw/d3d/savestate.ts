import { BaseComObject, type ComBaseState } from '../../../core/com/base-com-object';
import { objectCodecs } from '../../../savestate/object-codecs';
import {
    Direct3DObject, Direct3D2Object, Direct3D3Object, Direct3D7Object,
    Direct3DDeviceObject, Direct3DDevice2Object, Direct3DDevice3Object, Direct3DDevice7Object,
    Direct3DLightObject, Direct3DMaterial3Object,
    Direct3DViewportObject, Direct3DViewport2Object,
    Direct3DExecuteBufferObject, Direct3DVertexBufferObject,
    Direct3DTextureObject, Direct3DTexture2Object, DirectDrawGammaControlObject,
    type ExecuteData,
} from '../com-objects';
import type { D3DLight7Data } from './types';

export function registerImmediateModeCodecs(): void {
    type ComCtor<T> = new (vtable: number) => T;
    function register<T extends BaseComObject, S>(
        tag: string, ctor: ComCtor<T>,
        capture: (obj: T) => S, install: (obj: T, data: S) => void,
    ): void {
        objectCodecs.add<T>({
            tag: 'ddraw-' + tag,
            matches: (o): o is T => o instanceof ctor,
            capture: o => ({ base: BaseComObject.captureComBase(o), data: capture(o) }),
            restore: (s: { base: ComBaseState; data: S }) => {
                const obj = BaseComObject.restoreComBase(() => new ctor(0), s.base);
                install(obj, s.data);
                return obj;
            },
        });
    }

    const empty = () => null;
    const noop = () => {};
    register('d3d', Direct3DObject, empty, noop);
    register('d3d2', Direct3D2Object, empty, noop);
    register('d3d3', Direct3D3Object, empty, noop);
    register('d3d7', Direct3D7Object, empty, noop);
    register('device', Direct3DDeviceObject, empty, noop);
    register('device2', Direct3DDevice2Object, empty, noop);
    register('viewport', Direct3DViewportObject, o => o.getBackground(), (o, h) => o.setBackground(h));
    register('viewport2', Direct3DViewport2Object, o => o.getBackground(), (o, h) => o.setBackground(h));
    register('light', Direct3DLightObject,
        o => ({ light: structuredClone(o.getLightData()), active: o.isActive() }),
        (o, s: { light: D3DLight7Data; active: boolean }) => {
            o.setLightData(structuredClone(s.light));
            o.setActive(s.active);
        });
    register('execute-buffer', Direct3DExecuteBufferObject,
        o => ({ addr: o.getDataAddr(), size: o.getDataSize(), locked: o.isLocked(), exec: structuredClone(o.getExecuteData()) }),
        (o, s: { addr: number; size: number; locked: boolean; exec: ExecuteData }) => {
            o.setData(s.addr, s.size);
            o.setLocked(s.locked);
            o.setExecuteData(structuredClone(s.exec));
        });
    register('vertex-buffer', Direct3DVertexBufferObject,
        o => ({
            data: o.getDataPtr(), fvf: o.getFVF(), count: o.getNumVertices(), caps: o.getCaps(),
            stride: o.getVertexSize(), version: o.getInterfaceVersion(), locked: o.isLocked(),
        }),
        (o, s) => {
            o.setBufferInfo(s.data, s.fvf, s.count, s.caps, s.stride);
            o.setInterfaceVersion(s.version);
            if (s.locked) o.beginLock();
        });

    function registerSurfaceAlias<T extends BaseComObject & { getSurfaceHandle(): number }>(
        tag: string, ctor: new (vtable: number, surfaceHandle: number) => T,
    ): void {
        objectCodecs.add<T>({
            tag,
            matches: (o): o is T => o instanceof ctor,
            capture: o => ({ base: BaseComObject.captureComBase(o), surfaceHandle: o.getSurfaceHandle() }),
            restore: (s: { base: ComBaseState; surfaceHandle: number }) =>
                BaseComObject.restoreComBase(() => new ctor(0, s.surfaceHandle), s.base),
        });
    }
    registerSurfaceAlias('ddraw-texture', Direct3DTextureObject);
    registerSurfaceAlias('ddraw-texture2', Direct3DTexture2Object);
    registerSurfaceAlias('ddraw-gamma', DirectDrawGammaControlObject);

    objectCodecs.add<Direct3DDevice3Object>({
        tag: 'ddraw-device3',
        matches: (o): o is Direct3DDevice3Object => o instanceof Direct3DDevice3Object,
        capture: Direct3DDevice3Object.captureObject,
        restore: Direct3DDevice3Object.restoreObject,
    });
    objectCodecs.add<Direct3DDevice7Object>({
        tag: 'ddraw-device7',
        matches: (o): o is Direct3DDevice7Object => o instanceof Direct3DDevice7Object,
        capture: Direct3DDevice7Object.captureObject,
        restore: (s: ReturnType<typeof Direct3DDevice7Object.captureObject>, ctx) =>
            Direct3DDevice7Object.restoreObject(s, ref => ctx.object(ref)),
    });
    objectCodecs.add<Direct3DMaterial3Object>({
        tag: 'ddraw-material3',
        matches: (o): o is Direct3DMaterial3Object => o instanceof Direct3DMaterial3Object,
        capture: Direct3DMaterial3Object.captureObject,
        restore: Direct3DMaterial3Object.restoreObject,
        link: (o, s: ReturnType<typeof Direct3DMaterial3Object.captureObject>, ctx) => {
            if (s.device !== null) o.setActiveDevice(ctx.object(s.device) as Direct3DDevice3Object);
        },
    });
}
