import { expect, test } from 'bun:test';
import { APIRegistry } from '../../src/worker/core/api-registry';

test('an undescribed C runtime export binds as cdecl, other DLLs keep no guess', () => {
    const registry = APIRegistry.getInstance();
    for (const dll of ['msvcrt', 'MSVCRT.DLL', 'msvcr71.dll', 'msvcr100d', 'crtdll.dll', 'ucrtbase', 'api-ms-win-crt-runtime-l1-1-0.dll'])
        expect(registry.getCallingConvention(dll, 'zz_no_such_crt_export')).toBe('cdecl');
    expect(registry.getCallingConvention('msvcrt', 'raise')).toBe('cdecl');
    expect(registry.getCallingConvention('kernel32', 'zz_no_such_crt_export')).toBeUndefined();
    expect(registry.getCallingConvention('msvcp60', 'zz_no_such_crt_export')).toBeUndefined();
    expect(registry.getCallingConvention('kernel32', 'Sleep')).toBe('stdcall');
});
