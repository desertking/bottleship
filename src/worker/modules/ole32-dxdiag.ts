import type { Process } from '../core/process';
import type { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { installComVtable } from '../core/com/install-com-vtable';
import { allocateComObject, freeComObject } from '../core/com/com-memory';
import { readGuidFromMem } from '../core/com/typelib/typelib-types';
import { Mem } from '../core/memory/mem-accessor';
import { Marshaler } from '../core/memory/marshaler';
import {
    adapterDescription, adapterDeviceId, adapterVendorId, writeAdapterIdentifier9,
    D3DADAPTER_IDENTIFIER9_OFFSETS, D3DADAPTER_IDENTIFIER9_SIZE,
} from '../backends/webgpu/shared/dx-adapter-identifier';

const CLASS = 'a65b8071-3bfe-4213-9a5b-491da4461ca7';
const PROVIDER = '9c6b4cb0-23f8-49cc-a3ed-45a55000a6d2';
const CONTAINER = '7d0f462f-4064-4862-bc7f-933e5058c10f';
const UNKNOWN = '00000000-0000-0000-c000-000000000046';
const E_POINTER = 0x80004003, E_NOINTERFACE = 0x80004002, E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001;
const DXDIAG_E_INSUFFICIENT_BUFFER = 0x8007007a;
const CO_E_NOTINITIALIZED = 0x800401f0;
const VT_BOOL = 11, VT_UI4 = 19, VT_BSTR = 8;

type Prop = number | string | boolean;
interface Node { props: [string, Prop][]; children: [string, Node][] }
interface Instance { addr: number; refs: number; kind: 'provider' | 'container'; node?: Node; initialized?: boolean }
interface Runtime { generation: number; providerVtable: number; containerVtable: number; instances: Map<number, Instance>; tree: Node | null }
const runtimes = new WeakMap<Process, Runtime>();

const PROVIDER_METHODS: [string, number][] = [
    ['QueryInterface', 3], ['AddRef', 1], ['Release', 1], ['Initialize', 2], ['GetRootContainer', 2],
];
const CONTAINER_METHODS: [string, number][] = [
    ['QueryInterface', 3], ['AddRef', 1], ['Release', 1], ['GetNumberOfChildContainers', 2],
    ['EnumChildContainerNames', 4], ['GetChildContainer', 3], ['GetNumberOfProps', 2], ['EnumPropNames', 4], ['GetProp', 3],
];

function adapterGuid(process: Process): string {
    const scratch = process.memory.alloc(D3DADAPTER_IDENTIFIER9_SIZE);
    if (!scratch) return '{00000000-0000-0000-0000-000000000000}';
    try {
        const mem = process.getCurrentMemory();
        if (!writeAdapterIdentifier9(mem, scratch, 0)) return '{00000000-0000-0000-0000-000000000000}';
        return '{' + readGuidFromMem(mem, scratch + D3DADAPTER_IDENTIFIER9_OFFSETS.DeviceIdentifier).toUpperCase() + '}';
    } finally {
        process.memory.free(scratch);
    }
}

function buildTree(process: Process): Node {
    const hex4 = (v: number) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');
    const display: Node = {
        props: [
            ['szDescription', adapterDescription()],
            ['szDeviceName', '\\\\.\\DISPLAY1'],
            ['szDeviceIdentifier', adapterGuid(process)],
            ['szVendorId', hex4(adapterVendorId())],
            ['szDeviceId', hex4(adapterDeviceId())],
            ['dwDisplayMemory', 256 * 1024 * 1024],
            ['szDisplayMemoryLocalized', '256.0 MB'],
            ['szDisplayMemoryEnglish', '256.0 MB'],
            ['bDDAccelerationEnabled', true],
            ['b3DAccelerationExists', true],
            ['b3DAccelerationEnabled', true],
        ],
        children: [],
    };
    const system: Node = {
        props: [
            ['dwDirectXVersionMajor', 9],
            ['dwDirectXVersionMinor', 0],
            ['szDirectXVersionLetter', 'c'],
            ['szDirectXVersionEnglish', '4.09.0000.0904'],
            ['szDirectXVersionLongEnglish', 'DirectX 9.0c (4.09.0000.0904)'],
            ['dwOSMajorVersion', 5],
            ['dwOSMinorVersion', 1],
            ['dwOSBuildNumber', 2600],
            ['dwOSPlatformID', 2],
            ['ullPhysicalMemory', '536870912'],
            ['bDebug', false],
            ['bNECPC98', false],
        ],
        children: [],
    };
    return {
        props: [],
        children: [
            ['DxDiag_SystemInfo', system],
            ['DxDiag_DisplayDevices', { props: [], children: [['0', display]] }],
            ['DxDiag_DirectSound', { props: [], children: [['DxDiag_SoundDevices', { props: [], children: [] }], ['DxDiag_SoundCaptureDevices', { props: [], children: [] }]] }],
            ['DxDiag_DirectInput', { props: [], children: [] }],
            ['DxDiag_SystemDevices', { props: [], children: [] }],
            ['DxDiag_LogicalDisks', { props: [], children: [] }],
        ],
    };
}

function writeWide(addr: number, cch: number, text: string): number {
    if (cch < text.length + 1) return DXDIAG_E_INSUFFICIENT_BUFFER;
    for (let i = 0; i < text.length; i++) if (!Mem.writeUint16(addr + i * 2, text.charCodeAt(i))) return E_POINTER;
    return Mem.writeUint16(addr + text.length * 2, 0) ? 0 : E_POINTER;
}

function allocBstr(process: Process, text: string): number {
    const block = process.memory.alloc(4 + text.length * 2 + 2);
    if (!block) return 0;
    Mem.writeUint32(block, text.length * 2);
    for (let i = 0; i < text.length; i++) Mem.writeUint16(block + 4 + i * 2, text.charCodeAt(i));
    Mem.writeUint16(block + 4 + text.length * 2, 0);
    return block + 4;
}

function resolve(node: Node, path: string): Node | null {
    let cur: Node | undefined = node;
    for (const part of path.split('.')) {
        cur = cur?.children.find(([n]) => n.toLowerCase() === part.toLowerCase())?.[1];
        if (!cur) return null;
    }
    return cur;
}

function runtime(process: Process): Runtime | null {
    const cached = runtimes.get(process);
    if (cached?.generation === process.resetGeneration) return cached;
    runtimes.delete(process);
    const r: Runtime = { generation: process.resetGeneration, providerVtable: 0, containerVtable: 0, instances: new Map(), tree: null };
    const valid = (mem: Uint8Array, p: number, size: number) => p > 0 && p + size <= mem.length;
    const newContainer = (node: Node, out: number): number => {
        const addr = allocateComObject(process.memory, process.getCurrentMemory(), r.containerVtable);
        if (!addr) return E_POINTER;
        r.instances.set(addr, { addr, refs: 1, kind: 'container', node });
        if (!Mem.writeUint32(out, addr)) { r.instances.delete(addr); freeComObject(process.memory, addr); return E_POINTER; }
        return 0;
    };
    const call = (method: string): ThunkImplementation => (_ctx, mem, a) => {
        const self = r.instances.get(a[0] >>> 0);
        if (!self || self.refs <= 0) return E_POINTER;
        switch (method) {
            case 'QueryInterface': {
                if (!valid(mem, a[2], 4) || !Mem.writeUint32(a[2], 0) || !valid(mem, a[1], 16)) return E_POINTER;
                const iid = readGuidFromMem(mem, a[1]).toLowerCase();
                if (iid !== UNKNOWN && iid !== (self.kind === 'provider' ? PROVIDER : CONTAINER)) return E_NOINTERFACE;
                self.refs++;
                return Mem.writeUint32(a[2], self.addr) ? 0 : E_POINTER;
            }
            case 'AddRef': return ++self.refs;
            case 'Release': {
                if (--self.refs > 0) return self.refs;
                r.instances.delete(self.addr);
                freeComObject(process.memory, self.addr);
                return 0;
            }
            case 'Initialize':
                if (!a[1]) return E_POINTER;
                self.initialized = true;
                return 0;
            case 'GetRootContainer':
                if (!valid(mem, a[1], 4)) return E_POINTER;
                Mem.writeUint32(a[1], 0);
                if (!self.initialized) return CO_E_NOTINITIALIZED;
                r.tree ??= buildTree(process);
                return newContainer(r.tree, a[1]);
            case 'GetNumberOfChildContainers':
                return valid(mem, a[1], 4) && Mem.writeUint32(a[1], self.node!.children.length) ? 0 : E_POINTER;
            case 'GetNumberOfProps':
                return valid(mem, a[1], 4) && Mem.writeUint32(a[1], self.node!.props.length) ? 0 : E_POINTER;
            case 'EnumChildContainerNames': {
                if (!valid(mem, a[2], 2)) return E_POINTER;
                const child = self.node!.children[a[1] >>> 0];
                return child ? writeWide(a[2], a[3] >>> 0, child[0]) : E_INVALIDARG;
            }
            case 'EnumPropNames': {
                if (!valid(mem, a[2], 2)) return E_POINTER;
                const prop = self.node!.props[a[1] >>> 0];
                return prop ? writeWide(a[2], a[3] >>> 0, prop[0]) : E_INVALIDARG;
            }
            case 'GetChildContainer': {
                if (!valid(mem, a[2], 4)) return E_POINTER;
                Mem.writeUint32(a[2], 0);
                if (!valid(mem, a[1], 2)) return E_INVALIDARG;
                const child = resolve(self.node!, Marshaler.readWideString(mem, a[1] >>> 0));
                return child ? newContainer(child, a[2]) : E_INVALIDARG;
            }
            case 'GetProp': {
                if (!valid(mem, a[2], 16) || !valid(mem, a[1], 2)) return E_POINTER;
                const name = Marshaler.readWideString(mem, a[1] >>> 0).toLowerCase();
                const prop = self.node!.props.find(([n]) => n.toLowerCase() === name);
                if (!prop) return E_INVALIDARG;
                Mem.writeBytes(a[2], new Uint8Array(16));
                const v = prop[1];
                if (typeof v === 'number') { Mem.writeUint16(a[2], VT_UI4); Mem.writeUint32(a[2] + 8, v >>> 0); }
                else if (typeof v === 'boolean') { Mem.writeUint16(a[2], VT_BOOL); Mem.writeUint16(a[2] + 8, v ? 0xffff : 0); }
                else { const b = allocBstr(process, v); if (!b) return E_POINTER; Mem.writeUint16(a[2], VT_BSTR); Mem.writeUint32(a[2] + 8, b); }
                return 0;
            }
            default: return E_NOTIMPL;
        }
    };
    const handlers: Record<string, ThunkImplementation> = {};
    for (const [prefix, layout] of [['IDxDiagProvider', PROVIDER_METHODS], ['IDxDiagContainer', CONTAINER_METHODS]] as const)
        for (const [name] of layout) handlers[`${prefix}_${name}`] = call(name);
    const install = (prefix: string, layout: [string, number][]) => installComVtable(process, {
        moduleName: 'dxdiagn', handlers,
        methods: layout.map(([name, count]) => ({ name: `${prefix}_${name}`, argCount: count, stackCleanupBytes: count * 4 })),
        logLabel: prefix,
    });
    const provider = install('IDxDiagProvider', PROVIDER_METHODS), container = install('IDxDiagContainer', CONTAINER_METHODS);
    if (!provider || !container) return null;
    r.providerVtable = provider.vtableAddr; r.containerVtable = container.vtableAddr;
    runtimes.set(process, r);
    return r;
}

/** DxDiag provider for titles that read the DirectX version and display memory before creating a device. */
export function coCreateDxDiag(process: Process, clsid: string, iid: string, out: number): number | null {
    if (clsid !== CLASS) return null;
    const mem = process.getCurrentMemory();
    if (!out || out + 4 > mem.length) return E_POINTER;
    Mem.writeUint32(out, 0);
    if (iid !== PROVIDER && iid !== UNKNOWN) return E_NOINTERFACE;
    const r = runtime(process);
    if (!r) return 0x80004005;
    const addr = allocateComObject(process.memory, process.getCurrentMemory(), r.providerVtable);
    if (!addr) return E_POINTER;
    r.instances.set(addr, { addr, refs: 1, kind: 'provider' });
    if (!Mem.writeUint32(out, addr)) { r.instances.delete(addr); freeComObject(process.memory, addr); return E_POINTER; }
    return 0;
}
