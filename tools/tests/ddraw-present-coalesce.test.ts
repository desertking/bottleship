import { expect, test } from "bun:test";
import { DDrawPresenter } from "../../src/worker/modules/ddraw/presenter";
import type { DirectDrawSurfaceState } from "../../src/worker/modules/ddraw/com-objects";

function presenterWithDrawLog() {
    const presenter = Object.create(DDrawPresenter.prototype) as any;
    Object.assign(presenter, {
        presentCallCount: 0, pendingSurface: null, pendingOptions: null, pendingResolvers: [],
        pumpRunning: false, pumpQueued: false,
    });
    const drawn: Array<{ surface: unknown; options: unknown }> = [];
    presenter.drawFrame = async (surface: unknown, options: unknown) => { drawn.push({ surface, options }); };
    return { presenter: presenter as DDrawPresenter, drawn };
}

test("presents issued within one guest slice collapse into one draw of the last state", async () => {
    const { presenter, drawn } = presenterWithDrawLog();
    const primary = { surfacePtr: 0x1000 } as DirectDrawSurfaceState;
    const mem = new Uint8Array(0);
    const all = [
        presenter.present(primary, mem, { throttle: true, frameAlreadyMarked: true }),
        presenter.present(primary, mem, { throttle: true }),
        presenter.present(primary, mem, { throttle: true }),
    ];
    expect(drawn).toHaveLength(0);
    await Promise.all(all);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.options).toEqual({ throttle: true });
});

test("a present after the slice returned is drawn again", async () => {
    const { presenter, drawn } = presenterWithDrawLog();
    const primary = { surfacePtr: 0x1000 } as DirectDrawSurfaceState;
    await presenter.present(primary, new Uint8Array(0));
    await presenter.present(primary, new Uint8Array(0));
    expect(drawn).toHaveLength(2);
});
