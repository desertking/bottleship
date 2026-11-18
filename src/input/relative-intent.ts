// "The guest wants a relative mouse" — the faithful signal, kept separate from how
// the host delivers it.
//
// Confinement, an exclusive-mode DirectInput mouse, or repeated re-centring claim
// the relative transport. USER32 cursor visibility is kept as diagnostic state:
// ShowCursor/SetCursor(NULL) also serve absolute-input applications drawing their
// own cursor, so hiding alone must not grab the host pointer.
//
// The transport is a separate decision: Pointer Lock for a real mouse, finger deltas
// for a touch screen — which has no Pointer Lock at all.

export type RelativeSignal = "cursorHidden" | "clipped" | "captured" | "warping";

type Listener = (active: boolean) => void;

class RelativeIntent {
    private readonly signals: Record<RelativeSignal, boolean> = {
        cursorHidden: false,
        clipped: false,
        captured: false,
        warping: false,
    };
    private active = false;
    /** A host dialog owns the pointer; the guest's claim waits until it is closed. */
    private held = false;
    private readonly listeners = new Set<Listener>();

    private update(): void {
        const next = !this.held && (this.signals.clipped
            || this.signals.captured || this.signals.warping);
        if (next === this.active) return;
        this.active = next;
        for (const fn of this.listeners) fn(next);
    }

    set(signal: RelativeSignal, value: boolean): void {
        if (this.signals[signal] === value) return;
        this.signals[signal] = value;
        this.update();
    }

    /**
     * A host-side modal (the guest's MessageBox rendered as a page dialog) needs the real
     * pointer: under Pointer Lock every click goes to the canvas and the dialog cannot be
     * answered. While held the store reads inactive whatever the guest signals; the signals
     * keep updating underneath and take effect again on release.
     */
    setHostHold(held: boolean): void {
        if (this.held === held) return;
        this.held = held;
        this.update();
    }

    get(): boolean {
        return this.active;
    }

    /** Which signals are asserting, for diagnostics. */
    reasons(): RelativeSignal[] {
        return (Object.keys(this.signals) as RelativeSignal[]).filter((k) => this.signals[k]);
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    /** Game switch: the next title starts with no relative-mouse claim. */
    reset(): void {
        for (const k of Object.keys(this.signals) as RelativeSignal[]) this.signals[k] = false;
        this.update();
    }
}

export const relativeIntent = new RelativeIntent();
