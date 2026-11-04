import { useCallback, useEffect, useRef, useState } from "react";
import {
    SavestateError, exportFile, getRecord, importFile, packSavestate, savedMeta, storeSavestate, unpackSavestate,
    type StoredMeta,
} from "./savestate-store";
import s from "./SavestateBar.module.css";

interface Reply { type: string; id: number; ok: boolean; error?: string; meta?: any; state?: ArrayBuffer; identity?: { gameId: string; engine: string } }

const ERROR_TEXT: Record<string, string> = {
    'too-big': "Spielzustand ist zu groß. Bisherige Sicherung bleibt erhalten.",
    'packed-too-big': "Komprimierter Spielstand ist zu groß.",
    quota: "Zu wenig Browserspeicher. Bisherige Sicherung bleibt erhalten; neuen Stand herunterladen.",
    checksum: "Der Spielstand ist beschädigt (Prüfsumme).",
    mismatch: "Dieser Spielstand gehört zu einem anderen Spiel oder einer anderen Version.",
    format: "Dieser Spielstand gehört zu einem anderen Spiel oder einer anderen Version.",
    none: "Keine passende Sicherung vorhanden.",
    file: "Die Datei ist kein BottleShip-Spielstand.",
    busy: "Das Spiel ist gerade beschäftigt. Bitte Tasten loslassen und erneut speichern.",
    storage: "Browserspeicher nicht verfügbar.",
};

let nextId = 1;

function request(worker: Worker, message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
            const data = event.data as Reply;
            if (data?.type !== 'savestate_result' || data.id !== id) return;
            worker.removeEventListener('message', onMessage);
            if (data.ok) resolve(data); else reject(new SavestateError((data.error as SavestateError['code']) ?? 'storage', data.error));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ ...message, id }, transfer);
    });
}

const errorText = (err: unknown): string =>
    ERROR_TEXT[(err as SavestateError)?.code ?? (err as Error)?.message] ?? `Fehler: ${(err as Error)?.message ?? String(err)}`;

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1).replace('.', ',');

export function SavestateBar({ worker }: { worker: Worker | null }) {
    const [identity, setIdentity] = useState<{ gameId: string; engine: string } | null>(null);
    const [current, setCurrent] = useState<StoredMeta | null>(null);
    const [previous, setPrevious] = useState<StoredMeta | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [panel, setPanel] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const refresh = useCallback(async (id = identity) => {
        if (!id) return;
        setCurrent(await savedMeta(id.gameId, id.engine, 'current'));
        setPrevious(await savedMeta(id.gameId, id.engine, 'previous'));
    }, [identity]);

    useEffect(() => {
        if (!worker) return;
        let cancelled = false;
        const ask = async () => {
            try {
                const reply = await request(worker, { type: 'savestate_identity' });
                if (!cancelled && reply.identity?.gameId) { setIdentity(reply.identity); void refresh(reply.identity); return; }
            } catch { /* engine not ready yet */ }
            if (!cancelled) setTimeout(ask, 2000);
        };
        void ask();
        return () => { cancelled = true; };
    }, [worker]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!busy) return;
        const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [busy]);

    const save = async () => {
        if (!worker || !identity || busy) return;
        setBusy(true);
        setStatus("Spielstand wird gesichert – bitte diesen Tab geöffnet lassen.");
        try {
            const reply = await request(worker, { type: 'savestate_capture' });
            const record = await packSavestate(reply.meta, reply.state!);
            await storeSavestate(record);
            await refresh();
            setStatus(`Gespeichert · ${new Date(record.meta.createdAt).toLocaleTimeString('de-DE')} · ${mb(record.meta.packedBytes)} MB · nur in diesem Browser.`);
        } catch (err) {
            setStatus(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const load = async (slot: 'current' | 'previous') => {
        if (!worker || !identity || busy) return;
        if (!window.confirm("Ungespeicherte Änderungen werden verworfen. Diesen Spielstand laden?")) return;
        setBusy(true);
        setStatus("Spielstand wird wiederhergestellt …");
        try {
            const record = await getRecord(identity.gameId, identity.engine, slot);
            const raw = await unpackSavestate(record, identity.gameId, identity.engine);
            await request(worker, { type: 'savestate_restore', meta: record.meta, state: raw }, [raw]);
            setStatus(`Geladen · Stand vom ${new Date(record.meta.createdAt).toLocaleString('de-DE')}.`);
        } catch (err) {
            setStatus(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const download = async () => {
        if (!identity) return;
        try {
            const record = await getRecord(identity.gameId, identity.engine, 'current');
            const url = URL.createObjectURL(exportFile(record));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${identity.gameId}-${new Date(record.meta.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.bssave`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
            setStatus(errorText(err));
        }
    };

    const importChosen = async (file: File | undefined) => {
        if (!file || !identity) return;
        try {
            const record = await importFile(file);
            if (record.meta.gameId !== identity.gameId || record.meta.engine !== identity.engine) throw new SavestateError('mismatch');
            if (current && !window.confirm("Aktuellen gespeicherten Stand ersetzen? Er bleibt als vorherige Sicherung erhalten.")) return;
            await storeSavestate(record);
            await refresh();
            setStatus("Spielstand importiert. Mit „Laden“ fortsetzen.");
        } catch (err) {
            setStatus(errorText(err));
        } finally {
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    if (!worker || !identity) return null;
    return (
        <span className={s.bar}>
            <button className={s.btn} disabled={busy} onClick={() => void save()}>Speichern</button>
            <button className={s.btn} disabled={busy || !current} onClick={() => void load('current')}>Laden</button>
            <button className={s.btn} disabled={busy} onClick={() => setPanel(p => !p)}>Sicherungen</button>
            {status && <span className={s.status}>{status}</span>}
            {panel && (
                <span className={s.panel}>
                    <button className={s.btn} disabled={busy || !current} onClick={() => void download()}>Herunterladen</button>
                    <button className={s.btn} disabled={busy} onClick={() => fileRef.current?.click()}>Datei importieren</button>
                    <button className={s.btn} disabled={busy || !previous} onClick={() => void load('previous')}>Vorherigen Stand laden</button>
                    <button className={s.btn} onClick={() => setPanel(false)}>Schließen</button>
                    <input ref={fileRef} type="file" accept=".bssave" hidden onChange={e => void importChosen(e.target.files?.[0])} />
                </span>
            )}
        </span>
    );
}
