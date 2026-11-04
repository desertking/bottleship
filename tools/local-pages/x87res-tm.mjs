// Diagnostic preparation only. Importing this file never connects to a browser.
// Single synchronous evalWorker read; no timer, guest calls, QPC, CPU exports,
// Debugger, scheduling getter, counter reset, or persistent observation state.
export function captureTimeManager(System, label = '') {
    const startedMs = performance.now();
    const result = {
        available: false, label: String(label).slice(0, 64), startedMs,
        originalExeSha256: '6cb732a30949e76b7dc0dae6355b2b83cb2b3d59c87df9937e864190fd6c0165',
        identityScope: 'Fixed-base original code/vtable fingerprints, NOT a full live-image hash',
        lastLoopCountSemantics: 'NONCUMULATIVE: reset to 0 by 0x55be10 before update loop on the 0x55cec7 path; committed from ESI at 0x55d036. In-progress zero may be reset/uncommitted. Positive value is a stored loop result, NOT proof of a completed prior frame. Never sum sparse samples as all frames.',
        samplingScope: 'One synchronous worker-turn observation; not an exact present/frame-boundary trace',
    };
    try {
        const sys = System.getInstance(), p = sys.process;
        if (!p) throw Error('No existing process');
        // Plain PHYSICAL guest RAM, not the raw CPU WASM buffer. VA ownership
        // is checked separately; translate paging without TLB/access-bit writes.
        const memory = p.getCurrentMemory();
        if (!ArrayBuffer.isView(memory) || memory.BYTES_PER_ELEMENT !== 1)
            throw Error('Plain guest byte view unavailable');
        if (typeof p.addressSpace?.validateRange !== 'function')
            throw Error('Guest address validation unavailable');
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const cpu = p.v86?.cpu ?? p.v86?.v86?.cpu;
        if (!cpu?.cr || cpu.cr.length < 5) throw Error('CPU control registers unavailable');
        const cr0 = cpu.cr[0] >>> 0, cr3 = cpu.cr[3] >>> 0, cr4 = cpu.cr[4] >>> 0;
        const paging = !!(cr0 & 0x80000000), pages = new Map();
        result.addressing = {cr0, cr3, cr4, pagingEnabled: paging,
            mode: paging ? 'read-only-x86-page-walk' : 'CR0.PG=0:linear-equals-physical', pages: []};
        if (paging && (cr4 & 0x20)) throw Error('PAE deliberately unsupported');
        const physical32 = a => {
            if (a < 0 || a + 4 > memory.byteLength) throw Error('Page-table address outside physical RAM');
            return view.getUint32(a, true);
        };
        const physical = a => {
            const page = Math.floor(a / 4096) * 4096;
            let mapped = pages.get(page);
            if (mapped === undefined) {
                mapped = page;
                if (paging) {
                    const pde = physical32(((cr3 & 0xfffff000) >>> 0) + (a >>> 22) * 4);
                    if (!(pde & 1)) throw Error('Unmapped PDE');
                    if (pde & 0x80) {
                        if (!(cr4 & 0x10) || (pde & 0x003fe000)) throw Error('Unsupported PSE/PSE36');
                        mapped = ((pde & 0xffc00000) | (page & 0x3fffff)) >>> 0;
                    } else {
                        const pte = physical32(((pde & 0xfffff000) >>> 0) + ((a >>> 12) & 1023) * 4);
                        if (!(pte & 1)) throw Error('Unmapped PTE');
                        mapped = (pte & 0xfffff000) >>> 0;
                    }
                }
                pages.set(page, mapped);
                result.addressing.pages.push({virtualPage: page, physicalPage: mapped, identity: page === mapped});
            }
            const out = mapped + (a & 4095);
            if (out >= memory.byteLength) throw Error('Mapped address out-of-bounds physical RAM');
            return out;
        };
        const valid = (a, n) => {
            if (!Number.isSafeInteger(a) || a <= 0 || !Number.isSafeInteger(n) || n <= 0
                || a + n > 0x100000000
                || !p.addressSpace.validateRange(a, n, 'r'))
                throw Error('Unmapped/out-of-bounds guest range 0x' + a.toString(16) + '+' + n);
        };
        const read = (a, n) => {
            valid(a, n);
            const bytes = new Uint8Array(n);
            for (let i = 0; i < n; i++) bytes[i] = memory[physical(a + i)];
            return bytes;
        };
        const u32 = a => new DataView(read(a, 4).buffer).getUint32(0, true);
        const hexBytes = (a, n) => {
            return Array.from(read(a, n), b => b.toString(16).padStart(2, '0')).join('');
        };
        // Extracted independently from the hash-pinned original PE, image base
        // 0x400000. Fail closed for relocated/different/modified executable code.
        const signatures = [
            ['step-condition', 0x546280, '538bd1d9423056dc42208d72208d5a4057dc13dfe0f6c441752480ba82000000'],
            ['time-accessor', 0x546420, '6a07e8c98aefff83c404c3'],
            ['manager-table', 0x43eef0, '558bec8b45088b048560e6c2005dc3'],
            ['constructor-vtable', 0x546457, 'c7067832b100'],
            ['last-loop-store', 0x55d036, '8935e816c300'],
            ['last-loop-zero-reset', 0x55be10, '891de816c300'],
            ['frame-increment', 0x55d2ed, 'ff05d0f3c200'],
            ['in-progress-clear', 0x55d323, 'c605f416c30000'],
            ['vtable-first-four-slots', 0xb13278, 'a06454009063540000596c00f0655400'],
        ];
        result.signatureChecks = [];
        for (const [name, address, expected] of signatures) {
            const observed = hexBytes(address, expected.length / 2);
            result.signatureChecks.push({name, address, expected, observed, match: expected === observed});
            if (observed !== expected) throw Error('Original symbol fingerprint mismatch: ' + name);
        }
        for (const [a, n] of [[0xc316e8, 4], [0xc2f3d0, 4], [0xc316f4, 1], [0xc2e67c, 4]]) valid(a, n);
        const guards = () => ({
            frameCounter: u32(0xc2f3d0),
            inProgress: read(0xc316f4, 1)[0],
            timeManagerPointer: u32(0xc2e67c),
            lastLoopCount: u32(0xc316e8),
        });
        result.before = guards();
        const pointer = result.before.timeManagerPointer;
        const objectBytes = read(pointer, 0xd0), objectView = new DataView(objectBytes.buffer);
        const vtable = objectView.getUint32(0, true);
        result.object = {pointer, validatedBytes: 0xd0, vtable, expectedVtable: 0xb13278};
        if (vtable !== 0xb13278) throw Error('TimeManager object vtable mismatch');
        const float = (offset, size) => {
            const value = size === 8 ? objectView.getFloat64(offset, true) : objectView.getFloat32(offset, true);
            return {offset, address: pointer + offset, value: Number.isFinite(value) ? value : String(value),
                finite: Number.isFinite(value), rawLE: Array.from(objectBytes.subarray(offset, offset + size), b => b.toString(16).padStart(2, '0')).join('')};
        };
        result.fields = {
            time20: float(0x20, 8), previous28: float(0x28, 8), step30: float(0x30, 4),
            target40: float(0x40, 8), special82: {offset: 0x82, address: pointer + 0x82, value: objectView.getUint8(0x82)},
        };
        result.after = guards();
        result.object.vtableAfter = u32(pointer);
        result.guardsStable = JSON.stringify(result.before) === JSON.stringify(result.after)
            && result.object.vtableAfter === vtable && (cpu.cr[0] >>> 0) === cr0
            && (cpu.cr[3] >>> 0) === cr3 && (cpu.cr[4] >>> 0) === cr4;
        if (!result.guardsStable) throw Error('Guest counters/pointer/vtable changed while reading');
        // Report thread ownership, not a fabricated hot-loop attribution.
        const s = sys.scheduler, t1 = s?.threads?.get(1);
        const current = Number.isInteger(s?.currentThreadId) ? s.currentThreadId : null;
        const live = current === 1 && t1?.state === 2;
        const ip = live ? cpu?.instruction_pointer?.[0] : t1?.context?.eip;
        result.t1 = {currentThreadId: current, state: t1?.state ?? null,
            eip: typeof ip === 'number' ? ip >>> 0 : null,
            source: live ? 'live-current-running' : t1?.context ? 'saved-resume-location-NOT-hot-PC' : 'unavailable'};
        result.available = true;
    } catch (error) {
        result.error = String(error?.message ?? error);
    }
    result.collectionMs = performance.now() - startedMs;
    return result;
}

export function timeManagerStep(label = '') {
    return {cmd: 'evalWorker', args: [`return (${captureTimeManager.toString()})(System, ${JSON.stringify(String(label).slice(0, 64))});`]};
}

// Main supplies its EXISTING page/harness executor. This helper has no CDP,
// target creation, input, pause/resume or browser lifecycle logic. Timers live
// on the host caller, never inside evalWorker. Do not call during an FPS arm.
export async function sampleTimeManager(runSteps, {count = 8, intervalMs = 1000} = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 16
        || !Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 2000)
        throw Error('Require count 1..16 and intervalMs 250..2000');
    const samples = [];
    for (let i = 0; i < count; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, intervalMs));
        const requestedMs = performance.now();
        const reply = await runSteps([timeManagerStep('time-manager-' + i)]);
        const step = reply?.steps?.[0];
        if (!reply?.ok || !step?.ok) throw Error('Existing harness rejected timing snapshot');
        samples.push({requestedMs, receivedMs: performance.now(), snapshot: step.result});
        if (!step.result?.available) break; // Retain failure; never guess addresses.
    }
    return {samples, notFPSBenchmark: true, lastLoopCountAggregation: 'NONE',
        note: 'Sparse diagnostic observations only; no all-frame histogram, total-update count, or busy-spin fraction.'};
}
