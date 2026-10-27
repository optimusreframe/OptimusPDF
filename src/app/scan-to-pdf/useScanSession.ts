"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SCAN_SETTINGS, type ScanFilterMode, type ScanMode, type ScanPage, type ScanPageSource, type ScanSettings } from "@/lib/scan/types";
import type { QuadCorners } from "@/lib/scan/perspective";
import { forkedAsOf, lostPagesOf, resolveScanEngine, resolveScanStore, splitSpreadOf, suggestedFullName } from "@/app/scan-to-pdf/scanServices";
import {
  blankPageIds,
  canRedo,
  canUndo,
  clearFlag,
  duplicatePages,
  emptyState,
  insertPages,
  movePages,
  proposeName,
  removePages,
  renderKeyOf,
  replacePage,
  rotatePages,
  scanReducer,
  type ScanAction,
  sessionFromState,
  setAdjustOn,
  setCornersOn,
  setFilterOn,
  shiftPages,
  type QualityChipKind,
  type ScanState,
} from "@/app/scan-to-pdf/scanState";
import { composeIdSheet, splitSpreadFallback } from "@/app/scan-to-pdf/imageTools";
import { readScanPrefs, writeScanPrefs } from "@/app/scan-to-pdf/scanPrefs";
import { classifyImportFailure, mergeProblems, type ImportProblem } from "@/app/scan-to-pdf/importProblems";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";

/** Silencio (ms) tras el ultimo cambio antes de guardar; se guarda de inmediato si la pagina se oculta. */
export const AUTOSAVE_DELAY_MS = 500;
/** Lado (px) de la miniatura rapida que se pide al motor tras cada cambio de organizacion (`renderPage(..., {maxSide})`). */
export const QUICK_THUMB_SIDE = 480;

export type SaveStatus = "idle" | "saving" | "saved" | "unsaved" | "quota" | "unavailable" | "tooBig";

export type SavedSummary = { id: string; name: string; updatedAt: string; pageCount: number; thumb: Blob | null };

export type CaptureOutcome =
  | { kind: "pages"; ids: string[] }
  /** Identificacion: se guardo el anverso y falta el reverso. */
  | { kind: "id-front" }
  /** Identificacion: las dos caras ya son UNA hoja. */
  | { kind: "id-done"; id: string };

type Job = { lane: "high" | "low"; epoch: number; run: () => Promise<void> };

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function placeholder(blob: Blob, source: ScanPageSource, filter: ScanFilterMode, id = newId("p")): ScanPage {
  return {
    id,
    createdAt: new Date().toISOString(),
    source,
    original: blob,
    originalWidth: 0,
    originalHeight: 0,
    corners: null,
    rotation: 0,
    filter,
    adjust: { brightness: 0, contrast: 0 },
    processed: null,
    thumb: null,
    flags: {},
  };
}

export type UseScanSessionOptions = {
  language: "es" | "en";
  strings: ScanToPdfStrings;
  /** Anuncio a la region viva unica. */
  announce: (text: string) => void;
  /** Sin almacen persistente (pruebas de componentes que no lo necesitan) el guardado se omite. */
  autosave?: boolean;
};

export function useScanSession({ language, strings: s, announce, autosave = true }: UseScanSessionOptions) {
  const [state, setState] = useState<ScanState>(() => emptyState(newId("scan"), new Date(0).toISOString()));
  // El estado es la REFERENCIA (`stateRef`): cada accion se aplica al instante, asi dos acciones del mismo turno (varias fotos
  // seguidas, un cambio justo tras otro) se ven una a otra. `state` solo es su copia para pintar.
  const stateRef = useRef(state);
  const dispatchRef = useRef((action: ScanAction) => {
    const next = scanReducer(stateRef.current, action);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  });
  const sRef = useRef(s);
  const announceRef = useRef(announce);
  const languageRef = useRef(language);
  useEffect(() => {
    sRef.current = s;
    announceRef.current = announce;
    languageRef.current = language;
  });

  /* ---------------- cola de trabajos (una sola tarea a la vez) ---------------- */
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController>(new AbortController());
  const highRef = useRef<Job[]>([]);
  const lowRef = useRef<Job[]>([]);
  const runningRef = useRef(false);
  const analysisDirtyRef = useRef(false);
  const analysisQueuedRef = useRef(false);
  const [busyCount, setBusyCount] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current.abort();
    };
  }, []);

  const scheduleAnalysis = useCallback(() => {
    analysisDirtyRef.current = true;
  }, []);

  const pump = useCallback(() => {
      if (runningRef.current) return;
      runningRef.current = true;
      void (async () => {
        try {
          for (;;) {
            let job = highRef.current.shift() ?? lowRef.current.shift();
            if (!job && analysisDirtyRef.current && !analysisQueuedRef.current) {
              analysisDirtyRef.current = false;
              analysisQueuedRef.current = true;
              job = {
                lane: "low",
                epoch: epochRef.current,
                run: async () => {
                  analysisQueuedRef.current = false;
                  const ready = stateRef.current.pages.filter((page) => !stateRef.current.pendingIds.includes(page.id) && page.thumb);
                  if (ready.length === 0) return;
                  const flags = await resolveScanEngine().analyzeSession(ready);
                  if (mountedRef.current) dispatchRef.current({ type: "flags", flags });
                },
              };
            }
            if (!job) break;
            if (job.epoch !== epochRef.current) continue;
            try {
              await job.run();
            } catch {
              // Cada trabajo gestiona su propio fallo; la cola no se detiene por uno.
            }
            if (mountedRef.current) setBusyCount(highRef.current.length + lowRef.current.length);
          }
        } finally {
          runningRef.current = false;
          if (mountedRef.current) setBusyCount(0);
        }
      })();
  }, []);

  const enqueue = useCallback(
    (job: Omit<Job, "epoch">) => {
      const full: Job = { ...job, epoch: epochRef.current };
      (job.lane === "high" ? highRef : lowRef).current.push(full);
      setBusyCount(highRef.current.length + lowRef.current.length + (runningRef.current ? 1 : 0));
      pump();
    },
    [pump],
  );

  /* ---------------- miniaturas al dia ---------------- */
  /** Clave de renderizado con la que se calculo cada miniatura (por identidad del blob). Lo que no esta (carga, copia) se da por bueno. */
  const thumbKeys = useRef(new WeakMap<Blob, string>());
  /** Igual para el resultado COMPLETO (`processed`): solo se calcula al abrir el editor / la hoja y al crear el PDF. */
  const processedKeys = useRef(new WeakMap<Blob, string>());
  const queuedRenders = useRef(new Set<string>());
  const queuedFull = useRef(new Set<string>());

  useEffect(() => {
    for (const page of state.pages) {
      if (state.pendingIds.includes(page.id)) continue;
      const key = renderKeyOf(page);
      if (page.thumb) {
        const known = thumbKeys.current.get(page.thumb);
        if (known === undefined) {
          thumbKeys.current.set(page.thumb, key);
          continue;
        }
        if (known === key) continue;
      }
      if (queuedRenders.current.has(page.id)) continue;
      queuedRenders.current.add(page.id);
      const id = page.id;
      enqueue({
        lane: "high",
        run: async () => {
          queuedRenders.current.delete(id);
          const current = stateRef.current.pages.find((candidate) => candidate.id === id);
          if (!current || stateRef.current.pendingIds.includes(id)) return;
          const wanted = renderKeyOf(current);
          if (current.thumb && thumbKeys.current.get(current.thumb) === wanted) return;
          // Cambios de organizacion (girar, filtro, ajuste...): solo la miniatura rapida; el resultado completo queda por recalcular
          // (`processed: null`) hasta que se abra la pagina o se cree el PDF. Asi 100 paginas no recalculan 100 hojas completas.
          const out = await resolveScanEngine().renderPage(current, { signal: abortRef.current.signal, maxSide: QUICK_THUMB_SIDE });
          if (!mountedRef.current) return;
          if (out.thumb) thumbKeys.current.set(out.thumb, wanted);
          if (out.processed) processedKeys.current.set(out.processed, wanted);
          dispatchRef.current({ type: "rendered", id, key: wanted, processed: out.processed, thumb: out.thumb });
        },
      });
    }
  }, [state.pages, state.pendingIds, enqueue]);

  /* ---------------- aviso de orientacion automatica ---------------- */
  const [lostPages, setLostPages] = useState(0);
  const [orientationNotice, setOrientationNotice] = useState<{ ids: string[]; deltas: Record<string, number> } | null>(null);
  /** Fotos que no se pudieron anadir (por nombre y motivo); el aviso las lista y el resto de la lista sigue. */
  const [importProblems, setImportProblems] = useState<ImportProblem[]>([]);
  const reportImportProblems = useCallback((problems: ImportProblem[]) => {
    if (problems.length === 0) return;
    setImportProblems((current) => mergeProblems(current, problems));
    for (const problem of problems) announceRef.current(sRef.current.said.photoFailed(problem.name, problem.kind));
  }, []);
  const dismissImportProblems = useCallback(() => setImportProblems([]), []);

  /* ---------------- altas de paginas ---------------- */
  const createInto = useCallback(
    (pending: ScanPage, blob: Blob, source: ScanPageSource, mode: ScanMode, settings: ScanSettings, opts: { orient: boolean }) => {
      const epoch = epochRef.current;
      enqueue({
        lane: "high",
        run: async () => {
          let created: ScanPage;
          try {
            created = await resolveScanEngine().createPage(blob, { source, mode, settings, signal: abortRef.current.signal });
          } catch {
            if (epoch !== epochRef.current || !mountedRef.current) return;
            dispatchRef.current({ type: "discard", id: pending.id });
            reportImportProblems([classifyImportFailure(blob)]);
            return;
          }
          if (epoch !== epochRef.current || !mountedRef.current) return;
          if (created.thumb) thumbKeys.current.set(created.thumb, renderKeyOf({ ...created, id: pending.id }));
          if (created.processed) processedKeys.current.set(created.processed, renderKeyOf({ ...created, id: pending.id }));
          dispatchRef.current({ type: "resolve", id: pending.id, page: created });
          scheduleAnalysis();
          if (opts.orient && mode !== "photo") {
            enqueue({
              lane: "low",
              run: async () => {
                const current = stateRef.current.pages.find((page) => page.id === pending.id);
                if (!current || current.rotation !== 0) return;
                const rotation = await resolveScanEngine().detectOrientation(current, abortRef.current.signal);
                if (rotation === null || rotation === 0 || !mountedRef.current) return;
                const latest = stateRef.current.pages.find((page) => page.id === pending.id);
                if (!latest || latest.rotation !== 0) return;
                dispatchRef.current({ type: "commit", pages: rotatePages(stateRef.current.pages, [pending.id], rotation), label: sRef.current.labels.orientation });
                setOrientationNotice((previous) => ({
                  ids: [...(previous?.ids ?? []), pending.id],
                  deltas: { ...(previous?.deltas ?? {}), [pending.id]: rotation },
                }));
              },
            });
          }
        },
      });
    },
    [enqueue, scheduleAnalysis, reportImportProblems],
  );

  /** Anade fotos (importadas) en una posicion (por defecto al final). Devuelve los ids reservados. */
  const addBlobs = useCallback(
    (blobs: Blob[], opts: { source: ScanPageSource; at?: number; mode?: ScanMode; label?: string } = { source: "library" }): string[] => {
      if (blobs.length === 0) return [];
      const current = stateRef.current;
      const mode = opts.mode ?? current.settings.mode;
      const settings = { ...current.settings, mode };
      const holders = blobs.map((blob) => placeholder(blob, opts.source, mode === "photo" ? "original" : current.settings.defaultFilter));
      const at = opts.at ?? current.pages.length;
      dispatchRef.current({
        type: "commit",
        pages: insertPages(current.pages, at, holders),
        label: opts.label ?? sRef.current.labels.add,
        pending: holders.map((holder) => holder.id),
      });
      holders.forEach((holder, index) => createInto(holder, blobs[index], opts.source, mode, settings, { orient: true }));
      return holders.map((holder) => holder.id);
    },
    [createInto],
  );

  /* Identificacion: dos capturas -> UNA hoja */
  const idFrontRef = useRef<Blob | null>(null);
  const [idPending, setIdPending] = useState(false);

  const cancelIdFlow = useCallback(() => {
    idFrontRef.current = null;
    setIdPending(false);
  }, []);

  const addCapture = useCallback(
    async (blob: Blob, opts: { at?: number } = {}): Promise<CaptureOutcome> => {
      const current = stateRef.current;
      const mode = current.settings.mode;
      if (mode === "id-card") {
        if (!idFrontRef.current) {
          idFrontRef.current = blob;
          setIdPending(true);
          return { kind: "id-front" };
        }
        const front = idFrontRef.current;
        idFrontRef.current = null;
        setIdPending(false);
        const holder = placeholder(blob, "camera", "original");
        const at = opts.at ?? stateRef.current.pages.length;
        dispatchRef.current({ type: "commit", pages: insertPages(stateRef.current.pages, at, [holder]), label: sRef.current.labels.add, pending: [holder.id] });
        const epoch = epochRef.current;
        const settings = { ...current.settings, mode: "id-card" as const };
        enqueue({
          lane: "high",
          run: async () => {
            const engine = resolveScanEngine();
            try {
              const sideA = await engine.createPage(front, { source: "camera", mode: "id-card", settings, signal: abortRef.current.signal });
              const sideB = await engine.createPage(blob, { source: "camera", mode: "id-card", settings, signal: abortRef.current.signal });
              const sheet = await composeIdSheet(sideA.processed ?? sideA.original, sideB.processed ?? sideB.original);
              const created = await engine.createPage(sheet, {
                source: "camera",
                mode: "photo",
                settings: { ...settings, mode: "photo", defaultFilter: "original" },
                signal: abortRef.current.signal,
              });
              if (epoch !== epochRef.current || !mountedRef.current) return;
              if (created.thumb) thumbKeys.current.set(created.thumb, renderKeyOf({ ...created, id: holder.id }));
              if (created.processed) processedKeys.current.set(created.processed, renderKeyOf({ ...created, id: holder.id }));
              dispatchRef.current({ type: "resolve", id: holder.id, page: created });
              scheduleAnalysis();
            } catch {
              if (epoch !== epochRef.current || !mountedRef.current) return;
              dispatchRef.current({ type: "discard", id: holder.id });
              announceRef.current(sRef.current.said.createFailed);
            }
          },
        });
        return { kind: "id-done", id: holder.id };
      }
      if (mode === "book") {
        const holders = [placeholder(blob, "camera", current.settings.defaultFilter), placeholder(blob, "camera", current.settings.defaultFilter)];
        const at = opts.at ?? current.pages.length;
        dispatchRef.current({ type: "commit", pages: insertPages(current.pages, at, holders), label: sRef.current.labels.add, pending: holders.map((holder) => holder.id) });
        const epoch = epochRef.current;
        const settings = { ...current.settings, mode: "book" as const };
        enqueue({
          lane: "high",
          run: async () => {
            const engine = resolveScanEngine();
            const signal = abortRef.current.signal;
            try {
              let halves: ScanPage[] | null = null;
              // El motor parte la foto por el lomo (opcional del contrato: `splitSpread(page)`); sin el, o si falla, por el centro.
              const split = splitSpreadOf(engine);
              if (split) {
                try {
                  const whole = await engine.createPage(blob, { source: "camera", mode: "book", settings, signal });
                  halves = await split(whole, { signal });
                } catch {
                  halves = null;
                }
              }
              if (!halves || halves.length < 2) {
                const parts = await splitSpreadFallback(blob);
                halves = [];
                for (const part of parts ?? [blob, blob]) halves.push(await engine.createPage(part, { source: "camera", mode: "book", settings, signal }));
              }
              for (let index = 0; index < 2; index += 1) {
                if (epoch !== epochRef.current || !mountedRef.current) return;
                const created = halves[index];
                if (created.thumb) thumbKeys.current.set(created.thumb, renderKeyOf({ ...created, id: holders[index].id }));
                if (created.processed) processedKeys.current.set(created.processed, renderKeyOf({ ...created, id: holders[index].id }));
                dispatchRef.current({ type: "resolve", id: holders[index].id, page: created });
              }
              scheduleAnalysis();
            } catch {
              if (epoch !== epochRef.current || !mountedRef.current) return;
              for (const holder of holders) dispatchRef.current({ type: "discard", id: holder.id });
              announceRef.current(sRef.current.said.createFailed);
            }
          },
        });
        return { kind: "pages", ids: holders.map((holder) => holder.id) };
      }
      return { kind: "pages", ids: addBlobs([blob], { source: "camera", at: opts.at }) };
    },
    [addBlobs, enqueue, scheduleAnalysis],
  );

  /** Repetir captura: la pagina `id` se sustituye EN EL MISMO SITIO por la nueva foto. */
  const retake = useCallback(
    (id: string, blob: Blob, source: ScanPageSource = "camera") => {
      const current = stateRef.current;
      const old = current.pages.find((page) => page.id === id);
      if (!old) return;
      const holder = placeholder(blob, source, old.filter, id);
      dispatchRef.current({ type: "commit", pages: replacePage(current.pages, id, holder), label: sRef.current.labels.retake, pending: [id] });
      createInto(holder, blob, source, current.settings.mode, current.settings, { orient: true });
    },
    [createInto],
  );

  /* ---------------- organizacion ---------------- */
  const commit = useCallback((pages: ScanPage[], label: string, key?: string) => {
    dispatchRef.current({ type: "commit", pages, label, coalesce: key ? { key, at: Date.now() } : undefined });
  }, []);

  const removeIds = useCallback(
    (ids: string[], quiet = false) => {
      if (ids.length === 0) return;
      commit(removePages(stateRef.current.pages, ids), sRef.current.labels.remove);
      scheduleAnalysis();
      if (!quiet) announceRef.current(sRef.current.said.removed(ids.length));
    },
    [commit, scheduleAnalysis],
  );

  const rotateIds = useCallback(
    (ids: string[], delta: number, key?: string) => {
      if (ids.length === 0) return;
      commit(rotatePages(stateRef.current.pages, ids, delta), sRef.current.labels.rotate, key);
      announceRef.current(sRef.current.said.rotated(ids.length));
    },
    [commit],
  );

  const duplicateIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      commit(duplicatePages(stateRef.current.pages, ids, () => newId("p")), sRef.current.labels.duplicate);
      scheduleAnalysis();
      announceRef.current(sRef.current.said.duplicated(ids.length));
    },
    [commit, scheduleAnalysis],
  );

  const moveIds = useCallback(
    (ids: string[], insertBefore: number, key?: string) => {
      const before = stateRef.current.pages;
      const next = movePages(before, ids, insertBefore);
      if (next.every((page, index) => page === before[index])) return -1;
      commit(next, sRef.current.labels.move, key);
      return next.findIndex((page) => page.id === ids[0]) + 1;
    },
    [commit],
  );

  const shiftIds = useCallback(
    (ids: string[], delta: number, key?: string) => {
      const before = stateRef.current.pages;
      const next = shiftPages(before, ids, delta);
      if (next.every((page, index) => page === before[index])) return -1;
      commit(next, sRef.current.labels.move, key);
      return next.findIndex((page) => page.id === ids[0]) + 1;
    },
    [commit],
  );

  const applyFilter = useCallback(
    (ids: string[], filter: ScanFilterMode) => {
      commit(setFilterOn(stateRef.current.pages, ids, filter), sRef.current.labels.filter);
    },
    [commit],
  );

  const applyAdjust = useCallback(
    (ids: string[], brightness: number, contrast: number) => {
      commit(setAdjustOn(stateRef.current.pages, ids, { brightness, contrast }), sRef.current.labels.adjust);
    },
    [commit],
  );

  const applyCorners = useCallback(
    (id: string, corners: QuadCorners | null) => {
      commit(setCornersOn(stateRef.current.pages, id, corners), sRef.current.labels.crop);
      scheduleAnalysis();
    },
    [commit, scheduleAnalysis],
  );

  /** Copia filtro + brillo/contraste de la pagina `fromId` a todas las demas. */
  const applyToAll = useCallback(
    (fromId: string) => {
      const pages = stateRef.current.pages;
      const from = pages.find((page) => page.id === fromId);
      if (!from) return;
      const ids = pages.map((page) => page.id);
      commit(setAdjustOn(setFilterOn(pages, ids, from.filter), ids, from.adjust), sRef.current.labels.applyAll);
      announceRef.current(sRef.current.said.filterAll);
    },
    [commit],
  );

  const removeBlanks = useCallback(() => {
    const ids = blankPageIds(stateRef.current.pages);
    if (ids.length === 0) return 0;
    commit(removePages(stateRef.current.pages, ids), sRef.current.labels.blanks);
    announceRef.current(sRef.current.said.blanksRemoved(ids.length));
    return ids.length;
  }, [commit]);

  const dismissFlag = useCallback(
    (id: string, kind: QualityChipKind) => {
      commit(clearFlag(stateRef.current.pages, id, kind), sRef.current.labels.clear);
    },
    [commit],
  );

  const undoOrientation = useCallback(() => {
    setOrientationNotice((notice) => {
      if (!notice) return null;
      let pages = stateRef.current.pages;
      for (const id of notice.ids) pages = rotatePages(pages, [id], -(notice.deltas[id] ?? 0));
      dispatchRef.current({ type: "commit", pages, label: sRef.current.labels.orientation });
      return null;
    });
  }, []);

  const dismissOrientationNotice = useCallback(() => setOrientationNotice(null), []);

  const undo = useCallback(() => {
    const entry = stateRef.current.past[stateRef.current.past.length - 1];
    if (!entry) return;
    dispatchRef.current({ type: "undo" });
    scheduleAnalysis();
    announceRef.current(sRef.current.said.undone(entry.label));
  }, [scheduleAnalysis]);

  const redo = useCallback(() => {
    const entry = stateRef.current.future[0];
    if (!entry) return;
    dispatchRef.current({ type: "redo" });
    scheduleAnalysis();
    announceRef.current(sRef.current.said.redone(entry.label));
  }, [scheduleAnalysis]);

  /* ---------------- nombre y ajustes ---------------- */
  const setName = useCallback((name: string, edited = true) => dispatchRef.current({ type: "name", name, edited }), []);

  const setSettings = useCallback((patch: Partial<ScanSettings>) => {
    dispatchRef.current({ type: "settings", patch });
    const merged = { ...stateRef.current.settings, ...patch };
    writeScanPrefs(merged);
  }, []);

  // Preferencias recordadas: se leen una vez montado (el primer pintado del servidor y del cliente coinciden).
  useEffect(() => {
    const prefs = readScanPrefs();
    if (Object.keys(prefs).length > 0) dispatchRef.current({ type: "settings", patch: prefs });
  }, []);

  /** Propone el nombre (titulo reconocido + fecha, o «Escaneo fecha hora») si la persona no lo ha escrito. */
  const proposeNameNow = useCallback(async () => {
    const current = stateRef.current;
    if (current.nameEdited) return current.name;
    let suggestion = current.nameSuggested;
    try {
      suggestion = await resolveScanEngine().suggestName(
        current.pages.filter((page) => page.thumb),
        languageRef.current,
        abortRef.current.signal,
      );
    } catch {
      suggestion = current.nameSuggested;
    }
    if (!mountedRef.current) return current.name;
    dispatchRef.current({ type: "suggested", value: suggestion });
    const name = suggestedFullName(suggestion) ?? proposeName(suggestion, languageRef.current);
    dispatchRef.current({ type: "name", name, edited: false });
    return name;
  }, []);

  /* ---------------- guardado automatico ---------------- */
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const savingRef = useRef(false);
  const againRef = useRef(false);
  const lastSavedRev = useRef(0);
  const dirtyRef = useRef(false);
  const everHadPages = useRef(false);

  const flush = useCallback(async (): Promise<SaveStatus> => {
    if (!autosave) return "idle";
    if (savingRef.current) {
      againRef.current = true;
      return "saving";
    }
    savingRef.current = true;
    let result: SaveStatus = "saved";
    try {
      do {
        againRef.current = false;
        const snapshot = stateRef.current;
        const store = resolveScanStore();
        if (!store) {
          result = "unavailable";
          break;
        }
        if (mountedRef.current) setSaveStatus("saving");
        if (snapshot.pages.length === 0) {
          await store.remove(snapshot.id);
          result = "idle";
        } else {
          const outcome = await store.save(sessionFromState(snapshot, new Date().toISOString()));
          result = outcome.ok ? "saved" : outcome.reason === "quota" ? "quota" : outcome.reason === "tooBig" ? "tooBig" : "unavailable";
          // Otra pestana modifico esta sesion antes: la copia de esta se guardo con otro id y se sigue con el.
          const forked = outcome.ok ? forkedAsOf(outcome) : null;
          if (forked && forked !== stateRef.current.id) {
            dispatchRef.current({ type: "fork", id: forked });
            // La copia se distingue en Recientes (si no, dos filas identicas) y se avisa, una sola vez, de por que.
            const label = sRef.current.forkSuffix;
            const current = stateRef.current.name.trim();
            if (current !== "" && !current.endsWith(label)) dispatchRef.current({ type: "name", name: `${current} ${label}`, edited: true });
            announceRef.current(sRef.current.said.forked);
          }
        }
        lastSavedRev.current = snapshot.rev;
      } while (againRef.current || stateRef.current.rev !== lastSavedRev.current);
    } catch {
      result = "unavailable";
    } finally {
      savingRef.current = false;
    }
    dirtyRef.current = result !== "saved" && result !== "idle";
    if (mountedRef.current) setSaveStatus(result);
    return result;
  }, [autosave]);

  useEffect(() => {
    if (!autosave) return;
    if (state.pages.length > 0) everHadPages.current = true;
    if (state.pages.length === 0 && !everHadPages.current) return;
    if (state.rev === lastSavedRev.current) return;
    dirtyRef.current = true;
    setSaveStatus((current) => (current === "idle" ? "unsaved" : current === "saved" ? "unsaved" : current));
    const timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state.rev, state.pages.length, autosave, flush]);

  // La pagina se oculta (cambio de app en iOS, cierre): se guarda YA, sin esperar el silencio.
  useEffect(() => {
    if (!autosave) return;
    const onHide = () => {
      if (document.visibilityState === "hidden" && stateRef.current.rev !== lastSavedRev.current) void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide as EventListener);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide as EventListener);
    };
  }, [autosave, flush]);

  /* ---------------- sesiones guardadas ---------------- */
  const [saved, setSaved] = useState<SavedSummary | null>(null);
  const [savedFetched, setSavedFetched] = useState(false);
  const savedLoaded = !autosave || savedFetched;

  const refreshSaved = useCallback(async () => {
    const store = resolveScanStore();
    if (!store) {
      queueMicrotask(() => {
        if (mountedRef.current) setSavedFetched(true);
      });
      return null;
    }
    try {
      await store.purgeExpired();
      const list = await store.list();
      const mine = stateRef.current.id;
      const latest = list.find((entry) => entry.pageCount > 0 && entry.id !== mine) ?? null;
      if (mountedRef.current) setSaved(latest);
      return latest;
    } catch {
      return null;
    } finally {
      if (mountedRef.current) setSavedFetched(true);
    }
  }, []);

  useEffect(() => {
    if (!autosave) return;
    void refreshSaved();
  }, [autosave, refreshSaved]);

  const resetSession = useCallback(() => {
    epochRef.current += 1;
    abortRef.current.abort();
    abortRef.current = new AbortController();
    highRef.current = [];
    lowRef.current = [];
    queuedRenders.current.clear();
    queuedFull.current.clear();
    analysisQueuedRef.current = false;
    analysisDirtyRef.current = false;
    idFrontRef.current = null;
    setIdPending(false);
    setOrientationNotice(null);
    setLostPages(0);
    lastSavedRev.current = 0;
    everHadPages.current = false;
    dirtyRef.current = false;
    setSaveStatus("idle");
  }, []);

  /** Carga una sesion guardada. Devuelve `false` si ya no existe. */
  const resume = useCallback(
    async (id: string): Promise<boolean> => {
      const store = resolveScanStore();
      if (!store) return false;
      let session = null;
      try {
        session = await store.load(id);
      } catch {
        session = null;
      }
      if (!session || session.pages.length === 0) return false;
      resetSession();
      dispatchRef.current({ type: "load", session });
      setLostPages(lostPagesOf(session));
      lastSavedRev.current = 0;
      everHadPages.current = true;
      scheduleAnalysis();
      setSaveStatus("saved");
      setSaved(null);
      return true;
    },
    [resetSession, scheduleAnalysis],
  );

  /** Borra la sesion guardada `id` (la de otra visita o la actual) sin tocar lo demas. */
  const discardSaved = useCallback(async (id: string) => {
    try {
      await resolveScanStore()?.remove(id);
    } catch {
      // Ya no estaba.
    }
    if (mountedRef.current) setSaved((current) => (current?.id === id ? null : current));
  }, []);

  /** Cierra el escaneo actual y empieza uno vacio; la sesion actual se borra del almacen. */
  const startOver = useCallback(async () => {
    const id = stateRef.current.id;
    resetSession();
    dispatchRef.current({ type: "reset", id: newId("scan"), now: new Date().toISOString() });
    try {
      await resolveScanStore()?.remove(id);
    } catch {
      // Ya no estaba.
    }
  }, [resetSession]);

  /* ---------------- PDF ---------------- */
  const buildPdf = useCallback(
    (options: { preset: string; pageSize: "a4" | "letter" | "fit"; margin: "none" | "small" | "large"; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }) =>
      resolveScanEngine().buildPdf(sessionFromState(stateRef.current, new Date().toISOString()), options),
    [],
  );

  const estimate = useCallback(
    (preset: string) => resolveScanEngine().estimateSize(stateRef.current.pages, { preset, searchable: stateRef.current.settings.searchable }),
    [],
  );

  /** El resultado COMPLETO (`processed`) de la pagina corresponde a sus ajustes actuales. Lo desconocido (cargado, copiado) se da por bueno. */
  const isFullFresh = useCallback((page: ScanPage) => {
    if (!page.processed) return false;
    const known = processedKeys.current.get(page.processed);
    return known === undefined || known === renderKeyOf(page);
  }, []);

  /** Pide el resultado completo de la pagina (editor, hoja completa): una tarea mas de la cola, sin repetirse. */
  const ensureFull = useCallback(
    (id: string) => {
      const page = stateRef.current.pages.find((candidate) => candidate.id === id);
      if (!page || stateRef.current.pendingIds.includes(id) || isFullFresh(page) || queuedFull.current.has(id)) return;
      queuedFull.current.add(id);
      enqueue({
        lane: "high",
        run: async () => {
          queuedFull.current.delete(id);
          const current = stateRef.current.pages.find((candidate) => candidate.id === id);
          if (!current || stateRef.current.pendingIds.includes(id) || isFullFresh(current)) return;
          const wanted = renderKeyOf(current);
          const out = await resolveScanEngine().renderPage(current, { signal: abortRef.current.signal });
          if (!mountedRef.current) return;
          if (out.thumb) thumbKeys.current.set(out.thumb, wanted);
          if (out.processed) processedKeys.current.set(out.processed, wanted);
          dispatchRef.current({ type: "rendered", id, key: wanted, processed: out.processed, thumb: out.thumb });
        },
      });
    },
    [enqueue, isFullFresh],
  );

  /** La miniatura de la pagina corresponde a sus ajustes actuales (no hay un recalculo pendiente). */
  const isFresh = useCallback((page: ScanPage) => !!page.thumb && thumbKeys.current.get(page.thumb) === renderKeyOf(page), []);

  const readyPages = useMemo(() => state.pages.filter((page) => !state.pendingIds.includes(page.id)), [state.pages, state.pendingIds]);

  return {
    state,
    stateRef,
    pages: state.pages,
    readyPages,
    isFresh,
    isFullFresh,
    ensureFull,
    settings: state.settings,
    name: state.name,
    pendingCount: state.pendingIds.length,
    busy: busyCount > 0 || state.pendingIds.length > 0,
    canUndo: canUndo(state),
    canRedo: canRedo(state),
    undoLabel: state.past[state.past.length - 1]?.label ?? null,
    saveStatus,
    hasPendingWrite: () => dirtyRef.current || savingRef.current,
    flush,
    saved,
    savedLoaded,
    refreshSaved,
    resume,
    discardSaved,
    startOver,
    orientationNotice,
    importProblems,
    reportImportProblems,
    dismissImportProblems,
    lostPages,
    dismissLostPages: () => setLostPages(0),
    undoOrientation,
    dismissOrientationNotice,
    idPending,
    cancelIdFlow,
    addBlobs,
    addCapture,
    retake,
    removeIds,
    rotateIds,
    duplicateIds,
    moveIds,
    shiftIds,
    applyFilter,
    applyAdjust,
    applyCorners,
    applyToAll,
    removeBlanks,
    dismissFlag,
    undo,
    redo,
    setName,
    setSettings,
    proposeNameNow,
    buildPdf,
    estimate,
    defaultSettings: DEFAULT_SCAN_SETTINGS,
  };
}

export type ScanSessionApi = ReturnType<typeof useScanSession>;
export type { ScanState };
