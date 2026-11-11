import { expect, test } from "bun:test";
import { glRing, fbits, type GLRing } from "./helpers/gl-ring-harness";
import { CMD_I32, CMD_F32 } from "../../src/worker/modules/opengl32/context";

type Step = [string, ...number[]];
type Batch = { ring: Step[]; trap: Step[] };

function snapshot(r: GLRing) {
    const cmds = r.ctx.commands as any;
    return {
        i32: Array.from(cmds.i32.subarray(0, cmds.count * CMD_I32)),
        f32: Array.from(cmds.f32.subarray(0, cmds.count * CMD_F32)),
        types: Array.from({ length: cmds.count }, (_, i) => cmds.typeAt(i)),
        verts: Array.from(r.ctx.vertArena.data.subarray(0, r.ctx.vertArena.used)),
        draws: r.ctx.frameSnapshot.drawCalls,
        hint: r.ctx.drawMergeHint,
    };
}

function play(useRun: boolean, batches: Batch[]) {
    const r = glRing(useRun);
    r.ctx.renderMode = 0x1C00;
    for (const b of batches) {
        for (const [name, ...args] of b.ring) r.put(name, ...args);
        r.drain();
        for (const [name, ...args] of b.trap) r.gl[name]!(null as any, r.mem, args);
    }
    return snapshot(r);
}

function rng(seed: number) {
    return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
}

const STATE: Array<(n: () => number) => Step> = [
    n => ["glBindTexture", 0x0DE1, 1 + ((n() * 3) | 0)],
    n => [n() < 0.5 ? "glEnable" : "glDisable", 0x0DE1],
    n => [n() < 0.5 ? "glEnable" : "glDisable", 0x0BE2],
    n => [n() < 0.5 ? "glEnable" : "glDisable", 0x0B44],
    n => ["glBlendFunc", 0x0302 + ((n() * 2) | 0), 0x0303],
    n => ["glDepthFunc", 0x0201 + ((n() * 3) | 0)],
    n => ["glTexEnvi", 0x2300, 0x2200, n() < 0.5 ? 0x2100 : 0x1E01],
    n => ["glShadeModel", n() < 0.5 ? 0x1D00 : 0x1D01],
    n => ["glDepthMask", (n() * 2) | 0],
];

function frame(next: () => number): Batch[] {
    const out: Batch[] = [];
    let ring: Step[] = [];
    const f = () => fbits(Math.round((next() * 20 - 10) * 8) / 8);
    for (let q = 0; q < 60; q++) {
        if (next() < 0.25) ring.push(STATE[(next() * STATE.length) | 0]!(next));
        if (next() < 0.5) ring.push(["glPushMatrix"]);
        if (next() < 0.5) ring.push(["glTranslatef", f(), f(), f()]);
        ring.push(["glBegin", next() < 0.8 ? 7 : 4]);
        const n = next() < 0.8 ? 4 : 3;
        for (let v = 0; v < n; v++) {
            if (next() < 0.3) ring.push(["glColor4f", f(), f(), f(), f()]);
            ring.push(["glTexCoord2f", f(), f()]);
            ring.push(["glVertex3f", f(), f(), f()]);
        }
        ring.push(["glEnd"]);
        if (next() < 0.5) ring.push(["glPopMatrix"]);
        if (next() < 0.15) {
            const trap: Step[] = next() < 0.6 ? [STATE[(next() * STATE.length) | 0]!(next)] : [];
            out.push({ ring, trap });
            ring = [];
        }
    }
    out.push({ ring, trap: [] });
    return out;
}

test("the run consumer's merge memo produces the same command stream as a full state compare", () => {
    let merged = 0;
    for (let seed = 1; seed <= 80; seed++) {
        const fr = frame(rng(seed));
        const a = play(true, fr);
        const b = play(false, fr);
        expect(a).toEqual(b);
        merged += 60 - a.draws;
        expect(a.hint).toBe(-2);
    }
    expect(merged).toBeGreaterThan(1000);
});

test("a state change on the trap path between two drains is never merged across", () => {
    const quad = (z: number): Step[] => [
        ["glBegin", 7],
        ["glVertex3f", fbits(0), fbits(0), fbits(z)], ["glVertex3f", fbits(1), fbits(0), fbits(z)],
        ["glVertex3f", fbits(1), fbits(1), fbits(z)], ["glVertex3f", fbits(0), fbits(1), fbits(z)],
        ["glEnd"],
    ];
    const batches: Batch[] = [
        { ring: [...quad(0), ...quad(1)], trap: [["glBlendFunc", 0x0302, 0x0303]] },
        { ring: quad(2), trap: [] },
    ];
    const a = play(true, batches);
    expect(a).toEqual(play(false, batches));
    expect(a.draws).toBe(2);
});
