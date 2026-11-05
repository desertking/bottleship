import { expect, test } from "bun:test";
import { glRing, fbits, type GLRing } from "./helpers/gl-ring-harness";
import { CMD_I32, CMD_F32 } from "../../src/worker/modules/opengl32/context";

type Step = [string, ...number[]];

function snapshot(r: GLRing) {
    const c = r.ctx;
    const cmds = c.commands as any;
    return {
        i32: Array.from(cmds.i32.subarray(0, cmds.count * CMD_I32)),
        f32: Array.from(cmds.f32.subarray(0, cmds.count * CMD_F32)),
        types: Array.from({ length: cmds.count }, (_, i) => cmds.typeAt(i)),
        verts: Array.from(c.vertArena.data.subarray(0, c.vertArena.used)),
        color: Array.from(c.currentColor),
        normal: Array.from(c.currentNormal),
        tex: c.currentTexCoord.map(t => Array.from(t)),
        mv: Array.from(c.modelviewStack.stack[c.modelviewStack.top]!),
        mvTop: c.modelviewStack.top,
        error: c.error,
        immediate: [c.immediateMode, c.immediatePrimMode, c.immediateFlatCount],
        compiled: JSON.stringify(c.compilingCommands),
        cull: c.enableFlags.has(0x0B44),
        draws: c.frameSnapshot.drawCalls,
        foreign: r.foreign,
    };
}

function play(useRun: boolean, steps: Step[][], before?: (r: GLRing) => void) {
    const r = glRing(useRun);
    r.ctx.renderMode = 0x1C00;
    before?.(r);
    for (const batch of steps) {
        for (const [name, ...args] of batch) r.put(name, ...args);
        r.drain();
    }
    return snapshot(r);
}

function rng(seed: number) {
    return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
}

function randomFrame(next: () => number): Step[][] {
    const batches: Step[][] = [];
    let batch: Step[] = [];
    const f = () => fbits(Math.round((next() * 20 - 10) * 8) / 8);
    const modes = [0x0007, 0x0004, 0x0005, 0x0006, 0x0009, 0x0001, 0x0003];
    for (let q = 0; q < 40; q++) {
        if (next() < 0.3) batch.push([next() < 0.5 ? "glDisable" : "glEnable", 0x0B44]);
        if (next() < 0.5) batch.push(["glPushMatrix"]);
        if (next() < 0.5) batch.push(["glTranslatef", f(), f(), f()]);
        if (next() < 0.1) batch.push(["glRotatef", f(), f(), f(), f()]);
        if (next() < 0.2) batch.push(["glColor4f", f(), f(), f(), f()]);
        if (next() < 0.1) batch.push(["glColor4ub", (next() * 0x1FF) | 0, 7, 0x180, 255]);
        if (next() < 0.05) batch.push(["glBegin", 7]);
        batch.push(["glBegin", modes[(next() * modes.length) | 0]!]);
        const n = 1 + ((next() * 9) | 0);
        for (let v = 0; v < n; v++) {
            const k = next();
            if (k < 0.15) batch.push(["glNormal3f", f(), f(), f()]);
            else if (k < 0.2) batch.push(["glNormal3fv", f(), f(), f()]);
            else if (k < 0.25) batch.push(["glColor3f", f(), f(), f()]);
            if (next() < 0.7) batch.push([next() < 0.5 ? "glTexCoord2f" : "glTexCoord2fv", f(), f()]);
            const w = next();
            batch.push(w < 0.6 ? ["glVertex3f", f(), f(), f()] : w < 0.8 ? ["glVertex3fv", f(), f(), f()] : ["glVertex2f", f(), f()]);
        }
        if (next() < 0.97) batch.push(["glEnd"]);
        if (next() < 0.5) batch.push(["glPopMatrix"]);
        if (next() < 0.1) { batches.push(batch); batch = []; }
    }
    batches.push(batch);
    return batches;
}

test("the GL run consumer applies a ring exactly like the per-entry handlers", () => {
    for (let seed = 1; seed <= 60; seed++) {
        const frame = randomFrame(rng(seed));
        expect(play(true, frame)).toEqual(play(false, frame));
    }
});

test("while a display list is compiling the run consumer declines and recording is unchanged", () => {
    const frame = randomFrame(rng(7));
    const compiling = (r: GLRing) => { r.ctx.compilingList = 5; r.ctx.compilingListMode = 0x1301; };
    const a = play(true, frame, compiling);
    expect(a).toEqual(play(false, frame, compiling));
    expect(JSON.parse(a.compiled).length).toBeGreaterThan(100);
});

test("a run stops at an entry the consumer does not own and resumes after it", () => {
    const steps: Step[][] = [[
        ["glBegin", 7],
        ["glTexCoord2f", fbits(0), fbits(1)], ["glVertex3f", fbits(1), fbits(2), fbits(3)],
        ["Foreign", 77],
        ["glTexCoord2f", fbits(1), fbits(1)], ["glVertex3f", fbits(4), fbits(5), fbits(6)],
        ["glVertex3f", fbits(7), fbits(8), fbits(9)], ["glVertex3f", fbits(1), fbits(1), fbits(1)],
        ["glEnd"],
    ]];
    const a = play(true, steps);
    expect(a).toEqual(play(false, steps));
    expect(a.verts.length).toBe(6 * 15);
    expect(a.foreign).toEqual([77, 1]);
});
