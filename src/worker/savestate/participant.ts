import type { SaveValue } from './value-codec';

export interface CaptureContext {
    ref(obj: unknown, where: string): number;
}

export interface RestoreContext {
    object(ref: number): unknown;
}

export type FieldPolicy = 'save' | 'derive' | 'host' | 'transient';

export interface Participant {
    readonly id: string;
    readonly version: number;
    readonly order?: number;
    capture(ctx: CaptureContext): SaveValue;
    restore(state: SaveValue, ctx: RestoreContext): void | Promise<void>;
}

type SavedKeys<T, P extends Record<keyof T, FieldPolicy>> = { [K in keyof T]: P[K] extends 'save' ? K : never }[keyof T];

export function pickSaved<T, P extends Record<keyof T, FieldPolicy>>(
    record: T, policy: P,
): Pick<T, SavedKeys<T, P>> {
    const out = {} as Pick<T, SavedKeys<T, P>>;
    for (const key of Object.keys(policy) as (keyof T)[]) {
        if (policy[key] === 'save') (out as Record<keyof T, unknown>)[key] = record[key];
    }
    return out;
}

export class ParticipantRegistry {
    private readonly list: Participant[] = [];

    add(participant: Participant): () => void {
        const at = this.list.findIndex(p => p.id === participant.id);
        if (at >= 0) this.list[at] = participant;
        else this.list.push(participant);
        return () => {
            const i = this.list.indexOf(participant);
            if (i >= 0) this.list.splice(i, 1);
        };
    }

    all(): readonly Participant[] {
        return [...this.list].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    }

    versions(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const p of this.list) out[p.id] = p.version;
        return out;
    }
}

/** @transient(behaviour, not data: owners add their participant when they are created) */
export const savestateParticipants = new ParticipantRegistry();
