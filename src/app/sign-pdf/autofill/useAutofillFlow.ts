"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutofillOrigin, AutofillSource, ClientProfile, ExtractWarning, FillProposal } from "@/lib/autofill/types";
import { findClientProfileByName, saveClientProfile, type ProfileWriteFailure } from "@/lib/clientProfile/store";
import type { DetectedField } from "@/lib/pdf/detectFields";
import { loadAutofillEngine, ocrModelAvailable, prepareOcrModel, type AutofillEngine } from "@/app/sign-pdf/autofill/autofillServices";
import { AUTOFILL_STRINGS, type AutofillStrings } from "@/app/sign-pdf/autofill/strings";
import {
  acceptedValues,
  buildPatch,
  buildTargets,
  checkedCount,
  defaultChecked,
  defaultSelection,
  groupItems,
  planRows,
  profileItems,
  profilePayload,
  suggestProfileName,
  unmatchedKeys,
  withUniqueIds,
  type Edits,
  type FillPatch,
  type PlannedRow,
  type ReviewGroup,
  type ReviewItem,
  type Selection,
} from "@/app/sign-pdf/autofill/model";

/**
 * Maquina de estados de la hoja «Rellenar con datos del cliente»: elegir fuentes -> leer (con cancelar) -> revisar -> rellenar.
 * Con un perfil guardado elegido se salta la lectura y va directo a revisar. Aqui no hay JSX: solo estado y acciones.
 *
 * Todo lo que escribe en el documento sale por `onApply` (la hoja lo lleva a `textValues`); este hook nunca toca el
 * documento por su cuenta, y nada se escribe sin que la persona haya visto el valor y su evidencia.
 */

export type Phase = "choose" | "model" | "downloading" | "reading" | "review" | "profiles";

export type SourceEntry = {
  id: string;
  name: string;
  kind: "pdf" | "image" | "text";
  origin: AutofillOrigin;
  size: number;
  source: AutofillSource;
};

/** Tope de fuentes a la vez y de peso por archivo: un limite de producto, no del motor (que lo vuelve a comprobar). */
export const MAX_SOURCES = 10;
export const MAX_SOURCE_MB = 60;
export const MAX_SOURCE_BYTES = MAX_SOURCE_MB * 1024 * 1024;

export type ReadFailure = "failed" | null;

export type FlowDone = { patch: FillPatch; count: number; from: string | null; profileNote: string | null };

export type AutofillFlowParams = {
  locale: "es" | "en";
  fields: readonly DetectedField[];
  values: Readonly<Record<string, string>>;
  dataKeys?: Readonly<Record<string, string>>;
  /** Escribe el relleno en el documento (el llamador lo lleva a `textValues`). */
  onApply: (patch: FillPatch) => void;
  /** La hoja puede cerrarse: ya se escribio todo. */
  onDone: (done: FlowDone) => void;
  /** Texto para la region viva de la hoja. */
  onAnnounce?: (text: string) => void;
};

function classify(file: File): "pdf" | "image" | null {
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  if (type === "application/pdf" || (type === "" && name.endsWith(".pdf"))) return "pdf";
  if (type.startsWith("image/") || (type === "" && /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/.test(name))) return "image";
  return null;
}

let entrySeed = 0;
const nextEntryId = () => `src-${(entrySeed += 1)}`;

export function useAutofillFlow(params: AutofillFlowParams) {
  const { locale, fields, values: liveValues, dataKeys, onApply, onDone, onAnnounce } = params;
  const strings: AutofillStrings = AUTOFILL_STRINGS[locale];

  const [phase, setPhase] = useState<Phase>("choose");
  const [entries, setEntries] = useState<SourceEntry[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<ReadFailure>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [warnings, setWarnings] = useState<ExtractWarning[]>([]);
  const [warningNames, setWarningNames] = useState<string[]>([]);
  const [usedOcr, setUsedOcr] = useState(false);
  /** El modelo de lectura falta: con fotos se pregunta ANTES de leer; con un PDF escaneado el motor lo dice despues (`ocr-unavailable`). */
  const [modelFailure, setModelFailure] = useState<"offline" | "network" | "engine" | null>(null);
  const [offerModel, setOfferModel] = useState(false);
  const [skippedPhotos, setSkippedPhotos] = useState(0);
  const [checking, setChecking] = useState(false);
  const [fromProfile, setFromProfile] = useState<ClientProfile | null>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [edits, setEdits] = useState<Edits>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [saveOn, setSaveOn] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileNameTouched, setProfileNameTouched] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [engine, setEngine] = useState<AutofillEngine | null>(null);
  const [engineFailed, setEngineFailed] = useState(false);
  /** Tras rellenar, lo que se veia en ese instante: mientras la hoja sale, la vista previa no parpadea con los campos ya escritos. */
  const [frozenValues, setFrozenValues] = useState<Readonly<Record<string, string>> | null>(null);
  const values = frozenValues ?? liveValues;
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const pastedCount = useRef(0);

  /** Carga el motor al abrir la hoja (no antes). */
  const loadEngine = useCallback(() => {
    setEngineFailed(false);
    void loadAutofillEngine().then(setEngine, () => setEngineFailed(true));
  }, []);

  const groups: ReviewGroup[] = useMemo(() => groupItems(items, locale), [items, locale]);

  const accepted = useMemo(() => acceptedValues(groups, selection, edits), [groups, selection, edits]);
  const targets = useMemo(() => buildTargets(fields, values, dataKeys), [fields, values, dataKeys]);

  const { rows, planFailed } = useMemo((): { rows: PlannedRow[]; planFailed: boolean } => {
    if (!engine || accepted.length === 0) return { rows: [], planFailed: false };
    try {
      const proposals: FillProposal[] = engine.planFill(targets, accepted);
      return { rows: planRows(proposals, fields, values, locale), planFailed: false };
    } catch {
      return { rows: [], planFailed: true };
    }
  }, [engine, accepted, targets, fields, values, locale]);

  /** Una casilla de fila vale para ese campo Y ese valor: si el valor propuesto cambia, vuelve a su estado por defecto. */
  const rowKey = (row: PlannedRow) => `${row.field.id}\u0000${row.proposal.value}`;
  const checked = useMemo(() => {
    const base = defaultChecked(rows);
    const out: Record<string, boolean> = {};
    for (const row of rows) {
      const own = Object.prototype.hasOwnProperty.call(overrides, rowKey(row)) ? overrides[rowKey(row)] : undefined;
      out[row.field.id] = own ?? base[row.field.id];
    }
    return out;
  }, [rows, overrides]);

  const count = checkedCount(rows, checked);
  const missingKeys = useMemo(() => unmatchedKeys(accepted, rows), [accepted, rows]);

  /** Nombre propuesto del perfil mientras la persona no lo toque. */
  const proposedName = suggestProfileName(accepted);
  const shownProfileName = profileNameTouched ? profileName : proposedName;

  /* ------------------------------------------------------------ *
   * Fuentes
   * ------------------------------------------------------------ */

  /** Lo ultimo elegido, para decidir sin efectos dentro de un actualizador de estado (React puede ejecutarlos dos veces). */
  const entriesRef = useRef<SourceEntry[]>([]);
  const commitEntries = (next: SourceEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  };

  const addFiles = useCallback(
    (list: FileList | readonly File[] | null, origin: Exclude<AutofillOrigin, "paste">) => {
      const files = list ? Array.from(list) : [];
      if (files.length === 0) return;
      const rejected: string[] = [];
      const fresh: SourceEntry[] = [];
      let room = MAX_SOURCES - entriesRef.current.length;
      for (const file of files) {
        const kind = classify(file);
        if (kind === null) {
          rejected.push(strings.rejectedType(file.name));
        } else if (file.size > MAX_SOURCE_BYTES) {
          rejected.push(strings.rejectedSize(file.name, MAX_SOURCE_MB));
        } else if (room <= 0) {
          if (!rejected.includes(strings.rejectedCount(MAX_SOURCES))) rejected.push(strings.rejectedCount(MAX_SOURCES));
        } else {
          room -= 1;
          fresh.push({ id: nextEntryId(), name: file.name, kind, origin, size: file.size, source: { kind, file, origin } as AutofillSource });
        }
      }
      if (fresh.length > 0) commitEntries([...entriesRef.current, ...fresh]);
      setNotices(rejected);
      onAnnounce?.([fresh.length > 0 ? strings.sourcesAdded(fresh.length) : "", ...rejected].filter(Boolean).join(" "));
    },
    [onAnnounce, strings],
  );

  const addText = useCallback(
    (text: string): boolean => {
      const clean = text.trim();
      if (clean === "") return false;
      if (entriesRef.current.length >= MAX_SOURCES) {
        setNotices([strings.rejectedCount(MAX_SOURCES)]);
        onAnnounce?.(strings.rejectedCount(MAX_SOURCES));
        return false;
      }
      pastedCount.current += 1;
      commitEntries([...entriesRef.current, { id: nextEntryId(), name: strings.pastedName(pastedCount.current), kind: "text", origin: "paste", size: clean.length, source: { kind: "text", text: clean, origin: "paste" } }]);
      setNotices([]);
      onAnnounce?.(strings.sourcesAdded(1));
      return true;
    },
    [onAnnounce, strings],
  );

  const removeEntry = useCallback((id: string) => {
    commitEntries(entriesRef.current.filter((entry) => entry.id !== id));
    setNotices([]);
  }, []);

  /* ------------------------------------------------------------ *
   * Leer
   * ------------------------------------------------------------ */

  const openReview = useCallback(
    (found: ReviewItem[], profile: ClientProfile | null) => {
      const nextItems = withUniqueIds(found);
      const nextGroups = groupItems(nextItems, locale);
      setItems(nextItems);
      setSelection(defaultSelection(nextGroups));
      setEdits({});
      setOverrides({});
      setSaveOn(false);
      setProfileName("");
      setProfileNameTouched(false);
      setProfileError(null);
      setFromProfile(profile);
      setPhase("review");
    },
    [locale],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(async (options: { skipPhotos?: boolean } = {}) => {
    const skip = options.skipPhotos === true;
    // Las fuentes que de verdad se mandan al motor (con `skipPhotos`, solo lo que no son fotos).
    const sent = skip ? entries.filter((entry) => entry.kind !== "image") : entries;
    if (sent.length === 0) return;
    // El motor NO descarga el modelo de lectura: con fotos y sin modelo se pregunta ANTES, con un boton y un texto claro.
    if (!skip && sent.some((entry) => entry.kind === "image")) {
      const before = runRef.current;
      setChecking(true);
      let ready = false;
      try {
        ready = await ocrModelAvailable();
      } finally {
        setChecking(false);
      }
      // Si la hoja se cerro (o se cancelo) mientras se comprobaba el modelo, no se lanza ninguna lectura huerfana.
      if (runRef.current !== before) return;
      if (!ready) {
        setModelFailure(null);
        setPhase("model");
        onAnnounce?.(strings.modelBody);
        return;
      }
    }
    setSkippedPhotos(entries.length - sent.length);
    const run = (runRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;
    setFailure(null);
    setNotices([]);
    setProgress(0);
    setPhase("reading");
    onAnnounce?.(strings.readingLabel);
    try {
      const loaded = engine ?? (await loadAutofillEngine());
      setEngine(loaded);
      const result = await loaded.extract(
        sent.map((entry) => entry.source),
        {
          locale,
          signal: controller.signal,
          onProgress: (fraction) => {
            if (runRef.current === run) setProgress(Math.min(1, Math.max(0, fraction)));
          },
        },
      );
      if (runRef.current !== run) return;
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      setWarnings(result.warnings);
      setWarningNames(result.warnings.map((warning) => (warning.sourceIndex !== undefined ? (sent[warning.sourceIndex]?.name ?? "") : "")));
      setUsedOcr(result.usedOcr);
      setOfferModel(result.warnings.some((warning) => warning.code === "ocr-unavailable"));
      openReview(result.values, null);
      onAnnounce?.(result.values.length === 0 ? strings.nothingFound : strings.foundCount(result.values.length, new Set(result.values.map((value) => value.key)).size));
    } catch {
      if (runRef.current !== run) return;
      if (controller.signal.aborted) {
        setPhase("choose");
        setNotices([strings.cancelled]);
        onAnnounce?.(strings.cancelled);
      } else {
        setFailure("failed");
        setPhase("choose");
        onAnnounce?.(strings.readFailed);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [engine, entries, locale, onAnnounce, openReview, strings]);

  /** Descarga el modelo de lectura (accion explicita de la persona) y, si sale bien, lee. «Cancelar» corta la descarga. */
  const downloadModel = useCallback(async () => {
    const run = (runRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;
    setModelFailure(null);
    setPhase("downloading");
    onAnnounce?.(strings.modelDownloading);
    const outcome = await prepareOcrModel({ signal: controller.signal });
    if (abortRef.current === controller) abortRef.current = null;
    if (runRef.current !== run) return;
    if (outcome.ok) {
      setOfferModel(false);
      await start();
      return;
    }
    setPhase("model");
    if (outcome.reason !== "cancelled") {
      setModelFailure(outcome.reason);
      onAnnounce?.(strings.modelFailed(outcome.reason));
    }
  }, [onAnnounce, start, strings]);

  /** Con un perfil guardado: sin leer nada, directo a revisar. */
  const useProfile = useCallback(
    (profile: ClientProfile) => {
      setWarnings([]);
      setWarningNames([]);
      setUsedOcr(false);
      setOfferModel(false);
      setSkippedPhotos(0);
      setFailure(null);
      openReview(profileItems(profile), profile);
      onAnnounce?.(strings.foundCount(Object.keys(profile.values).length, Object.keys(profile.values).length));
    },
    [onAnnounce, openReview, strings],
  );

  /** Vuelve a elegir fuentes (los archivos elegidos se conservan). */
  const backToChoose = useCallback(() => {
    setPhase("choose");
    setFailure(null);
  }, []);

  const showProfiles = useCallback(() => setPhase("profiles"), []);

  /** Al cerrar la hoja: se cancela lo que este leyendo y se olvida todo (los archivos no se quedan en memoria). */
  const reset = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("choose");
    commitEntries([]);
    setNotices([]);
    setProgress(0);
    setFailure(null);
    setItems([]);
    setWarnings([]);
    setWarningNames([]);
    setUsedOcr(false);
    setModelFailure(null);
    setOfferModel(false);
    setSkippedPhotos(0);
    setChecking(false);
    setFromProfile(null);
    setSelection({});
    setEdits({});
    setOverrides({});
    setSaveOn(false);
    setProfileName("");
    setProfileNameTouched(false);
    setProfileError(null);
    setFrozenValues(null);
    pastedCount.current = 0;
  }, []);

  useEffect(
    () => () => {
      runRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  /* ------------------------------------------------------------ *
   * Revisar
   * ------------------------------------------------------------ */

  const select = useCallback((key: string, id: string | null) => setSelection((current) => ({ ...current, [key]: id })), []);
  const edit = useCallback((id: string, text: string) => setEdits((current) => ({ ...current, [id]: text })), []);
  const setRowChecked = useCallback((row: PlannedRow, on: boolean) => setOverrides((current) => ({ ...current, [rowKey(row)]: on })), []);

  const profileFailureText = (reason: ProfileWriteFailure): string =>
    reason === "full" ? strings.profileFull : reason === "unavailable" ? strings.profileUnavailable : reason === "empty" ? strings.profileNameRequired : strings.profileFailed;

  /**
   * Rellena. Si se pidio guardar el perfil, se guarda PRIMERO: si no se puede (20 perfiles, sin almacenamiento, sin nombre) no se
   * escribe nada en el documento y se dice por que, para que la persona decida (desmarcar la casilla, borrar un perfil…).
   */
  const fill = useCallback(() => {
    const patch = buildPatch(rows, checked, values);
    const total = Object.keys(patch.written).length;
    let profileNote: string | null = null;
    if (saveOn && accepted.length > 0 && !fromProfile) {
      const name = shownProfileName.trim();
      if (name === "") {
        setProfileError(strings.profileNameRequired);
        return;
      }
      const payload = profilePayload(accepted, items, edits, locale);
      const existed = findClientProfileByName(name) !== undefined;
      const result = saveClientProfile({ name, values: payload.values, source: payload.sources });
      if (!result.ok) {
        setProfileError(profileFailureText(result.reason));
        return;
      }
      profileNote = strings.profileSaved(result.profile.name, existed);
    }
    setProfileError(null);
    setFrozenValues(values);
    if (total > 0) onApply(patch);
    onDone({ patch, count: total, from: fromProfile ? `«${fromProfile.name}»` : null, profileNote });
    // `profileFailureText` y `strings` son estables mientras no cambie el idioma.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, checked, values, saveOn, accepted, fromProfile, shownProfileName, items, edits, onApply, onDone, strings]);

  const canSaveOnly = count === 0 && saveOn && accepted.length > 0 && !fromProfile;

  return {
    strings,
    locale,
    phase,
    entries,
    notices,
    progress,
    failure,
    warnings,
    warningNames,
    usedOcr,
    modelFailure,
    offerModel,
    skippedPhotos,
    checking,
    fromProfile,
    groups,
    selection,
    edits,
    accepted,
    rows,
    planFailed,
    checked,
    count,
    missingKeys,
    saveOn,
    profileName: shownProfileName,
    profileError,
    engineReady: engine !== null,
    engineFailed,
    canSaveOnly,
    loadEngine,
    addFiles,
    addText,
    removeEntry,
    start,
    downloadModel,
    cancel,
    useProfile,
    backToChoose,
    showProfiles,
    reset,
    select,
    edit,
    setRowChecked,
    setSaveOn: (on: boolean) => {
      setSaveOn(on);
      setProfileError(null);
    },
    setProfileName: (name: string) => {
      setProfileName(name);
      setProfileNameTouched(true);
      setProfileError(null);
    },
    fill,
  };
}

export type AutofillFlow = ReturnType<typeof useAutofillFlow>;
