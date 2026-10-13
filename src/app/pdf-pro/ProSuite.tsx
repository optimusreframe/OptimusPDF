"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { PdfErrorCode } from "@/lib/pdf/core";
import { toolHref, type ToolSlug } from "@/lib/tools-registry";
import { exportWarnings } from "@/app/pdf-pro/proAdapter";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import type { AutosaveIssue } from "@/app/pdf-pro/ProToolClient";
import { ImportInsertSheet } from "@/app/pdf-pro/create/ImportInsertSheet";
import { useProSave } from "@/app/pdf-pro/save/useProSave";
import { limitWarnings } from "@/app/pdf-pro/session/proLimits";
import { RecentSheet } from "@/app/pdf-pro/session/RecentSheet";
import { isTextEditingTarget, modalSheetOpen } from "@/app/pdf-pro/proShortcuts";
import { formatProDate, getProStrings, proWarningText } from "@/app/pdf-pro/proStrings";
import { ProTabs, proPanelDomId, proTabDomId, type ProTabId } from "@/app/pdf-pro/ProTabs";
import { ProTopBar } from "@/app/pdf-pro/ProTopBar";
import type { ProOperation } from "@/app/pdf-pro/proTypes";
import { CommandPalette } from "@/app/pdf-pro/shell/CommandPalette";
import type { MoreMenuItem } from "@/app/pdf-pro/shell/MoreMenu";
import { ProMobileDock } from "@/app/pdf-pro/shell/ProMobileDock";
import { ResizeHandle } from "@/app/pdf-pro/shell/ResizeHandle";
import { ShortcutsSheet } from "@/app/pdf-pro/shell/ShortcutsSheet";
import { getProAction } from "@/app/pdf-pro/shell/proActions";
import { useRegisteredCommands } from "@/app/pdf-pro/shell/proCommands";
import {
  CONTEXT_WIDTH,
  THUMBS_WIDTH,
  clampContextWidth,
  clampThumbsWidth,
  fitPanels,
  useProLayout,
} from "@/app/pdf-pro/shell/proLayout";
import { focusRegion, useRegionShortcuts, type ProRegionId } from "@/app/pdf-pro/shell/proRegions";
import { goToPageCommands, useBuiltInCommands } from "@/app/pdf-pro/shell/useBuiltInCommands";
import { useElementWidth } from "@/app/pdf-pro/shell/useElementWidth";
import { useIsDesktop } from "@/app/pdf-pro/shell/useIsDesktop";
import { PRO_TAB_CONTENT } from "@/app/pdf-pro/tabs/proTabContent";
import { useProOperation } from "@/app/pdf-pro/useProOperation";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { ProViewer } from "@/app/pdf-pro/viewer/ProViewer";
import { ProThumbnails } from "@/app/pdf-pro/viewer/ProThumbnails";
import { ProViewerProvider, useProViewer } from "@/app/pdf-pro/viewer/ProViewerContext";
import { ViewerToolbar } from "@/app/pdf-pro/viewer/ViewerToolbar";
import { ProModeHost, ProModeResult, ProModeSheets } from "@/app/pdf-pro/modes/ProModeHost";
import { getProMode } from "@/app/pdf-pro/modes/proModes";
import { useModeCommands } from "@/app/pdf-pro/modes/useModeCommands";
import { useProModeSession } from "@/app/pdf-pro/modes/useProModeSession";

/** Pestañas que pueden tener un modo con sesion propia (Editar, Anotar, Firmar, Rellenar). */
const MODE_TAB_IDS: readonly ProTabId[] = ["edit", "annotate", "sign"];

export type ProSuiteProps = {
  /** El ultimo archivo que se intento abrir no sirvio (corrupto, vacio, no PDF, cifrado...): se explica aqui. */
  intakeProblem?: { code: PdfErrorCode; fileName: string | null } | null;
  onDismissProblem?: () => void;
  /** Para llevar el foco al aviso cuando aparece un problema nuevo. */
  problemBannerRef?: Ref<HTMLDivElement>;
  /** El borrador automatico no se pudo guardar (se avisa; el cierre de la pestaña pedira confirmacion). */
  autosaveIssue?: AutosaveIssue;
  /** «Abrir otro PDF…» (ya con la confirmacion de cambios sin descargar). */
  onOpenFile?: (file: File) => void;
  /** Abre un reciente (borrador). */
  onOpenDraft?: (id: string) => void;
  onNewFromImages?: () => void;
  onNewBlank?: () => void;
  openedFrom: ToolSlug | null;
  /** PDF que habia en la herramienta de origen: si son varios, solo se abrio el primero y se avisa. */
  openedTotal?: number;
  draftOffer: ProDraftSummary | null;
  draftBusy: boolean;
  onRestoreDraft: () => void;
  onDiscardDraft: () => void;
  onClose: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
};

/**
 * La suite (Wave 7 · U1 + U3): barra superior, pestañas, panel de miniaturas, visor de desplazamiento continuo
 * y panel contextual. Monta el proveedor del visor (documento de pdf.js del snapshot vigente, estado de pagina
 * y zoom, seleccion) y reparte el espacio:
 *  - escritorio (>= 768 px): miniaturas y panel contextual a los lados, redimensionables con raton y teclado y
 *    plegables, con su ancho guardado en este navegador;
 *  - movil: el visor ocupa todo el ancho; las miniaturas y el panel de cada herramienta son hojas, y las
 *    herramientas se eligen en una barra inferior tactil.
 * El contenido de cada pestaña lo pone `PRO_TAB_CONTENT`.
 */
export function ProSuite(props: ProSuiteProps) {
  const { document, doc, pageCount } = useProWorkingDoc();
  const snapshots = document?.snapshots;
  const cursor = document?.cursor ?? 0;
  // La pestaña vive aqui (no en el cuerpo) porque decide si el visor tiene el PDF abierto: con un modo activo
  // (Editar, Anotar...) el visor SUELTA su documento de pdf.js y el modo abre el suyo (nunca dos a la vez).
  const [tab, setTab] = useState<ProTabId>("home");
  const modeActive = getProMode(tab) !== undefined;
  const snapshot = useMemo(() => {
    const current = snapshots?.[cursor];
    return current && !modeActive ? { id: current.id, bytes: current.bytes } : null;
  }, [snapshots, cursor, modeActive]);
  const announce = useCallback((text: string) => doc.announce(text), [doc]);
  const getAnnouncementId = useCallback(() => doc.getState().announcement?.id ?? null, [doc]);
  if (!document) return null;
  return (
    <ProViewerProvider
      snapshot={snapshot}
      pageCountHint={pageCount}
      announce={announce}
      getAnnouncementId={getAnnouncementId}
    >
      <ProSuiteBody {...props} tab={tab} setTab={setTab} />
    </ProViewerProvider>
  );
}

function ProSuiteBody({
  intakeProblem = null,
  onDismissProblem,
  problemBannerRef,
  autosaveIssue = null,
  onOpenFile,
  onOpenDraft,
  onNewFromImages,
  onNewBlank,
  openedFrom,
  openedTotal = 1,
  draftOffer,
  draftBusy,
  onRestoreDraft,
  onDiscardDraft,
  onClose,
  headingRef,
  tab,
  setTab,
}: ProSuiteProps & { tab: ProTabId; setTab: (tab: ProTabId) => void }) {
  const { t, language } = useI18n();
  const strings = getProStrings(language);
  const s = strings.suite;
  const shell = strings.shell;
  const baseId = useId();
  const thumbsId = `${baseId}-thumbs`;
  const rootRef = useRef<HTMLElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sheet, setSheet] = useState<"thumbs" | "panel" | null>(null);
  const state = useProWorkingDoc();
  const { doc, document, dirty, canUndo, canRedo, pageCount } = state;
  const warnings = useMemo(() => exportWarnings(state), [state]);
  const sizeWarnings = useMemo(() => limitWarnings(state.document), [state.document]);
  const viewer = useProViewer();
  const isDesktop = useIsDesktop();
  const { prefs: layoutPrefs, update: updateLayout, commit: commitLayout, reset: resetLayout } = useProLayout();
  const run = useProOperation();
  const rowWidth = useElementWidth(rowRef);
  const fitted = useMemo(() => fitPanels(rowWidth, layoutPrefs), [rowWidth, layoutPrefs]);
  useRegionShortcuts(rootRef);

  /* ------------------------ modos (Editar, Anotar, Firmar...) ------------------------ */

  const pendingPageRef = useRef<number | null>(null);
  const isDesktopRef = useRef(isDesktop);
  useEffect(() => {
    isDesktopRef.current = isDesktop;
  });
  /** Devuelve el foco al control de esa pestaña (la de arriba en escritorio, el dock en movil): nunca a <body>. */
  const focusTabControl = useCallback((target: ProTabId) => {
    let frames = 0;
    const attempt = () => {
      const root = rootRef.current;
      if (!root) return;
      const control = root.querySelector<HTMLElement>(
        isDesktopRef.current ? `[role="tab"][data-tab="${target}"]` : `[data-dock="${target}"]`,
      );
      if (control) {
        control.focus({ preventScroll: true });
        if (window.document.activeElement === control) return;
      }
      frames += 1;
      if (frames < 30) window.requestAnimationFrame(attempt);
    };
    window.requestAnimationFrame(attempt);
  }, []);
  const modeSession = useProModeSession({
    tab,
    setTab,
    language,
    focusTab: focusTabControl,
    getViewerPage: () => viewer.api.getCurrentPage(),
    restoreViewerPage: (page) => {
      pendingPageRef.current = page;
    },
  });
  const modeActive = modeSession.active;
  const { guard: guardMode, setIntent: setModeIntent } = modeSession;
  const showThumbs = isDesktop && fitted.showThumbs && !modeActive;
  const showContext = isDesktop && fitted.showContext && !modeActive;

  /* «Retomar» o «Descartar» borrador quitan la oferta (con el boton que tenia el foco): el foco pasa al titulo del
     documento en el MISMO commit, sin pasar por <body> (WCAG 2.4.3). */
  const hadOfferRef = useRef(draftOffer !== null);
  useLayoutEffect(() => {
    const had = hadOfferRef.current;
    hadOfferRef.current = draftOffer !== null;
    if (!had || draftOffer !== null) return;
    const active = window.document.activeElement;
    if (active && active !== window.document.body && active.isConnected) return;
    rootRef.current?.querySelector<HTMLElement>('[data-pro-region="top"] h1')?.focus({ preventScroll: true });
  }, [draftOffer]);

  /* En movil, al cerrarse una hoja (tras aplicar o descartar desde otra hoja el foco pudo no tener adonde volver) el foco
     nunca queda en <body>: pasa al boton del dock de la pestaña actual. */
  const previousSheetRef = useRef(sheet);
  useEffect(() => {
    const previous = previousSheetRef.current;
    previousSheetRef.current = sheet;
    if (isDesktop || sheet !== null || previous === null) return;
    const timer = window.setTimeout(() => {
      const active = window.document.activeElement;
      if (!active || active === window.document.body) focusTabControl(tab);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [sheet, isDesktop, tab, focusTabControl]);

  /* Al volver al visor tras un modo, se lleva a la pagina en la que se trabajaba (sin anunciarla encima de «Aplicado»). */
  const viewerReady = viewer.state.ready;
  useEffect(() => {
    const page = pendingPageRef.current;
    if (page === null || modeActive || !viewerReady) return;
    pendingPageRef.current = null;
    viewer.api.scrollToPage(page, { behavior: "instant", silent: true });
  }, [modeActive, viewerReady, viewer.api]);

  /* ------------------------ acciones ------------------------ */

  // Descargar, guardar como y guardar con contraseña (Wave 7 · U8): con un modo abierto y cambios sin aplicar,
  // descargar pregunta antes (aplicar y descargar lo aplicado, o descartar).
  const save = useProSave(guardMode);
  const { download } = save;
  const [saveMenuSignal, setSaveMenuSignal] = useState(0);

  const requestClose = useCallback(() => {
    guardMode(() => {
      // D7: un paso en vuelo (operacion corriendo o confirmacion encolada) cuenta como cambios pendientes.
      const state = doc.getState();
      if (state.dirty || state.stepInFlight) setConfirmClose(true);
      else onClose();
    });
  }, [doc, onClose, setConfirmClose, guardMode]);

  /** Elige una pestaña: en escritorio reabre el panel si estaba plegado; en movil abre su hoja. */
  const goToTabNow = useCallback(
    (next: ProTabId, after?: () => void) => {
      setTab(next);
      after?.();
      // Un modo ocupa la region central entera: ni panel lateral ni hoja.
      if (getProMode(next)) {
        setSheet(null);
        return;
      }
      if (isDesktop) {
        if (!layoutPrefs.contextOpen || fitted.contextAutoHidden) {
          updateLayout({ contextOpen: true, thumbsOpen: fitted.contextAutoHidden ? false : layoutPrefs.thumbsOpen });
        }
      } else {
        setSheet("panel");
      }
    },
    [isDesktop, layoutPrefs, updateLayout, fitted.contextAutoHidden, setTab, setSheet],
  );

  /** Igual, pero saliendo de un modo con cambios sin aplicar pregunta antes (aplicar, descartar o seguir). */
  const goToTab = useCallback(
    (next: ProTabId, after?: () => void) => {
      if (next === tab) goToTabNow(next, after);
      else guardMode(() => goToTabNow(next, after));
    },
    [tab, goToTabNow, guardMode],
  );

  /** «Editar texto», «Añadir imagen»...: abre el modo y le pide la herramienta (paleta de comandos y atajos). */
  const enterMode = useCallback(
    (target: "edit" | "annotate" | "sign", tool?: string) => {
      goToTab(target, () => setModeIntent(tool ?? null));
    },
    [goToTab, setModeIntent],
  );
  useModeCommands({ language, enterMode });

  const exportDocument = useCallback(() => {
    const override = getProAction("export");
    if (override) override();
    else goToTab("convert");
  }, [goToTab]);

  /* ------------------------ crear e importar (Wave 7 · U8) ------------------------ */

  const [importFile, setImportFile] = useState<File | null>(null);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [moreMenuSignal, setMoreMenuSignal] = useState(0);
  const importInput = useRef<HTMLInputElement>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const pickImport = useCallback(() => guardMode(() => importInput.current?.click()), [guardMode]);
  const pickOpen = useCallback(() => guardMode(() => openInput.current?.click()), [guardMode]);
  const mergePdfs = useCallback(() => goToTab("pages"), [goToTab]);
  const openRecents = useCallback(() => setRecentsOpen(true), [setRecentsOpen]);

  const toggleThumbs = useCallback(() => {
    if (!isDesktop) {
      setSheet((value) => (value === "thumbs" ? null : "thumbs"));
      return;
    }
    if (fitted.thumbsAutoHidden || !layoutPrefs.thumbsOpen) {
      // Pedir las miniaturas sin sitio: se pliega el panel contextual para dejarles espacio.
      updateLayout({ thumbsOpen: true, contextOpen: fitted.thumbsAutoHidden ? false : layoutPrefs.contextOpen });
    } else {
      updateLayout({ thumbsOpen: false });
    }
  }, [isDesktop, fitted.thumbsAutoHidden, layoutPrefs, updateLayout, setSheet]);

  const togglePanel = useCallback(() => {
    if (!isDesktop) {
      setSheet((value) => (value === "panel" ? null : "panel"));
      return;
    }
    if (fitted.contextAutoHidden || !layoutPrefs.contextOpen) {
      updateLayout({ contextOpen: true, thumbsOpen: fitted.contextAutoHidden ? false : layoutPrefs.thumbsOpen });
    } else {
      updateLayout({ contextOpen: false });
    }
  }, [isDesktop, fitted.contextAutoHidden, layoutPrefs, updateLayout, setSheet]);

  const applyOperation = useCallback(
    (operation: ProOperation<unknown>) => {
      guardMode(() => {
        void run.apply(operation, undefined).then((result) => {
          if (!result.ok && !result.cancelled) doc.announce(errorCopy(t, result.code).title);
        });
      });
    },
    [run, doc, t, guardMode],
  );

  const openTool = useCallback(
    (slug: ToolSlug) => {
      // Navegacion completa: el borrador automatico se vuelca al salir (`beforeunload`).
      guardMode(() => window.location.assign(toolHref(slug)));
    },
    [guardMode],
  );

  /* ------------------------ paleta (Ctrl/Cmd+K) ------------------------ */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      // Escribiendo en un campo (incluido el de la propia paleta) el atajo no se secuestra.
      if (isTextEditingTarget(event.target)) return;
      // Con otra hoja modal abierta no se apila la paleta.
      if (modalSheetOpen()) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* Ctrl/Cmd+S descarga el PDF y Ctrl/Cmd+Mayus+S abre «Guardar y exportar» (en movil, el menu «Mas»): el navegador
     NO llega a ofrecer «Guardar la pagina». Con una hoja modal abierta no se actua. */
  const downloadRef = useRef(download);
  useEffect(() => {
    downloadRef.current = download;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (modalSheetOpen()) return;
      event.preventDefault();
      if (!event.shiftKey) {
        downloadRef.current();
      } else if (window.matchMedia?.("(min-width: 640px)").matches ?? true) {
        setSaveMenuSignal((value) => value + 1);
      } else {
        setMoreMenuSignal((value) => value + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* E abre Editar y A abre Anotar (solo fuera de un modo y de campos de texto: dentro, E es la elipse y A no hace nada). */
  const modeActiveRef = useRef(modeActive);
  useEffect(() => {
    modeActiveRef.current = modeActive;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== "e" && key !== "a" && key !== "s" && key !== "f") return;
      if (modeActiveRef.current) return;
      if (isTextEditingTarget(event.target) || isTextEditingTarget(window.document.activeElement)) return;
      if (modalSheetOpen()) return;
      event.preventDefault();
      if (key === "e") enterMode("edit");
      else if (key === "a") enterMode("annotate");
      else if (key === "s") enterMode("sign", "sign");
      else enterMode("sign", "fill");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enterMode]);

  const builtIn = useBuiltInCommands({
    enabled: paletteOpen,
    language,
    t,
    api: viewer.api,
    pageCount: viewer.state.pageCount,
    canUndo: canUndo && !modeActive,
    canRedo: canRedo && !modeActive,
    busy: run.status === "running",
    goToTab,
    applyOperation,
    undo: () => doc.undo(),
    redo: () => doc.redo(),
    download,
    exportDocument,
    saveAs: save.openSaveAs,
    saveWithPassword: save.openProtect,
    newFromImages: onNewFromImages,
    newBlank: onNewBlank,
    insertConvert: pickImport,
    mergePdfs,
    openAnother: onOpenFile ? pickOpen : undefined,
    openRecents: onOpenDraft ? openRecents : undefined,
    closeDocument: requestClose,
    openShortcuts: () => setShortcutsOpen(true),
    toggleThumbs,
    togglePanel,
    openTool,
  });
  const registered = useRegisteredCommands();
  const commands = useMemo(() => [...builtIn, ...registered], [builtIn, registered]);
  const dynamicCommands = useCallback(
    (query: string) => goToPageCommands(language, viewer.api, viewer.state.pageCount, query),
    [language, viewer.api, viewer.state.pageCount],
  );
  const announce = useCallback((text: string) => doc.announce(text), [doc]);

  if (!document) return null;

  const TabContent = PRO_TAB_CONTENT[tab];
  const panelBody = TabContent ? (
    <TabContent />
  ) : (
    <section aria-label={s.contextTitle}>
      <h2 className="ui-label mb-2 text-muted-foreground">{s.tabs[tab]}</h2>
      <p className="text-subheadline text-muted-foreground">{tab === "home" ? null : s.comingSoon[tab]}</p>
    </section>
  );

  const saveStrings = strings.save;
  const createStrings = strings.create;
  const saveItems: MoreMenuItem[] = [
    { id: "download", label: saveStrings.downloadPdf, shortcut: "Ctrl/⌘ S", onSelect: download },
    { id: "save-as", label: saveStrings.saveAs, onSelect: save.openSaveAs },
    { id: "save-protect", label: saveStrings.saveWithPassword, onSelect: save.openProtect },
    { id: "export", label: saveStrings.exportAs, separatorBefore: true, onSelect: exportDocument },
  ];

  const moreItems: MoreMenuItem[] = [
    { id: "palette", label: shell.paletteItem, shortcut: "Ctrl/⌘ K", onSelect: () => setPaletteOpen(true) },
    // En pantallas estrechas el menu «Guardar y exportar» no cabe en la barra: sus opciones viven aqui.
    { id: "download", label: saveStrings.downloadPdf, narrowOnly: true, separatorBefore: true, onSelect: download },
    { id: "save-as", label: saveStrings.saveAs, narrowOnly: true, onSelect: save.openSaveAs },
    { id: "save-protect", label: saveStrings.saveWithPassword, narrowOnly: true, onSelect: save.openProtect },
    { id: "export", label: shell.exportItem, onSelect: exportDocument },
    ...(onOpenFile ? [{ id: "open-another", label: createStrings.menu.openAnother, separatorBefore: true, onSelect: pickOpen }] : []),
    ...(onNewFromImages ? [{ id: "new-images", label: createStrings.menu.newFromImages, onSelect: onNewFromImages }] : []),
    ...(onNewBlank ? [{ id: "new-blank", label: createStrings.menu.newBlank, onSelect: onNewBlank }] : []),
    { id: "insert-convert", label: createStrings.menu.insertConvert, onSelect: pickImport },
    { id: "merge-pdfs", label: createStrings.menu.mergePdfs, onSelect: mergePdfs },
    ...(onOpenDraft ? [{ id: "recents", label: createStrings.menu.recents, onSelect: openRecents }] : []),
    {
      id: "thumbs",
      label: shell.thumbsItem,
      checked: isDesktop ? showThumbs : sheet === "thumbs",
      separatorBefore: true,
      onSelect: toggleThumbs,
    },
    ...(isDesktop
      ? [{ id: "panel", label: shell.panelItem, checked: showContext, onSelect: togglePanel }]
      : []),
    ...(isDesktop ? [{ id: "reset", label: shell.resetLayout, onSelect: resetLayout }] : []),
    { id: "shortcuts", label: shell.shortcutsItem, separatorBefore: true, onSelect: () => setShortcutsOpen(true) },
    { id: "close", label: shell.closeItem, narrowOnly: true, onSelect: requestClose },
  ];

  const skipTargets: { id: ProRegionId; label: string }[] = [
    { id: "viewer", label: shell.skipViewer },
    ...(showThumbs ? [{ id: "thumbs" as const, label: shell.skipThumbs }] : []),
    ...(showContext ? [{ id: "context" as const, label: shell.skipPanel }] : []),
  ];

  const running = run.status === "running";
  const problemCopy = intakeProblem ? errorCopy(t, intakeProblem.code, { fileProblem: true }) : null;

  return (
    <section
      ref={rootRef}
      aria-label={s.regionLabel}
      data-pro-suite=""
      data-layout={isDesktop ? "desktop" : "mobile"}
      className="flex h-[calc(100dvh-3.75rem-env(safe-area-inset-top,0px))] min-h-0 flex-col md:h-[calc(100dvh-4.25rem-env(safe-area-inset-top,0px))] lg:h-dvh"
    >
      <nav aria-label={shell.skipLabel} data-pro-skip="">
        {skipTargets.map((target) => (
          <button
            key={target.id}
            type="button"
            onClick={() => {
              if (rootRef.current) focusRegion(rootRef.current, target.id);
            }}
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-ios-sm focus:bg-signal focus:px-4 focus:text-subheadline focus:font-semibold focus:text-white focus:outline-2 focus:outline-offset-2 focus:outline-foreground"
          >
            {target.label}
          </button>
        ))}
      </nav>

      <ProTopBar
        language={language}
        name={document.name}
        pageCount={pageCount}
        dirty={dirty}
        canUndo={canUndo && !modeActive}
        canRedo={canRedo && !modeActive}
        onUndo={() => doc.undo()}
        onRedo={() => doc.redo()}
        onDownload={download}
        onClose={requestClose}
        moreItems={moreItems}
        saveItems={saveItems}
        saveMenuSignal={saveMenuSignal}
        moreMenuSignal={moreMenuSignal}
        headingRef={headingRef}
      />

      {running ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-3 py-2 md:px-4" data-pro-running="">
          <ProgressBar value={run.progress * 100} label={s.running} className="flex-1" />
          <Button variant="ghost" size="md" onClick={run.cancel}>
            {s.cancel}
          </Button>
        </div>
      ) : null}

      {intakeProblem ? (
        <div className="shrink-0 border-b border-hairline px-3 pt-2 md:px-4">
          <ErrorBanner
            show
            errorKey={`intake-${intakeProblem.code}`}
            title={problemCopy?.title ?? ""}
            message={problemCopy?.message ?? ""}
            hint={problemCopy?.hint}
            detail={intakeProblem.fileName ?? undefined}
            variant="error"
            onDismiss={onDismissProblem}
            dismissLabel={t.common.close}
            bannerRef={problemBannerRef}
            actions={
              intakeProblem.code === "encrypted" || intakeProblem.code === "certificateEncryption"
                ? [{ label: t.tool.errors.encryptedAction, href: toolHref("unlock-pdf"), primary: true }]
                : errorActions(t, intakeProblem.code)
            }
            className="mb-2"
          />
        </div>
      ) : null}

      {openedFrom || warnings.length > 0 || sizeWarnings.length > 0 || autosaveIssue || draftOffer ? (
        <div className="shrink-0 space-y-2 border-b border-hairline bg-white/3 px-3 py-2 md:px-4">
          {openedFrom ? (
            <p className="flex items-center gap-2 text-footnote text-muted-foreground">
              <Info aria-hidden="true" className="size-4 shrink-0" />
              {openedTotal > 1
                ? s.openedFromMany(t.tools[openedFrom].name, openedTotal)
                : s.openedFrom(t.tools[openedFrom].name)}
            </p>
          ) : null}
          {draftOffer ? (
            <div
              role="group"
              aria-label={strings.drafts.foundTitle}
              className="flex flex-wrap items-center gap-x-4 gap-y-2"
            >
              <p className="min-w-0 flex-1 text-footnote text-foreground">
                <span className="font-semibold">{strings.drafts.foundTitle}. </span>
                {strings.drafts.foundBody(draftOffer.steps, formatProDate(draftOffer.savedAt, language))}
              </p>
              {/* `flex-wrap`: con una tipografia ancha (DejaVu en Linux) los dos botones no caben en 375 px y «Descartar» salia cortado. */}
              <div className="flex flex-wrap gap-2">
                <Button size="md" onClick={onRestoreDraft} aria-disabled={draftBusy || undefined}>
                  {draftBusy ? strings.drafts.restoring : strings.drafts.restore}
                </Button>
                <Button size="md" variant="secondary" onClick={onDiscardDraft}>
                  {strings.drafts.discard}
                </Button>
              </div>
            </div>
          ) : null}
          {sizeWarnings.length > 0 || autosaveIssue ? (
            <div data-pro-limits="">
              <p className="flex items-center gap-2 text-footnote font-semibold text-foreground">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-accent-edit" />
                {strings.session.limitsTitle}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-footnote text-muted-foreground">
                {sizeWarnings.map((warning) => (
                  <li key={warning.code}>{proWarningText(language, warning)}</li>
                ))}
                {autosaveIssue ? (
                  <li data-autosave-issue={autosaveIssue}>
                    {autosaveIssue === "tooBig"
                      ? strings.drafts.saveTooBig
                      : autosaveIssue === "quota"
                        ? strings.drafts.saveQuota
                        : strings.drafts.saveFailed}
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {warnings.length > 0 ? (
            <div>
              <p className="flex items-center gap-2 text-footnote font-semibold text-foreground">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-accent-edit" />
                {s.warningsTitle}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-6 text-footnote text-muted-foreground">
                {warnings.map((warning) => (
                  <li key={warning.code}>{proWarningText(language, warning)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {isDesktop ? (
        <ProTabs
          language={language}
          value={tab}
          onChange={goToTab}
          baseId={baseId}
          controlsPanel={showContext || (modeActive && isDesktop)}
        />
      ) : null}

      <div ref={rowRef} data-pro-row="" className="flex min-h-0 flex-1">
        {showThumbs ? (
          <>
            <aside
              id={thumbsId}
              aria-label={s.thumbsTitle}
              data-pro-slot="thumbnails"
              data-pro-region="thumbs"
              className="flex shrink-0 flex-col border-r border-hairline p-2"
              style={{ width: fitted.thumbsWidth }}
            >
              <h2 className="ui-label mb-2 px-1 text-muted-foreground">{s.thumbsTitle}</h2>
              <ProThumbnails />
            </aside>
            <ResizeHandle
              label={shell.resizeThumbs}
              value={fitted.thumbsWidth}
              min={THUMBS_WIDTH.min}
              max={THUMBS_WIDTH.max}
              direction={1}
              controls={thumbsId}
              onChange={(value) => updateLayout({ thumbsWidth: clampThumbsWidth(value) }, false)}
              onCommit={commitLayout}
              onReset={() => updateLayout({ thumbsWidth: THUMBS_WIDTH.def })}
            />
          </>
        ) : null}

        <div
          role="region"
          aria-label={s.viewerTitle}
          data-pro-slot="viewer"
          data-pro-region="viewer"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {modeActive ? (
            <ProModeHost
              session={modeSession}
              panelId={proPanelDomId(baseId)}
              labelledBy={isDesktop ? proTabDomId(baseId, tab) : undefined}
            />
          ) : (
            <>
              <ProModeResult session={modeSession} />
              <ViewerToolbar
                thumbsOpen={isDesktop ? showThumbs : sheet === "thumbs"}
                thumbsControls={showThumbs ? thumbsId : undefined}
                onToggleThumbs={toggleThumbs}
                thumbsAsSheet={!isDesktop}
                contextOpen={showContext}
                contextControls={showContext ? proPanelDomId(baseId) : undefined}
                onToggleContext={isDesktop ? togglePanel : undefined}
              />
              <ProViewer />
            </>
          )}
        </div>

        {showContext ? (
          <>
            <ResizeHandle
              label={shell.resizeContext}
              value={fitted.contextWidth}
              min={CONTEXT_WIDTH.min}
              max={CONTEXT_WIDTH.max}
              direction={-1}
              controls={proPanelDomId(baseId)}
              onChange={(value) => updateLayout({ contextWidth: clampContextWidth(value) }, false)}
              onCommit={commitLayout}
              onReset={() => updateLayout({ contextWidth: CONTEXT_WIDTH.def })}
            />
            <div
              role="tabpanel"
              id={proPanelDomId(baseId)}
              aria-labelledby={proTabDomId(baseId, tab)}
              tabIndex={-1}
              data-pro-slot="context"
              data-pro-region="context"
              className={cn("shrink-0 overflow-y-auto border-l border-hairline p-4 outline-none")}
              style={{ width: fitted.contextWidth }}
            >
              {panelBody}
            </div>
          </>
        ) : null}
      </div>

      {!isDesktop ? (
        <ProMobileDock
          language={language}
          openTab={sheet === "panel" ? tab : null}
          modeTab={modeActive ? tab : null}
          modeTabs={MODE_TAB_IDS.filter((id) => getProMode(id) !== undefined)}
          onSelect={(next) => {
            if (sheet === "panel" && next === tab) setSheet(null);
            else goToTab(next);
          }}
        />
      ) : null}

      {/* Movil: miniaturas y panel de herramienta en hojas. */}
      <Sheet
        open={!isDesktop && sheet === "thumbs" && !modeActive}
        onClose={() => setSheet(null)}
        title={shell.thumbsSheetTitle}
        closeLabel={t.common.close}
      >
        <div className="flex h-[60dvh] min-h-0 flex-col">
          <ProThumbnails variant="grid" onAfterNavigate={() => setSheet(null)} />
        </div>
      </Sheet>
      <Sheet
        open={!isDesktop && sheet === "panel"}
        onClose={() => setSheet(null)}
        title={s.tabs[tab]}
        closeLabel={t.common.close}
      >
        <div data-pro-slot="context" data-pro-region="context">
          {panelBody}
        </div>
      </Sheet>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        dynamicCommands={dynamicCommands}
        announce={announce}
      />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ProModeSheets session={modeSession} />
      {save.sheets}
      <ImportInsertSheet open={importFile !== null} file={importFile} onClose={() => setImportFile(null)} />
      {onOpenDraft ? <RecentSheet open={recentsOpen} onClose={() => setRecentsOpen(false)} onOpen={onOpenDraft} /> : null}
      {/* Selectores de archivo ocultos: «Insertar desde Word, Excel o HTML» y «Abrir otro PDF». */}
      <input
        ref={importInput}
        type="file"
        accept=".docx,.xlsx,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-pro-import-input=""
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked) setImportFile(picked);
        }}
      />
      <input
        ref={openInput}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-pro-open-input=""
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked) onOpenFile?.(picked);
        }}
      />

      <ConfirmSheet
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={onClose}
        title={s.close}
        body={s.closeConfirmBody}
        confirmLabel={s.close}
        cancelLabel={s.cancel}
        closeLabel={t.common.close}
      />
    </section>
  );
}
