"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { CheckCheck, Copy, FileInput, FileOutput, FilePlus2, Hash, ImagePlus, ListOrdered, Merge, Scissors, X } from "lucide-react";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Button } from "@/components/ui/Button";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { PasswordSheet } from "@/components/tool/PasswordSheet";
import { useInputGuard } from "@/components/tool/InputGuardContext";
import { errorCopy } from "@/components/tool/errorCopy";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { downloadBlob, stripExtension, toPdfError, withSuffix, type PdfErrorCode } from "@/lib/pdf/core";
import {
  applyPageAssembly,
  type PageAssemblyWarning,
  type PageEntry,
  type PageInfo,
  readPageInfo,
} from "@/lib/pdf/pageAssembly";
import { selectedEntries } from "@/lib/pdf/pageAssemblyPlan";
import { splitDocument, type SplitParts } from "@/lib/pdf/pageAssemblyExport";
import { runOperation } from "@/app/pdf-pro/proAdapter";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { isTextEditingTarget } from "@/app/pdf-pro/proShortcuts";
import { useProMode, useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { PageGrid, type GridCommand, type GridItem, type PageGridHandle } from "@/app/pdf-pro/pages/PageGrid";
import {
  AddFilesSheet,
  BlankSheet,
  ExtractSheet,
  InsertPdfSheet,
  MoreSheet,
  RangeSheet,
  SplitSheet,
  type MoreAction,
} from "@/app/pdf-pro/pages/PagesSheets";
import {
  PagesActionBar,
  PagesCompactBar,
  PagesStatusBar,
  type PagesToolbarHandlers,
  type PagesToolbarModel,
} from "@/app/pdf-pro/pages/PagesToolbar";
import {
  clearSelection,
  duplicateTargets,
  insertBlank,
  insertImages,
  insertPdfPages,
  mergeSources,
  moveTargetsTo,
  redoPlan,
  removeTargets,
  rotateTargets,
  selectAll,
  selectParity,
  selectPositions,
  shiftTargets,
  undoPlan,
  actionTargets,
  type ActionDeps,
} from "@/app/pdf-pro/pages/pagesActions";
import type { GridOptions } from "@/app/pdf-pro/pages/pagesLayout";
import { ThumbHost, useContainerSize, usePagesStore, type ThumbMap } from "@/app/pdf-pro/pages/pagesHooks";
import { pagesApplyOperation, type PagesApplyReport } from "@/app/pdf-pro/pages/pagesOperation";
import { addImageFiles, addPdfFiles, unlockPdfSource } from "@/app/pdf-pro/pages/pagesSources";
import { describePlanLabel, pagesWarningText } from "@/app/pdf-pro/pages/pagesStrings";
import { MAX_PAGES_PDF_SOURCES } from "@/app/pdf-pro/pages/pagesStore";
import {
  CURRENT_SOURCE_KEY,
  buildGridItems,
  visiblePagesBySource,
} from "@/app/pdf-pro/pages/pagesView";

/**
 * Pestana «Paginas» de PDF Pro (Wave 7 · U4): el organizador. Cuadricula virtualizada del documento
 * con un PLAN virtual que se edita al instante (reordenar, girar, eliminar, duplicar, insertar) y
 * que «Aplicar» lleva al documento de trabajo como UN snapshot.
 *
 * El visor (unidad 3) puede conectarse con `PagesSelectionBridge`: la seleccion de paginas se
 * comparte mientras no hay cambios sin aplicar (el plan virtual ya no coincide con el documento).
 */

export type PagesSelectionBridge = {
  /** Paginas seleccionadas en el visor (0-based, documento actual). */
  selectedPages?: ReadonlySet<number>;
  /** El organizador cambio la seleccion (paginas ORIGINALES 0-based, sin cambios pendientes). */
  onSelectPages?: (pages: number[]) => void;
  /** Lleva el visor a una pagina (0-based). */
  scrollToPage?: (page: number) => void;
};

export type PagesTabProps = {
  bridge?: PagesSelectionBridge;
  /** Abre un PDF como documento nuevo (por defecto, reemplaza el documento de trabajo). */
  onOpenAsNew?: (file: File) => void | Promise<void>;
  /**
   * Documento de pdf.js que el visor ya tiene abierto (`snapshotId` = el snapshot que muestra): las miniaturas
   * lo reutilizan en vez de abrir otra copia. `null` = el visor aun lo abre; omitido = no hay visor.
   */
  sharedPdf?: { snapshotId: string; doc: PDFDocumentProxy } | null;
  className?: string;
};

/** Debajo de este ancho (px) el panel usa la barra inferior compacta. */
const COMPACT_BELOW = 560;
const FALLBACK = { width: 360, height: 640 };
/**
 * (M2 · GE-05) Cuadricula de la barra compacta (movil, panel estrecho): tres columnas de miniaturas de ~115 px y menos alto por
 * tarjeta, para que se vean al menos dos filas a la vez (con las de 157×250 de antes solo se veia una).
 */
const COMPACT_GRID: Partial<GridOptions> = { minCard: 92, gap: 10, padding: 10, labelHeight: 44, aspect: 1.25 };

type SheetName = "range" | "blank" | "pdf" | "images" | "merge" | "extract" | "split" | "more" | null;

export function PagesTab({ bridge, onOpenAsNew, sharedPdf, className }: PagesTabProps) {
  const { t, language } = useI18n();
  const strings = getProStrings(language).pages;
  const { doc, document: working } = useProWorkingDoc();
  const { store, state } = usePagesStore(doc);
  const guard = useInputGuard();

  const snapshot = working ? working.snapshots[working.cursor] : null;
  const snapshotId = snapshot?.id ?? null;
  const snapshotPages = snapshot?.pageCount ?? 0;
  const snapshotBytes = snapshot?.bytes ?? null;
  const documentName = working?.name ?? "documento.pdf";

  const rootRef = useRef<HTMLElement>(null);
  const gridRef = useRef<PageGridHandle>(null);
  const size = useContainerSize(rootRef, FALLBACK);
  const compact = size.width < COMPACT_BELOW;

  /* ---------------- base ---------------- */
  useEffect(() => {
    if (!snapshotId) return;
    const result = store.syncBase(snapshotId, snapshotPages);
    if (result === "discarded") doc.announce(strings.announce.documentChanged);
  }, [store, doc, snapshotId, snapshotPages, strings]);

  /* ---------------- tamanos de pagina del documento actual ---------------- */
  const [infos, setInfos] = useState<{ id: string; infos: PageInfo[] } | null>(null);
  useEffect(() => {
    if (!snapshotBytes || !snapshotId) return;
    let cancelled = false;
    void readPageInfo(snapshotBytes)
      .then((result) => {
        if (!cancelled) setInfos({ id: snapshotId, infos: result });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [snapshotBytes, snapshotId]);
  const pageInfos = infos && infos.id === snapshotId ? infos.infos : null;

  /* ---------------- miniaturas ---------------- */
  const [thumbMap, setThumbMap] = useState<ThumbMap>({});
  const onThumbs = useCallback((key: string, thumbs: Readonly<Record<number, string | undefined>>) => {
    setThumbMap((previous) => (previous[key] === thumbs ? previous : { ...previous, [key]: thumbs }));
  }, []);
  const [visibleMain, setVisibleMain] = useState<{ first: number; last: number } | null>(null);
  const [sheetVisible, setSheetVisible] = useState<{ sourceId: string; first: number; last: number } | null>(null);

  const visibleSets = useMemo(() => {
    const out: Record<string, Set<number>> = visibleMain
      ? visiblePagesBySource(state.plan, visibleMain.first, visibleMain.last)
      : {};
    if (sheetVisible) {
      const set = (out[sheetVisible.sourceId] ??= new Set());
      for (let index = sheetVisible.first; index <= sheetVisible.last; index += 1) set.add(index);
    }
    return out;
  }, [state.plan, visibleMain, sheetVisible]);

  const thumbLookup = useCallback(
    (key: string, index: number): string | undefined => thumbMap[key]?.[index],
    [thumbMap],
  );

  const items = useMemo(
    () =>
      buildGridItems({
        plan: state.plan,
        sources: state.sources,
        pageInfos,
        thumb: thumbLookup,
        strings,
      }),
    [state.plan, state.sources, pageInfos, thumbLookup, strings],
  );

  /* ---------------- acciones ---------------- */
  const sizeOf = useCallback(
    (entry: PageEntry) => {
      if (entry.kind === "existing") return pageInfos?.[entry.sourceIndex] ?? null;
      if (entry.kind === "external") return state.sources[entry.sourceId]?.infos?.[entry.sourceIndex] ?? null;
      return null;
    },
    [pageInfos, state.sources],
  );
  const deps: ActionDeps = useMemo(
    () => ({ store, strings, announce: (text) => doc.announce(text), sizeOf }),
    [store, strings, doc, sizeOf],
  );

  /** El foco nunca debe quedar en <body> tras una accion que desactiva el boton pulsado. */
  const restoreFocus = useCallback(() => {
    window.setTimeout(() => {
      const root = rootRef.current;
      if (!root) return;
      const active = window.document.activeElement;
      if (active && active !== window.document.body && root.contains(active)) return;
      gridRef.current?.focusGrid();
    }, 0);
  }, []);

  const followFocus = useCallback(() => {
    const id = store.getState().focusId;
    if (id) gridRef.current?.focusItem(id);
    restoreFocus();
  }, [store, restoreFocus]);

  /* ---------------- aplicar ---------------- */
  const [applying, setApplying] = useState<{ progress: number } | null>(null);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [notices, setNotices] = useState<PageAssemblyWarning[]>([]);
  const controllerRef = useRef<AbortController | null>(null);

  const referencedSources = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of state.plan) if (entry.kind === "external" || entry.kind === "image") ids.add(entry.sourceId);
    return ids;
  }, [state.plan]);
  const blocked = useMemo(
    () => [...referencedSources].some((id) => state.sources[id]?.status !== "ready"),
    [referencedSources, state.sources],
  );

  const runApply = useCallback(async () => {
    const current = store.getState();
    const start = doc.currentSnapshot();
    if (!current.dirty || controllerRef.current || !start || start.id !== current.baseSnapshotId) return;
    const sourcesReady = [...referencedSources].every((id) => current.sources[id]?.status === "ready");
    if (!sourcesReady) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setApplying({ progress: 0 });
    setError(null);
    setNotices([]);
    const label = describePlanLabel(strings, current.summary);
    const outcome = await runOperation(
      pagesApplyOperation,
      start.bytes,
      { plan: current.plan, externals: store.externalsForPlan() },
      {
        signal: controller.signal,
        lang: language,
        onProgress: (progress) => setApplying({ progress }),
      },
    );
    controllerRef.current = null;
    setApplying(null);
    if (!outcome.ok) {
      if (!outcome.cancelled) {
        setError(outcome.code);
        doc.announce(strings.announce.couldNotApply);
      }
      restoreFocus();
      return;
    }
    // Entretanto se deshizo o se aplico otra cosa: este resultado ya no corresponde al documento.
    if (doc.currentSnapshot()?.id !== start.id) {
      doc.announce(strings.announce.documentChanged);
      restoreFocus();
      return;
    }
    store.beginApply();
    const committed = await doc.commit(outcome.bytes, label, "operation", {
      opId: pagesApplyOperation.id,
      pageCount: outcome.pageCount,
    });
    if (!committed) store.cancelApply();
    const report = outcome.report as PagesApplyReport | undefined;
    setNotices(report?.warnings ?? []);
    gridRef.current?.focusGrid();
    restoreFocus();
  }, [store, doc, strings, language, referencedSources, restoreFocus]);

  const cancelApply = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  /* ---------------- hojas ---------------- */
  const [sheet, setSheet] = useState<SheetName>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pdfSourceId, setPdfSourceId] = useState<string | null>(null);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const pdfInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);

  const hasSelection = state.selection.size > 0;
  const selectionCount = state.selection.size;

  const dropSources = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) store.removeSource(id);
    },
    [store],
  );

  const closeSheet = useCallback(() => {
    setSheet(null);
    setSheetVisible(null);
    dropSources(pdfSourceId ? [pdfSourceId] : []);
    dropSources(imageIds);
    dropSources(mergeIds);
    setPdfSourceId(null);
    setImageIds([]);
    setMergeIds([]);
    restoreFocus();
  }, [dropSources, pdfSourceId, imageIds, mergeIds, restoreFocus]);

  /** Cierra una hoja SIN soltar las fuentes (acaban de usarse en el plan). */
  const finishSheet = useCallback(() => {
    setSheet(null);
    setSheetVisible(null);
    setPdfSourceId(null);
    setImageIds([]);
    setMergeIds([]);
    followFocus();
  }, [followFocus]);

  /** PDF que no cupieron en el maximo de documentos añadidos: se avisa DE FORMA VISIBLE (y por la region viva). */
  const [omitted, setOmitted] = useState<string[]>([]);
  const reportOmitted = (files: readonly File[]) => {
    if (files.length === 0) return;
    setOmitted((previous) => [...previous, ...files.map((file) => file.name)]);
    doc.announce(strings.announce.limitReached);
  };

  // «Entendido» retira el aviso y su boton: el foco pasa a la cuadricula en el MISMO commit (sin fotograma en <body>).
  const hadOmittedRef = useRef(false);
  useLayoutEffect(() => {
    const had = hadOmittedRef.current;
    hadOmittedRef.current = omitted.length > 0;
    if (!had || omitted.length > 0) return;
    const active = window.document.activeElement;
    if (active && active !== window.document.body && active.isConnected) return;
    gridRef.current?.focusGrid();
  }, [omitted.length]);

  const limitReached = (files: readonly File[]) => {
    if (store.pdfSourceCount() < MAX_PAGES_PDF_SOURCES) return false;
    reportOmitted(files);
    return true;
  };

  const onPdfChosen = (files: File[]) => {
    if (files.length === 0) return;
    if (limitReached(files)) return;
    dropSources(pdfSourceId ? [pdfSourceId] : []);
    const { ids } = addPdfFiles({ store, guard: guard ?? undefined }, files.slice(0, 1));
    setPdfSourceId(ids[0] ?? null);
    setSheet("pdf");
  };
  const onImagesChosen = (files: File[]) => {
    if (files.length === 0) return;
    const { ids } = addImageFiles({ store }, files);
    setImageIds((previous) => [...previous, ...ids]);
    setSheet("images");
  };
  const onMergeChosen = (files: File[]) => {
    if (files.length === 0) return;
    const room = MAX_PAGES_PDF_SOURCES - store.pdfSourceCount();
    if (room <= 0) {
      reportOmitted(files);
      return;
    }
    const { ids } = addPdfFiles({ store, guard: guard ?? undefined }, files.slice(0, room));
    // Los que no caben (el 11.º en adelante) se explican con un aviso visible: nombre y cuantos.
    reportOmitted(files.slice(room));
    setMergeIds((previous) => [...previous, ...ids]);
    setSheet("merge");
  };

  const onFileInput =
    (handler: (files: File[]) => void) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      handler(files);
    };

  /* ---------------- contrasena de un PDF sumado ---------------- */
  const passwordSource = Object.values(state.sources).find((source) => source.status === "password") ?? null;
  const [passwordState, setPasswordState] = useState({ busy: false, wrong: false, failed: false, attempt: 0 });
  const submitPassword = async (password: string) => {
    if (!passwordSource) return;
    setPasswordState((previous) => ({ ...previous, busy: true, wrong: false, failed: false }));
    const result = await unlockPdfSource({ store, guard: guard ?? undefined }, passwordSource.id, password);
    setPasswordState((previous) => ({
      busy: false,
      wrong: result === "wrongPassword",
      failed: result === "failed",
      attempt: previous.attempt + 1,
    }));
    if (result === "ready") doc.announce(strings.announce.ready(passwordSource.name, 0));
  };
  const cancelPassword = () => {
    if (passwordSource) store.removeSource(passwordSource.id);
    setPasswordState({ busy: false, wrong: false, failed: false, attempt: 0 });
  };

  /* ---------------- exportar: extraer y dividir ---------------- */
  const [exporting, setExporting] = useState(false);

  const extractBytes = async (): Promise<Uint8Array> => {
    const current = store.getState();
    const start = doc.currentSnapshot();
    if (!start) throw new Error("no document");
    const entries = selectedEntries(current.plan, actionTargets(store));
    const result = await applyPageAssembly(start.bytes, entries, store.externalsForPlan());
    return result.bytes;
  };

  const extractName = withSuffix(documentName, "extraido");

  const runExtract = async (name: string, openAsNew: boolean) => {
    setExporting(true);
    setError(null);
    try {
      const bytes = await extractBytes();
      if (openAsNew) {
        const file = new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
        setSheet(null);
        if (onOpenAsNew) await onOpenAsNew(file);
        else await doc.open(file);
      } else {
        downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }), name);
        doc.announce(strings.announce.exported(name));
        setSheet(null);
        restoreFocus();
      }
    } catch (failure) {
      setError(toPdfError(failure).code);
    } finally {
      setExporting(false);
    }
  };

  // El documento TAL COMO SE VE (con los cambios sin aplicar) para dividirlo.
  const [splitBytes, setSplitBytes] = useState<{ plan: readonly PageEntry[]; bytes: Uint8Array } | null>(null);
  useEffect(() => {
    if (sheet !== "split" || !snapshotBytes) return;
    if (!state.dirty) return;
    let cancelled = false;
    void applyPageAssembly(snapshotBytes, state.plan, store.externalsForPlan())
      .then((result) => {
        if (!cancelled) setSplitBytes({ plan: state.plan, bytes: result.bytes });
      })
      .catch((failure) => {
        if (!cancelled) {
          setError(toPdfError(failure).code);
          setSheet(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sheet, snapshotBytes, state.dirty, state.plan, store]);
  const splitSource = !state.dirty
    ? snapshotBytes
    : splitBytes && splitBytes.plan === state.plan
      ? splitBytes.bytes
      : null;

  const runSplit = async (parts: SplitParts) => {
    if (!splitSource) return;
    setExporting(true);
    setError(null);
    try {
      const base = stripExtension(documentName) || "documento";
      const result = await splitDocument(splitSource, parts.groups, base, { titles: parts.titles });
      const name = result.kind === "zip" ? withSuffix(documentName, "dividido", "zip") : result.names[0];
      downloadBlob(
        new Blob([result.bytes as unknown as BlobPart], {
          type: result.kind === "zip" ? "application/zip" : "application/pdf",
        }),
        name,
      );
      doc.announce(strings.sheets.splitDone(result.parts));
      setSheet(null);
      restoreFocus();
    } catch (failure) {
      setError(toPdfError(failure).code);
    } finally {
      setExporting(false);
    }
  };

  /* ---------------- puente con el visor ---------------- */
  const bridgeRef = useRef(bridge);
  useEffect(() => {
    bridgeRef.current = bridge;
  });
  const bridgeSelected = bridge?.selectedPages;
  useEffect(() => {
    if (!bridgeSelected || state.dirty) return;
    const plan = store.getState().plan;
    const ids = plan
      .filter((entry) => entry.kind === "existing" && !entry.copy && bridgeSelected.has(entry.sourceIndex))
      .map((entry) => entry.id as string);
    const current = store.getState().selection;
    if (ids.length === current.size && ids.every((id) => current.has(id))) return;
    store.setSelection(ids, ids[0] ?? null);
  }, [bridgeSelected, state.dirty, store, state.plan]);

  const publishSelection = (ids: readonly string[]) => {
    const target = bridgeRef.current;
    if (!target || store.getState().dirty) return;
    const pages = store
      .getState()
      .plan.filter((entry) => ids.includes(entry.id as string) && entry.kind === "existing")
      .map((entry) => (entry.kind === "existing" ? entry.sourceIndex : -1));
    target.onSelectPages?.(pages);
    if (pages.length === 1) target.scrollToPage?.(pages[0]);
  };

  /* ---------------- teclado global: deshacer/rehacer del organizador ---------------- */
  const ownUndo = state.past.length > 0 || state.future.length > 0;
  useProMode("pages", { hasOwnUndo: true }, ownUndo);
  useEffect(() => {
    if (!ownUndo) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const key = event.key.toLowerCase();
      const undo = key === "z" && (event.ctrlKey || event.metaKey) && !event.shiftKey;
      const redo =
        (key === "z" && (event.ctrlKey || event.metaKey) && event.shiftKey) ||
        (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey);
      if (!undo && !redo) return;
      if (isTextEditingTarget(event.target) || isTextEditingTarget(window.document.activeElement)) return;
      event.preventDefault();
      if (controllerRef.current) return;
      if (undo) {
        if (store.canUndo) undoPlan(deps);
        else doc.undo();
      } else if (store.canRedo) redoPlan(deps);
      else doc.redo();
    };
    window.document.addEventListener("keydown", onKeyDown);
    return () => window.document.removeEventListener("keydown", onKeyDown);
  }, [ownUndo, store, deps, doc]);

  /* ---------------- manejadores ---------------- */
  const canRemove = state.plan.length > 1 && (selectionCount === 0 || selectionCount < state.plan.length);

  const handlers: PagesToolbarHandlers = {
    onUndo: () => {
      undoPlan(deps);
      restoreFocus();
    },
    onRedo: () => {
      redoPlan(deps);
      restoreFocus();
    },
    onApply: () => void runApply(),
    onDiscard: () => setConfirmDiscard(true),
    onSelectAll: () => selectAll(deps),
    onSelectNone: () => {
      clearSelection(deps);
      restoreFocus();
    },
    onSelectEven: () => selectParity(deps, "even"),
    onSelectOdd: () => selectParity(deps, "odd"),
    onSelectRange: () => setSheet("range"),
    onRotateLeft: () => {
      rotateTargets(deps, -90);
      followFocus();
    },
    onRotateRight: () => {
      rotateTargets(deps, 90);
      followFocus();
    },
    onRemove: () => {
      removeTargets(deps);
      followFocus();
    },
    onDuplicate: () => {
      duplicateTargets(deps);
      followFocus();
    },
    onMoveBefore: () => {
      shiftTargets(deps, -1);
      followFocus();
    },
    onMoveAfter: () => {
      shiftTargets(deps, 1);
      followFocus();
    },
    onInsertBlank: () => setSheet("blank"),
    onInsertPdf: () => pdfInput.current?.click(),
    onInsertImages: () => imageInput.current?.click(),
    onMerge: () => mergeInput.current?.click(),
    onExtract: () => setSheet("extract"),
    onSplit: () => setSheet("split"),
    onMore: () => setSheet("more"),
  };

  const model: PagesToolbarModel = {
    strings,
    total: state.plan.length,
    selectionCount,
    changeCount: state.changeCount,
    dirty: state.dirty,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    busy: applying !== null,
    blocked,
    canRemove,
  };

  const onGridCommand = (command: GridCommand) => {
    if (applying) return;
    switch (command.type) {
      case "delete":
        removeTargets(deps);
        followFocus();
        break;
      case "rotate":
        rotateTargets(deps, command.degrees);
        followFocus();
        break;
      case "duplicate":
        duplicateTargets(deps);
        followFocus();
        break;
      case "selectAll":
        selectAll(deps);
        break;
      case "clear":
        clearSelection(deps);
        break;
      case "shift":
        shiftTargets(deps, command.direction);
        followFocus();
        break;
    }
  };

  const gridStrings = useMemo(
    () => ({
      dragHandle: strings.card.dragHandle,
      dragStart: strings.announce.dragStart,
      dragCancel: strings.announce.dragCancel,
      loading: strings.card.loading,
    }),
    [strings],
  );

  const moreGroups = useMemo(() => {
    const a = strings.actions;
    const none = selectionCount === 0;
    const run =
      (name: SheetName | "pdf-pick" | "images-pick" | "merge-pick") => () => {
        if (name === "pdf-pick") pdfInput.current?.click();
        else if (name === "images-pick") imageInput.current?.click();
        else if (name === "merge-pick") mergeInput.current?.click();
        else setSheet(name);
      };
    const groups: { title: string; actions: MoreAction[] }[] = [
      {
        title: a.groupSelection,
        actions: [
          { id: "all", label: a.selectAll, icon: <CheckCheck className="size-4" />, handsOffFocus: false, run: () => selectAll(deps) },
          { id: "odd", label: a.selectOdd, icon: <Hash className="size-4" />, handsOffFocus: false, run: () => selectParity(deps, "odd") },
          { id: "even", label: a.selectEven, icon: <Hash className="size-4" />, handsOffFocus: false, run: () => selectParity(deps, "even") },
          { id: "range", label: a.selectRange, icon: <ListOrdered className="size-4" />, run: run("range") },
          { id: "none", label: a.selectNone, icon: <X className="size-4" />, disabled: none, handsOffFocus: false, run: () => clearSelection(deps) },
        ],
      },
      {
        title: a.groupInsert,
        actions: [
          { id: "blank", label: a.insertBlank, icon: <FilePlus2 className="size-4" />, run: run("blank") },
          { id: "pdf", label: a.insertFromPdf, icon: <FileInput className="size-4" />, run: run("pdf-pick") },
          { id: "images", label: a.insertImages, icon: <ImagePlus className="size-4" />, run: run("images-pick") },
          { id: "merge", label: a.mergePdfs, icon: <Merge className="size-4" />, run: run("merge-pick") },
        ],
      },
      {
        title: a.groupExport,
        actions: [
          { id: "extract", label: a.extract, icon: <FileOutput className="size-4" />, disabled: none, run: run("extract") },
          { id: "split", label: a.split, icon: <Scissors className="size-4" />, run: run("split") },
          { id: "duplicate", label: a.duplicate, icon: <Copy className="size-4" />, disabled: none, run: () => { duplicateTargets(deps); followFocus(); } },
        ],
      },
    ];
    return groups;
  }, [strings, selectionCount, deps, followFocus]);

  /* ---------------- vista del PDF elegido en «Insertar desde PDF» ---------------- */
  const pdfSource = pdfSourceId ? (state.sources[pdfSourceId] ?? null) : null;
  const pdfItems = useMemo<GridItem[]>(() => {
    if (!pdfSource || pdfSource.status !== "ready" || !pdfSource.pageCount) return [];
    const total = pdfSource.pageCount;
    return Array.from({ length: total }, (_, index) => {
      const info = pdfSource.infos?.[index];
      return {
        id: `p-${index}`,
        number: index + 1,
        kind: "external" as const,
        rotation: 0,
        aspect: info && info.height > 0 ? info.width / info.height : 1 / 1.414,
        thumb: thumbMap[pdfSource.id]?.[index],
        detail: "",
        ariaLabel: strings.cardLabel(index + 1, total, "", 0),
      };
    });
  }, [pdfSource, thumbMap, strings]);

  const imageSources = imageIds.map((id) => state.sources[id]).filter(Boolean);
  const mergeSourcesList = mergeIds.map((id) => state.sources[id]).filter(Boolean);

  /* ---------------- anuncios de lectura ---------------- */
  const announcedStatus = useRef(new Map<string, string>());
  useEffect(() => {
    for (const source of Object.values(state.sources)) {
      const before = announcedStatus.current.get(source.id);
      if (before === source.status) continue;
      announcedStatus.current.set(source.id, source.status);
      if (source.status === "ready" && source.kind === "pdf") {
        doc.announce(strings.announce.ready(source.name, source.pageCount ?? 0));
      } else if (source.status === "error") {
        doc.announce(strings.announce.failed(source.name));
      }
    }
  }, [state.sources, doc, strings]);

  /* ---------------- descartar ---------------- */
  const discard = () => {
    store.discard();
    setNotices([]);
    setError(null);
    doc.announce(strings.announce.discarded);
    followFocus();
  };

  if (!working || !snapshot) return null;

  const errorView = error ? errorCopy(t, error) : null;
  const gridHasFocusTarget = state.plan.length > 0;

  return (
    <section
      ref={rootRef}
      aria-label={strings.panelTitle}
      data-pages-tab=""
      // Dentro de una hoja (movil) los gestos de la cuadricula son suyos: no arrastran ni cierran la hoja.
      data-sheet-no-drag=""
      data-compact={compact ? "" : undefined}
      className={cn(
        // En la hoja movil (alto automatico) la cuadricula pide un alto digno; en el panel lateral ocupa lo que hay.
        "flex h-full min-h-[min(34rem,72dvh)] flex-col [[role=tabpanel]_&]:min-h-64",
        // En la hoja movil la barra de acciones y la cuadricula ocupan todo el ancho (el contenido de la hoja lleva 20 px de margen).
        "[[role=dialog]_&]:-mx-5 [[role=dialog]_&]:min-h-[min(36rem,76dvh)]",
        className,
      )}
    >
      {!compact ? (
        <div className="px-4 pt-3">
          <h2 className="ui-label text-muted-foreground">{strings.panelTitle}</h2>
          <p className="mt-1 text-footnote text-muted-foreground">{strings.intro}</p>
        </div>
      ) : null}

      <PagesStatusBar model={model} handlers={handlers} compact={compact} />
      {!compact ? <PagesActionBar model={model} handlers={handlers} /> : null}

      {applying ? (
        <div className="flex items-center gap-3 px-4 pb-2" data-pages-progress="">
          <div className="min-w-0 flex-1">
            <ProgressBar value={applying.progress * 100} label={strings.status.applying} />
          </div>
          <Button size="sm" variant="secondary" onClick={cancelApply}>
            {strings.status.cancel}
          </Button>
        </div>
      ) : null}

      {blocked ? (
        <p className="px-4 pb-2 text-footnote text-muted-foreground" data-pages-blocked="">
          {strings.status.cannotApplyReading}
        </p>
      ) : null}

      {omitted.length > 0 ? (
        <div
          role="note"
          data-pages-omitted=""
          className="mx-3 mb-2 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-ios-sm border border-hairline bg-white/5 p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-footnote font-semibold text-foreground">
              {strings.announce.omittedTitle(omitted.length, MAX_PAGES_PDF_SOURCES)}
            </p>
            <p className="mt-0.5 text-footnote text-muted-foreground">
              {strings.announce.omittedBody(omitted.slice(0, 5), Math.max(0, omitted.length - 5))}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOmitted([]);
              // El boton desaparece con el aviso: el foco vuelve a la cuadricula (nunca a <body>).
              followFocus();
            }}
          >
            {strings.announce.omittedDismiss}
          </Button>
        </div>
      ) : null}

      {errorView ? (
        <div className="px-3 pb-2">
          <ErrorBanner
            show
            title={strings.status.errorTitle}
            message={errorView.message}
            hint={errorView.hint}
            dismissLabel={strings.sheets.close}
            onDismiss={() => setError(null)}
            errorKey={error ?? undefined}
          />
        </div>
      ) : null}

      {notices.length > 0 ? (
        <section
          aria-label={strings.status.warningsTitle}
          data-pages-notices=""
          className="mx-3 mb-2 rounded-ios-sm border border-hairline bg-white/4 px-3 py-2"
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-footnote font-semibold">{strings.status.warningsTitle}</p>
            <button
              type="button"
              onClick={() => {
                setNotices([]);
                restoreFocus();
              }}
              className="rounded-ios-sm px-2 py-1 text-footnote text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-signal pointer-coarse:min-h-11"
            >
              {strings.status.dismissWarnings}
            </button>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-footnote text-muted-foreground">
            {notices.map((notice) => (
              <li key={notice.code}>{pagesWarningText(strings, notice)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {gridHasFocusTarget ? (
        <PageGrid
          ref={gridRef}
          items={items}
          selection={state.selection}
          anchorId={state.anchorId}
          focusId={state.focusId}
          label={strings.gridLabel(state.plan.length)}
          strings={gridStrings}
          className="min-h-[16rem] flex-1 basis-0 border-y border-hairline bg-white/2"
          options={compact ? COMPACT_GRID : undefined}
          onSelectionChange={(ids, anchor, focus) => {
            store.setSelection(ids, anchor, focus);
            doc.announce(strings.announce.selected(ids.length));
            publishSelection(ids);
          }}
          onFocusChange={(id) => store.setFocus(id)}
          onCommand={onGridCommand}
          onDrop={(ids, insertBefore) => {
            if (applying) return;
            moveTargetsTo(deps, ids, insertBefore);
            followFocus();
          }}
          onVisibleChange={setVisibleMain}
          announce={(text) => doc.announce(text)}
        />
      ) : null}

      {compact ? <PagesCompactBar model={model} handlers={handlers} /> : null}

      {/* Anfitriones de miniaturas: el documento actual y cada PDF sumado. */}
      <ThumbHost
        sourceKey={CURRENT_SOURCE_KEY}
        bytes={snapshot.bytes}
        shared={sharedPdf === undefined ? undefined : sharedPdf && sharedPdf.snapshotId === snapshot.id ? sharedPdf.doc : null}
        visible={visibleSets[CURRENT_SOURCE_KEY] ?? null}
        active={visibleMain?.first ?? 0}
        onThumbs={onThumbs}
      />
      {Object.values(state.sources)
        .filter((source) => source.kind === "pdf" && source.status === "ready" && source.data)
        .map((source) => (
          <ThumbHost
            key={source.id}
            sourceKey={source.id}
            bytes={source.data as Uint8Array}
            visible={visibleSets[source.id] ?? null}
            active={visibleSets[source.id] ? Math.min(...visibleSets[source.id]) : 0}
            onThumbs={onThumbs}
          />
        ))}

      {/* Selectores de archivo (los abren los botones; ocultos pero con nombre accesible). */}
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        aria-label={strings.actions.insertFromPdf}
        data-pages-input="pdf"
        onChange={onFileInput(onPdfChosen)}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label={strings.actions.insertImages}
        data-pages-input="images"
        onChange={onFileInput(onImagesChosen)}
      />
      <input
        ref={mergeInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        aria-label={strings.actions.mergePdfs}
        data-pages-input="merge"
        onChange={onFileInput(onMergeChosen)}
      />

      <RangeSheet
        open={sheet === "range"}
        onClose={() => setSheet(null)}
        total={state.plan.length}
        strings={strings}
        onSubmit={(positions) => {
          selectPositions(deps, positions);
          restoreFocus();
        }}
      />
      <BlankSheet
        open={sheet === "blank"}
        onClose={() => {
          setSheet(null);
          followFocus();
        }}
        hasSelection={hasSelection}
        strings={strings}
        onSubmit={(options) => {
          insertBlank(deps, options);
        }}
      />
      <InsertPdfSheet
        open={sheet === "pdf"}
        onClose={closeSheet}
        source={pdfSource}
        items={pdfItems}
        hasSelection={hasSelection}
        strings={strings}
        onPick={() => pdfInput.current?.click()}
        onVisible={(range) =>
          setSheetVisible(range && pdfSourceId ? { sourceId: pdfSourceId, first: range.first, last: range.last } : null)
        }
        onSubmit={(indices, position) => {
          if (pdfSourceId && insertPdfPages(deps, pdfSourceId, indices, position)) finishSheet();
        }}
      />
      <AddFilesSheet
        open={sheet === "images"}
        onClose={closeSheet}
        mode="images"
        sources={imageSources}
        hasSelection={hasSelection}
        strings={strings}
        onPick={() => imageInput.current?.click()}
        onRemove={(id) => {
          setImageIds((previous) => previous.filter((item) => item !== id));
          store.removeSource(id);
        }}
        onSubmit={(position, layout) => {
          const ready = imageIds.filter((id) => state.sources[id]?.status === "ready");
          if (insertImages(deps, ready, position, layout)) finishSheet();
        }}
      />
      <AddFilesSheet
        open={sheet === "merge"}
        onClose={closeSheet}
        mode="merge"
        sources={mergeSourcesList}
        hasSelection={hasSelection}
        strings={strings}
        onPick={() => mergeInput.current?.click()}
        onRemove={(id) => {
          setMergeIds((previous) => previous.filter((item) => item !== id));
          store.removeSource(id);
        }}
        onSubmit={(position) => {
          const ready = mergeIds
            .map((id) => state.sources[id])
            .filter((source) => source?.status === "ready")
            .map((source) => ({ id: source.id, pageCount: source.pageCount ?? 0 }));
          if (mergeSources(deps, ready, position)) finishSheet();
        }}
      />
      <ExtractSheet
        key={`extract-${sheet === "extract"}-${documentName}`}
        open={sheet === "extract"}
        onClose={() => {
          setSheet(null);
          restoreFocus();
        }}
        count={selectionCount || (state.focusId ? 1 : 0)}
        defaultName={extractName}
        busy={exporting}
        canOpenAsNew
        strings={strings}
        onDownload={(name) => void runExtract(name, false)}
        onOpenAsNew={(name) => void runExtract(name, true)}
      />
      <SplitSheet
        open={sheet === "split"}
        onClose={() => {
          setSheet(null);
          restoreFocus();
        }}
        bytes={splitSource}
        loading={splitSource === null}
        pageCount={state.plan.length}
        pending={state.dirty}
        busy={exporting}
        strings={strings}
        onSubmit={(parts) => void runSplit(parts)}
      />
      <MoreSheet open={sheet === "more"} onClose={() => setSheet(null)} strings={strings} groups={moreGroups} />

      <ConfirmSheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={discard}
        title={strings.status.discardTitle}
        body={strings.status.discardBody}
        confirmLabel={strings.status.discardConfirm}
        cancelLabel={strings.status.keep}
        closeLabel={strings.sheets.close}
      />

      <PasswordSheet
        key={passwordSource ? passwordSource.id : "none"}
        open={passwordSource !== null}
        onClose={cancelPassword}
        onSubmit={(value) => void submitPassword(value)}
        onCancel={cancelPassword}
        busy={passwordState.busy}
        wrong={passwordState.wrong}
        failed={passwordState.failed}
        attempt={passwordState.attempt}
        fileName={passwordSource?.name}
        strings={t.tool.password}
      />
    </section>
  );
}
