import { expect, test } from "bun:test";
import { DDrawPresenter } from "../../src/worker/modules/ddraw/presenter";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

function presenterWithDrawLog() {
    const presenter = Object.create(DDrawPresenter.prototype) as any;
    Object.assign(presenter, {
        presentCallCount: 0, pendingSurface: null, pendingOptions: null, pendingResolvers: [],
        pumpRunning: false, pumpQueued: false, settleTimer: null, firstSettlingAt: 0,
    });
    const drawn: Array<{ options: unknown; at: number }> = [];
    presenter.drawFrame = async (_surface: unknown, options: unknown) => { drawn.push({ options, at: performance.now() }); };
    return { presenter: presenter as DDrawPresenter, drawn };
}

const primary = { surfacePtr: 0x1000 } as DirectDrawSurfaceState;
const mem = new Uint8Array(0);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("implicit primary presents spread over several slices collapse into one draw of the final state", async () => {
    const { presenter, drawn } = presenterWithDrawLog();
    const all = [presenter.present(primary, mem, { throttle: true, frameAlreadyMarked: true })];
    await sleep(1);
    all.push(presenter.present(primary, mem, { throttle: true }));
    await sleep(1);
    all.push(presenter.present(primary, mem, { throttle: true }));
    expect(drawn).toHaveLength(0);
    await Promise.all(all);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.options).toEqual({ throttle: true });
});

test("a continuous writer is still drawn at least every max-hold interval", async () => {
    const { presenter, drawn } = presenterWithDrawLog();
    const t0 = performance.now();
    while (performance.now() - t0 < 120) {
        void presenter.present(primary, mem, { throttle: true });
        await sleep(2);
    }
    await sleep(30);
    expect(drawn.length).toBeGreaterThanOrEqual(3);
});

test("an explicit present (Flip) is drawn at the end of the slice and absorbs pending implicit ones", async () => {
    const { presenter, drawn } = presenterWithDrawLog();
    void presenter.present(primary, mem, { throttle: true });
    const flip = presenter.present(primary, mem, { throttle: false });
    await flip;
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.options).toEqual({ throttle: false });
    await sleep(30);
    expect(drawn).toHaveLength(1);
});

test("an implicit present is not drawn while the primary is still locked", async () => {
    const { presenter, drawn } = presenterWithDrawLog();
    const surface = { surfacePtr: 0x1000, activeLeaseId: 3 } as unknown as DirectDrawSurfaceState & { activeLeaseId?: number };
    void presenter.present(surface, mem, { throttle: true });
    await sleep(10);
    expect(drawn).toHaveLength(0);
    surface.activeLeaseId = undefined;
    await sleep(10);
    expect(drawn).toHaveLength(1);
});
