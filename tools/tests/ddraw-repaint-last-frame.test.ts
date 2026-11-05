/**
 * The display-rate loop draws live dialog rects onto the CURRENT swap texture, which is a
 * fresh, blank one each frame. A DirectDraw game that is not presenting while its modal is
 * up (Tiberian Sun only touches its single-buffered primary when something changes) must
 * have its last frame put back first, or the dialog floats on black.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { DDrawPresenter } from "../../src/worker/modules/ddraw/presenter";

function harness(lastPresented: unknown, blendEnabled = false) {
    const draws: unknown[][] = [];
    let submits = 0;
    const canvasTex = { width: 1600, height: 1200, createView: () => "canvas-view" };
    const webgpu = {
        kind: "webgpu",
        getDevice: () => ({ createCommandEncoder: () => ({ finish: () => "cmd" }) }),
        getQueue: () => ({ submit: () => { submits++; } }),
        getContext: () => ({ getCurrentTexture: () => canvasTex }),
        drawTexture: (...args: unknown[]) => { draws.push(args); },
    };
    const presenter = Object.create(DDrawPresenter.prototype) as any;
    Object.assign(presenter, { lastPresented, blendEnabled });
    const spy = spyOn(System, "getInstance").mockReturnValue({
        services: { render: { getBackend: () => webgpu } },
    } as never);
    try {
        presenter.repaintLastFrame();
    } finally {
        spy.mockRestore();
    }
    return { draws, submits, presenter };
}

describe("DDrawPresenter.repaintLastFrame", () => {
    test("re-presents the last frame onto the current canvas texture", () => {
        const { draws, submits } = harness({ view: "frame-view", width: 800, height: 600 });
        expect(submits).toBe(1);
        expect(draws.length).toBe(1);
        expect(draws[0][0]).toBe("frame-view");
        expect(draws[0][1]).toBe("canvas-view");
        expect(draws[0][8]).toEqual({ srcW: 800, srcH: 600, outW: 1600, outH: 1200, toCanvas: true });
    });
    test("does nothing before the first present", () => {
        const { draws, submits } = harness(null);
        expect(draws.length).toBe(0);
        expect(submits).toBe(0);
    });
    test("leaves phase-blend presentation to the interpolator", () => {
        const { draws } = harness({ view: "frame-view", width: 800, height: 600 }, true);
        expect(draws.length).toBe(0);
    });
    test("tells the loop its canvas survives between presents", () => {
        const { presenter } = harness(null);
        expect(presenter.retainsCanvasBetweenPresents).toBe(true);
    });
});
