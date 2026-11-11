import { describe, expect, test, afterEach } from 'bun:test';
import { paintClipNeeded } from '../../src/worker/modules/user32/paint-region';

const g = globalThis as { __paintFullClipSkip?: boolean };

describe('BeginPaint canvas clip', () => {
    afterEach(() => { delete g.__paintFullClipSkip; });

    test('an update region covering the whole surface needs no canvas clip', () => {
        expect(paintClipNeeded({ left: 0, top: 0, right: 640, bottom: 480 }, 640, 480)).toBe(false);
        expect(paintClipNeeded({ left: -4, top: -4, right: 700, bottom: 500 }, 640, 480)).toBe(false);
    });

    test('a partial update region is clipped', () => {
        expect(paintClipNeeded({ left: 10, top: 0, right: 640, bottom: 480 }, 640, 480)).toBe(true);
        expect(paintClipNeeded({ left: 0, top: 0, right: 639, bottom: 480 }, 640, 480)).toBe(true);
        expect(paintClipNeeded({ left: 0, top: 0, right: 640, bottom: 100 }, 640, 480)).toBe(true);
    });

    test('switch off restores the unconditional clip', () => {
        g.__paintFullClipSkip = false;
        expect(paintClipNeeded({ left: 0, top: 0, right: 640, bottom: 480 }, 640, 480)).toBe(true);
    });
});
