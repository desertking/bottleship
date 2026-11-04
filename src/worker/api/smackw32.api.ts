/**
 * Smacker Video Library API Descriptor
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

// Ordinals are SMACKW32.DLL's export table; some titles import it by ordinal only.
export const smackw32Module: ModuleDescriptor = {
    name: "smackw32",
    functions: [
        // Sound system
        makeFunc("_SmackSoundUseMSS@4", 1, { ordinal: 33 }),       // driver handle

        // CPU features
        makeFunc("_SmackUseMMX@4", 1),            // flag

        // Video open/close
        makeFunc("_SmackOpen@12", 3, { ordinal: 14 }),             // name, flags, extraBuffers
        makeFunc("_SmackClose@4", 1, { ordinal: 18 }),             // handle

        // Frame control
        makeFunc("_SmackDoFrame@4", 1, { ordinal: 19 }),           // handle
        makeFunc("_SmackNextFrame@4", 1, { ordinal: 21 }),         // handle
        makeFunc("_SmackWait@4", 1, { ordinal: 32 }),              // handle
        makeFunc("_SmackGoto@8", 2, { ordinal: 27 }),              // handle, frame

        // Buffer operations
        makeFunc("_SmackToBuffer@28", 7, { ordinal: 23 }),         // handle, left, top, pitch, height, buf, flags
        makeFunc("_SmackToBufferRect@8", 2, { ordinal: 28 }),      // handle, SmackSurface
        makeFunc("_SmackBufferOpen@24", 6, { ordinal: 2 }),       // hwnd, blitType, width, height, scaledWidth, scaledHeight
        makeFunc("_SmackBufferClose@4", 1, { ordinal: 6 }),       // handle
        makeFunc("_SmackBufferNewPalette@12", 3, { ordinal: 5 }), // handle, palette, palType

        // Sound control
        makeFunc("_SmackSoundOnOff@8", 2, { ordinal: 17 }),        // handle, onoff
        makeFunc("_SmackSoundUseDirectSound@4", 1, { ordinal: 38 }), // directsound handle
        makeFunc("_SmackVolumePan@16", 4, { ordinal: 30 }),        // handle, track, vol, pan
    ]
};
