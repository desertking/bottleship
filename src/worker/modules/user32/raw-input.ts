import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { isValidAddress } from '../../core/memory/address-guard';
import {
    RAWINPUT_HEADER_SIZE, RAW_MOUSE_HANDLE, RAW_KEYBOARD_HANDLE,
    type RawInputRegistration,
} from '../../runtime/input/raw-input';

const UINT_ERROR = 0xffffffff;
const RID_INPUT = 0x10000003;
const RID_HEADER = 0x10000005;
const RIDI_PREPARSEDDATA = 0x20000005;
const RIDI_DEVICENAME = 0x20000007;
const RIDI_DEVICEINFO = 0x2000000b;
const DEVICES = [
    { handle: RAW_MOUSE_HANDLE, type: 0, name: '\\\\?\\ROOT#BOTTLESHIP_MOUSE#0000' },
    { handle: RAW_KEYBOARD_HANDLE, type: 1, name: '\\\\?\\ROOT#BOTTLESHIP_KEYBOARD#0000' },
] as const;

function fail(error: number, value = UINT_ERROR): number {
    System.getInstance().scheduler.setLastError(error);
    return value;
}

function valid(mem: Uint8Array, ptr: number, size: number, perms: 'r' | 'rw'): boolean {
    return ptr !== 0 && (ptr & 3) === 0 && size >= 0 && ptr + size <= mem.length
        && isValidAddress(mem, ptr, size, perms);
}

export function createRawInputExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['GetRawInputDeviceList'] = (_ctx, mem, args) => {
        const [data, count, size] = args.map(n => n >>> 0);
        if (size !== 8) return fail(87);
        if (!valid(mem, count, 4, 'rw')) return fail(998);
        if (!data) {
            Mem.writeUint32(count, DEVICES.length);
            return 0;
        }
        const capacity = Mem.readUint32(count);
        if (capacity === null) return fail(998);
        if (capacity < DEVICES.length) {
            Mem.writeUint32(count, DEVICES.length);
            return fail(122);
        }
        if (!valid(mem, data, DEVICES.length * 8, 'rw')) return fail(998);
        for (let i = 0; i < DEVICES.length; i++) {
            Mem.writeUint32(data + i * 8, DEVICES[i].handle);
            Mem.writeUint32(data + i * 8 + 4, DEVICES[i].type);
        }
        return DEVICES.length;
    };

    exports['RegisterRawInputDevices'] = (_ctx, mem, args) => {
        const [data, count, size] = args.map(n => n >>> 0);
        if (size !== 12 || !count) return fail(87, 0);
        if (!valid(mem, data, count * 12, 'r')) return fail(998, 0);
        const input = System.getInstance().inputManager;
        const records: RawInputRegistration[] = [];
        for (let i = 0; i < count; i++) {
            const ptr = data + i * 12;
            const usagePage = Mem.readUint16(ptr), usage = Mem.readUint16(ptr + 2);
            const flags = Mem.readUint32(ptr + 4), hwnd = Mem.readUint32(ptr + 8);
            if (usagePage === null || usage === null || flags === null || hwnd === null) return fail(998, 0);
            const r = { usagePage, usage, flags, hwnd };
            const error = input.rawInput.validateRegistration(r);
            if (error) return fail(error, 0);
            records.push(r);
        }
        input.poll();
        const error = input.rawInput.register(records);
        return error ? fail(error, 0) : 1;
    };

    exports['GetRegisteredRawInputDevices'] = (_ctx, mem, args) => {
        const [data, count, size] = args.map(n => n >>> 0);
        if (size !== 12) return fail(87);
        if (!valid(mem, count, 4, 'rw')) return fail(998);
        const records = System.getInstance().inputManager.rawInput.getRegistered();
        const capacity = Mem.readUint32(count);
        if (capacity === null) return fail(998);
        if (!data || capacity < records.length) {
            Mem.writeUint32(count, records.length);
            return fail(122);
        }
        if (!valid(mem, data, records.length * 12, 'rw')) return fail(998);
        for (let i = 0; i < records.length; i++) {
            const r = records[i], ptr = data + i * 12;
            Mem.writeUint16(ptr, r.usagePage);
            Mem.writeUint16(ptr + 2, r.usage);
            Mem.writeUint32(ptr + 4, r.flags);
            Mem.writeUint32(ptr + 8, r.hwnd);
        }
        return records.length;
    };

    exports['GetRawInputData'] = (_ctx, mem, args) => {
        const handle = args[0] >>> 0, command = args[1] >>> 0, data = args[2] >>> 0;
        const size = args[3] >>> 0, headerSize = args[4] >>> 0;
        if (headerSize !== RAWINPUT_HEADER_SIZE || (command !== RID_INPUT && command !== RID_HEADER)) return fail(87);
        if (!valid(mem, size, 4, 'rw')) return fail(998);
        const system = System.getInstance();
        const packet = system.inputManager.rawInput.getPacket(handle, system.scheduler.getCurrentThreadId());
        if (!packet) return fail(6);
        const required = command === RID_HEADER ? RAWINPUT_HEADER_SIZE : packet.length;
        if (!data) {
            Mem.writeUint32(size, required);
            return 0;
        }
        const capacity = Mem.readUint32(size);
        if (capacity === null) return fail(998);
        if (capacity < required) return fail(122);
        if (!valid(mem, data, required, 'rw')) return fail(998);
        Mem.writeBytes(data, packet.subarray(0, required));
        return required;
    };

    const deviceInfo = (wide: boolean): ThunkImplementation => (_ctx, mem, args) => {
        const [handle, command, data, size] = args.map(n => n >>> 0);
        if (!valid(mem, size, 4, 'rw')) return fail(998);
        if (![RIDI_PREPARSEDDATA, RIDI_DEVICENAME, RIDI_DEVICEINFO].includes(command)) return fail(87);
        const device = DEVICES.find(d => d.handle === handle);
        if (!device) return fail(6);
        if (command === RIDI_PREPARSEDDATA) return fail(50);
        const required = command === RIDI_DEVICENAME ? device.name.length + 1 : 32;
        const capacity = Mem.readUint32(size);
        if (capacity === null) return fail(998);
        if (!data || capacity < required) {
            Mem.writeUint32(size, required);
            return data ? fail(122) : 0;
        }
        const byteSize = command === RIDI_DEVICENAME && wide ? required * 2 : required;
        if (!valid(mem, data, byteSize, 'rw')) return fail(998);
        if (command === RIDI_DEVICEINFO && Mem.readUint32(data) !== 32) return fail(87);
        if (command === RIDI_DEVICENAME) {
            for (let i = 0; i < required; i++) {
                const ch = i < device.name.length ? device.name.charCodeAt(i) : 0;
                if (wide) Mem.writeUint16(data + i * 2, ch);
                else Mem.writeUint8(data + i, ch);
            }
        } else {
            for (let offset = 0; offset < 32; offset += 4) Mem.writeUint32(data + offset, 0);
            Mem.writeUint32(data, 32);
            Mem.writeUint32(data + 4, device.type);
            if (device.type === 0) {
                Mem.writeUint32(data + 8, 1);
                Mem.writeUint32(data + 12, 5);
            } else {
                Mem.writeUint32(data + 8, 4);
                Mem.writeUint32(data + 16, 1);
                Mem.writeUint32(data + 20, 12);
                Mem.writeUint32(data + 24, 3);
                Mem.writeUint32(data + 28, 101);
            }
        }
        Mem.writeUint32(size, required);
        return required;
    };
    exports['GetRawInputDeviceInfoA'] = deviceInfo(false);
    exports['GetRawInputDeviceInfoW'] = deviceInfo(true);

    exports['GetRawInputBuffer'] = (_ctx, mem, args) => {
        if ((args[2] >>> 0) !== RAWINPUT_HEADER_SIZE) return fail(87);
        if (!valid(mem, args[1] >>> 0, 4, 'rw')) return fail(998);
        return fail(50);
    };
    exports['DefRawInputProc'] = (_ctx, _mem, args) =>
        (args[2] >>> 0) === RAWINPUT_HEADER_SIZE ? 0 : fail(87);
    return exports;
}
