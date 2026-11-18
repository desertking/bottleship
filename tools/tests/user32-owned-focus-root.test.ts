import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';
import { resolveForegroundTargets, resetPostedActivations } from '../../src/worker/modules/user32/activation-messages';
import { createWindowExports } from '../../src/worker/modules/user32/window';

const OWNER = 0x76500, FORM = OWNER + 1, CHILD = OWNER + 2, GRANDCHILD = OWNER + 3;
const CHILD_STYLE = 0x40000000;
let saved: Record<string, unknown>, active: number, focus: number, posts: number[][];
const handles = [OWNER, FORM, CHILD, GRANDCHILD];
beforeEach(() => {
    active = FORM; focus = FORM; posts = [];
    const wm = System.getInstance().windowManager as any;
    saved = {};
    for (const name of ['getWindow', 'getActiveHwnd', 'getFocusHwnd', 'setActiveWindow', 'setFocus', 'postMessage', 'removePostedMessages']) saved[name] = wm[name];
    wm.getWindow = (h: number) => windows.get(h);
    wm.getActiveHwnd = () => active;
    wm.getFocusHwnd = () => focus;
    wm.setActiveWindow = (h: number) => { const prior = active; active = h; return prior; };
    wm.setFocus = (h: number) => { const prior = focus; focus = h; return prior; };
    wm.postMessage = (...args: number[]) => { posts.push(args); };
    wm.removePostedMessages = () => 0;
    for (let i = 0; i < handles.length; i++) {
        const h = handles[i]!;
        windows.set(h, { handle: h, title: 'focus fixture', style: 0x10000000 | (i >= 2 ? CHILD_STYLE : 0x80000000),
            parent: i ? handles[i - 1] : 0, visible: true, wndProc: 0x401000 + i * 4,
            activationDelivered: true, children: [], x: 0, y: 0, width: 320, height: 200, userData: 0 } as WindowInfo);
    }
    resetPostedActivations();
});
afterEach(() => {
    Object.assign(System.getInstance().windowManager, saved);
    for (const h of handles) windows.delete(h);
    resetPostedActivations();
});

test('child of an owned top-level activates its parent form, not the form owner', () => {
    expect(resolveForegroundTargets(CHILD)).toEqual({ topLevel: FORM, focusHwnd: CHILD });
});
test('nested children stop at their first top-level even when it has an owner', () => {
    expect(resolveForegroundTargets(GRANDCHILD)).toEqual({ topLevel: FORM, focusHwnd: GRANDCHILD });
});
test('an owned top-level remains its own activation target', () => {
    expect(resolveForegroundTargets(FORM)).toEqual({ topLevel: FORM, focusHwnd: FORM });
});
test('ordinary unowned parent chains and null keep their existing targets', () => {
    windows.get(FORM)!.parent = 0;
    expect(resolveForegroundTargets(GRANDCHILD)).toEqual({ topLevel: FORM, focusHwnd: GRANDCHILD });
    expect(resolveForegroundTargets(0)).toEqual({ topLevel: 0, focusHwnd: 0 });
});
test('SetFocus inside an active owned form does not queue its deactivation', () => {
    const result = createWindowExports().SetFocus!({} as never, new Uint8Array(0), [GRANDCHILD] as never);
    expect(result).toBe(FORM);
    expect(focus).toBe(GRANDCHILD);
    expect(active).toBe(FORM);
    expect(posts.filter(p => p[1] === 6)).toEqual([]);
});
test('SetFocus in an inactive owned form activates that form rather than its owner', () => {
    active = OWNER; focus = OWNER;
    createWindowExports().SetFocus!({} as never, new Uint8Array(0), [CHILD] as never);
    expect(active).toBe(FORM);
    expect(focus).toBe(CHILD);
    expect(posts.filter(p => p[1] === 6).map(p => p.slice(0, 3))).toEqual([[OWNER, 6, 0], [FORM, 6, 1]]);
});
test('SetForegroundWindow child resolution also excludes the owner chain', () => {
    active = OWNER;
    expect(createWindowExports().SetForegroundWindow!({} as never, new Uint8Array(0), [GRANDCHILD] as never)).toBe(1);
    expect(active).toBe(FORM);
    expect(posts.filter(p => p[1] === 6).map(p => p.slice(0, 3))).toEqual([[OWNER, 6, 0], [FORM, 6, 1]]);
});
