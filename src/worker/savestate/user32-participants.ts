import { System } from '../core/system';
import { savestateParticipants } from './participant';
import type { SaveValue } from './value-codec';
import { captureUser32Shared, restoreUser32Shared, type User32SharedState } from '../modules/user32/shared-state';
import { captureUser32Classes, restoreUser32Classes, type User32ClassState } from '../modules/user32/class';
import { capturePaintRegions, restorePaintRegions } from '../modules/user32/paint-region';

const save = (v: unknown) => v as SaveValue;
const as = <T>(v: SaveValue) => v as unknown as T;

export function registerUser32Participants(): void {
    savestateParticipants.add({
        id: 'window-manager', version: 1, order: 30,
        capture: () => save(System.getInstance().windowManager.captureState()),
        restore: (s) => System.getInstance().windowManager.restoreState(as(s)),
    });
    savestateParticipants.add({
        id: 'user32-windows', version: 1, order: 31,
        capture: () => save(captureUser32Shared()),
        restore: (s) => restoreUser32Shared(as<User32SharedState>(s)),
    });
    savestateParticipants.add({
        id: 'user32-classes', version: 1, order: 32,
        capture: () => save(captureUser32Classes()),
        restore: (s) => restoreUser32Classes(as<User32ClassState>(s)),
    });
    savestateParticipants.add({
        id: 'user32-paint-regions', version: 1, order: 33,
        capture: () => save(capturePaintRegions()),
        restore: (s) => restorePaintRegions(as<Array<[number, never[], boolean]>>(s)),
    });
}
