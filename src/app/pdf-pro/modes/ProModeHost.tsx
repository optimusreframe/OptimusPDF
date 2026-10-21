"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Hand, PanelBottomClose, PanelBottomOpen, X } from "lucide-react";
import { createBatchedSink, LiveSinkProvider } from "@/components/tool/liveRouting";
import { TrayProvider, type TrayTool, type TrayValue } from "@/components/tool/trayRouting";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { proWarningText } from "@/app/pdf-pro/proStrings";
import { useProMode, useProWorkingDoc, useProWorkingDocInstance } from "@/app/pdf-pro/useProWorkingDoc";
import { ProModeHostContext, type ProModeHostValue } from "@/app/pdf-pro/modes/modeContext";
import { useFocusReturn } from "@/app/pdf-pro/modes/modeFocus";
import { getModeStrings, modeBarName, modeShortName } from "@/app/pdf-pro/modes/modeStrings";
import type { ProModeSession } from "@/app/pdf-pro/modes/useProModeSession";
import { useCoarsePointer, useIsWideViewport } from "@/app/pdf-pro/shell/useIsDesktop";

/**
 * Host de modos de PDF Pro (Wave 7 · U6): monta el modo de la pestana activa EN LUGAR DEL VISOR, con su barra
 * («Editando · Aplicar · Descartar»), y registra el modo en el documento de trabajo con deshacer propio para que
 * el Ctrl/Cmd+Z global NO actue mientras se edita. La logica vive en `useProModeSession`.
 */
/** Dos avisos del modo con menos de este tiempo de diferencia se leen juntos. */
const MERGE_WINDOW_MS = 1200;

/**
 * (M2 · VP-01) Como se reparte el alto con el modo abierto. En escritorio la barra del modo va arriba (como siempre). En
 * movil el alto manda: la barra pasa ABAJO (el pulgar llega a «Aplicar» y «Descartar»), la paleta y los avisos del editor
 * se pliegan con un boton (el dock no), y en un movil horizontal (sin alto para otra fila) la barra se pinta dentro de la cabecera.
 */
export type ProModeHostLayout = {
  /** Reparto movil (hojas + dock): barra abajo y barras plegables. */
  mobile: boolean;
  /** Barras plegadas (paleta de herramientas, aviso de privacidad, «Aplanar»...): la hoja ocupa casi todo el alto. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Movil horizontal: la barra del modo se pinta en este hueco de la cabecera (si ya existe). */
  slot: HTMLElement | null;
  /** El dock inferior esta debajo de la barra: la barra no necesita su propia zona segura. */
  dockBelow: boolean;
  /** (M5) Se eligio una herramienta en la bandeja del movil: las barras se pliegan solas para devolverle el alto a la hoja. */
  onToolPicked: () => void;
};

const DESKTOP_LAYOUT: ProModeHostLayout = {
  mobile: false,
  collapsed: false,
  onToggleCollapsed: () => {},
  slot: null,
  dockBelow: false,
  onToolPicked: () => {},
};

export function ProModeHost({
  session,
  panelId,
  labelledBy,
  layout = DESKTOP_LAYOUT,
}: {
  session: ProModeSession;
  panelId: string;
  /** Id de la pestaña que lo abre (escritorio); sin el (movil: no hay pestañas) la region lleva su propia etiqueta. */
  labelledBy?: string;
  layout?: ProModeHostLayout;
}) {
  const { language } = useI18n();
  const { def } = session;
  if (!def) return null;
  return (
    <ProModeHostInner
      key={def.tab}
      session={session}
      def={def}
      panelId={panelId}
      labelledBy={labelledBy}
      language={language}
      layout={layout}
    />
  );
}

/**
 * Lo que se pliega con «Ocultar herramientas» (solo movil; el dock no): lo que el editor pinta ENCIMA y DEBAJO de la hoja y no es ella.
 * Se apoya en los marcadores del propio editor (`data-tool-palette`, `data-edit-privacy`, `data-page-actions`) y en los de
 * este host (`data-pro-fold`); la paleta solo se pliega en pantalla estrecha (en horizontal es una columna que no resta alto).
 */
const FOLD_CLASSES = [
  "data-[chrome=collapsed]:[&_[data-pro-fold]]:hidden",
  "data-[chrome=collapsed]:[&_[data-edit-privacy]]:hidden",
  "data-[chrome=collapsed]:max-md:[&_[data-tool-palette]]:hidden",
  "data-[chrome=collapsed]:max-md:[&_[data-page-actions]]:hidden",
].join(" ");

/**
 * Interruptor «Desplazar» (herramienta armada): mientras esta activo, un dedo sobre la hoja la DESPLAZA (`touch-action:
 * pan-y`) en vez de dibujar o colocar; un toque corto sigue colocando el elemento. Anula el `touch-none` que el editor
 * pone a la hoja con una herramienta armada, sin tocar el editor.
 */
const PAN_CLASSES = "data-[pan]:[&_[data-tool]]:touch-pan-y! data-[pan]:[&_[data-tool]]:touch-pan-x!";

/** (M5 · GE-01) El aviso «Para mover la página, activa Desplazar o usa dos dedos» se da UNA vez por navegador. */
const PAN_HINT_SEEN_KEY = "optimuspdf.pro.panHintSeen";
/** (M6 · f) El aviso tapa la hoja: se lee en 4 s y se retira solo. */
const PAN_HINT_MS = 4000;

function panHintSeen(): boolean {
  try {
    return window.localStorage.getItem(PAN_HINT_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markPanHintSeen(): void {
  try {
    window.localStorage.setItem(PAN_HINT_SEEN_KEY, "1");
  } catch {
    // Sin almacenamiento el aviso puede repetirse: no rompe nada.
  }
}

function ProModeHostInner({
  session,
  def,
  panelId,
  labelledBy,
  language,
  layout,
}: {
  session: ProModeSession;
  def: NonNullable<ProModeSession["def"]>;
  panelId: string;
  labelledBy?: string;
  language: "es" | "en";
  layout: ProModeHostLayout;
}) {
  const m = getModeStrings(language);
  const { busy, dirty, error, hasControls } = session;
  const { doc, document } = useProWorkingDoc();
  const snapshot = doc.currentSnapshot();
  const file = doc.currentFile();

  // Mientras el modo esta abierto tiene su propio deshacer: el global no actua.
  useProMode(def.id, { hasOwnUndo: true });

  const [subName, setSubName] = useState<"sign" | "fill" | null>(null);
  const modeName = modeBarName(language, subName ?? def.tab);
  const coarse = useCoarsePointer();
  const panHintId = useId();
  const trayId = useId();
  // «Desplazar» solo tiene sentido con un dedo y en los modos que dibujan sobre la hoja (Editar y Anotar).
  const [pan, setPan] = useState(false);
  const panAvailable = coarse && (def.tab === "edit" || def.tab === "annotate");
  // Al salir del modo, el foco nunca cae a <body> en el instante en que se retira la barra (sus botones).
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useFocusReturn(rootRef, barRef);
  /*
   * Todo lo que el modo dice (entrar, campos detectados, avisos...) sale por la UNICA region viva de PDF Pro. Un aviso que
   * llega en el segundo siguiente a otro se SUMA a el en vez de pisarlo («Anotar: modo abierto... Buscando campos...»).
   */
  const speak = useCallback((text: string) => doc.announce(text, { mergeWithinMs: MERGE_WINDOW_MS }), [doc]);
  useEffect(() => {
    speak(m.host.entered(modeShortName(language, def.tab)));
  }, [speak, m, language, def.tab]);

  const { mobile, collapsed, onToggleCollapsed, slot, dockBelow, onToolPicked } = layout;
  // En un movil horizontal la barra va dentro de la cabecera (si su hueco ya existe); si no, abajo.
  const inSlot = mobile && slot !== null;
  const bottom = mobile && !inSlot;

  /*
   * (M5 · N2) Bandeja de herramientas del telefono vertical: la paleta, «Aplanar», el aviso de privacidad y el interruptor de
   * Anotar flotan sobre el borde inferior de la hoja (no le restan alto) y se cierran al elegir una herramienta. En horizontal,
   * en tablet y en escritorio la paleta es una columna lateral y no hay bandeja.
   */
  const trayMode = mobile && (def.tab === "edit" || def.tab === "annotate");
  // En horizontal (dock como raíl) con 768 px o mas la paleta sigue siendo la columna lateral: la bandeja solo lleva «Aplanar» y la
  // privacidad. (M6) Con menos (667×375, 568×320) no hay sitio para la columna: la paleta va en la bandeja, como en vertical
  // (antes la bandeja la tapaba y las herramientas no se alcanzaban).
  const wide = useIsWideViewport();
  const trayPalette = trayMode && (dockBelow || !wide);
  const [paletteEl, setPaletteEl] = useState<HTMLDivElement | null>(null);
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);
  const [privacyEl, setPrivacyEl] = useState<HTMLDivElement | null>(null);
  // (M6 · a) Deshacer y rehacer del editor van en la barra del modo, siempre a la vista (la bandeja tapa la hoja).
  const [historyEl, setHistoryEl] = useState<HTMLDivElement | null>(null);
  const [trayTool, setTrayTool] = useState<TrayTool | null>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const handleToolPicked = useCallback(() => {
    // Con el foco dentro de la bandeja (teclado) este pasa al boton de la barra; si la eleccion vino de fuera, no se roba.
    const hadFocus = trayRef.current?.contains(window.document.activeElement) ?? false;
    onToolPicked();
    if (hadFocus) window.requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
  }, [onToolPicked]);
  /* (M5 · GE-01) Aviso de UNA vez: con la primera herramienta armada con el dedo se dice como mover la pagina. */
  const [panHint, setPanHint] = useState(false);
  const armedNow = trayTool !== null;
  const reportTool = useCallback(
    (tool: TrayTool | null) => {
      setTrayTool(tool);
      if (!tool || !panAvailable || panHintSeen()) return;
      markPanHintSeen();
      setPanHint(true);
      speak(m.host.panFirstHint);
    },
    [panAvailable, speak, m],
  );
  useEffect(() => {
    if (!panHint) return;
    const timer = window.setTimeout(() => setPanHint(false), PAN_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [panHint]);
  const hintVisible = panHint && armedNow && !pan;

  const trayValue = useMemo<TrayValue | null>(
    () =>
      trayMode
        ? {
            slots: trayPalette
              ? { palette: paletteEl, actions: actionsEl, privacy: privacyEl, history: historyEl }
              : { actions: actionsEl, privacy: privacyEl, history: historyEl },
            onToolPicked: handleToolPicked,
            reportTool,
          }
        : null,
    [trayMode, trayPalette, paletteEl, actionsEl, privacyEl, historyEl, handleToolPicked, reportTool],
  );
  const showTray = trayMode && !collapsed;
  const activeTool = trayMode ? trayTool : null;

  // Abrir la bandeja con el boton lleva el foco a la herramienta activa de la paleta (sin esto el teclado se queda atras).
  const wasTrayShown = useRef(showTray);
  useEffect(() => {
    const was = wasTrayShown.current;
    wasTrayShown.current = showTray;
    if (!showTray || was) return;
    const frame = window.requestAnimationFrame(() => {
      if (!trayRef.current?.contains(window.document.activeElement) && window.document.activeElement === toggleRef.current) {
        trayRef.current?.querySelector<HTMLElement>('[data-tool-palette] [tabindex="0"]')?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showTray]);

  const value = useMemo<ProModeHostValue>(
    () => ({
      tab: def.tab,
      initialPage: session.entryPage,
      reportPage: session.reportPage,
      registerControls: session.registerControls,
      intent: session.intent,
      busy,
      reportName: setSubName,
    }),
    [def.tab, session.entryPage, session.reportPage, session.registerControls, session.intent, busy],
  );

  const onCancel = useCallback(() => session.requestDiscard(), [session]);
  // Los avisos del modo (campos detectados, deshacer, etc.) salen por la UNICA region viva de PDF Pro.
  const sink = useMemo(() => createBatchedSink(speak), [speak]);

  if (!document || !snapshot || !file) return null;
  const Component = def.Component;
  const canApply = hasControls && dirty && !busy;

  const toggleLabel = collapsed
    ? activeTool
      ? m.host.showToolsActive(activeTool.label)
      : m.host.showTools
    : m.host.hideTools;
  const ToolIcon = collapsed && activeTool ? activeTool.icon : null;

  const controls = (
    <>
      {mobile ? (
        <button
          ref={toggleRef}
          type="button"
          data-pro-fold-toggle=""
          data-tool-active={ToolIcon ? activeTool?.id : undefined}
          aria-expanded={!collapsed}
          aria-controls={trayMode ? trayId : undefined}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleCollapsed}
          className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]"
        >
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full text-foreground transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-active:scale-90 group-active:duration-[80ms] forced-colors:border forced-colors:border-[ButtonText]",
              ToolIcon && "bg-signal/15 text-signal-text",
            )}
          >
            {ToolIcon ? (
              <ToolIcon aria-hidden="true" className="size-[18px]" />
            ) : collapsed ? (
              <PanelBottomOpen aria-hidden="true" className="size-[18px]" />
            ) : (
              <PanelBottomClose aria-hidden="true" className="size-[18px]" />
            )}
          </span>
        </button>
      ) : null}
      {/* (M6 · a) Deshacer y rehacer del editor (el editor los pinta aqui con un portal): a 44 px y siempre a la vista. */}
      {trayMode ? <div ref={setHistoryEl} data-pro-history="" className={cn("contents", busy && "max-[479px]:hidden")} /> : null}
      {panAvailable ? (
        <button
          type="button"
          role="switch"
          aria-checked={pan}
          data-pro-pan-toggle=""
          aria-describedby={panHintId}
          title={m.host.panHint}
          onClick={() => setPan((value) => !value)}
          className={cn(
            "flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-ios-sm px-2.5 text-subheadline font-medium text-muted-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
            "aria-checked:bg-signal/15 aria-checked:text-foreground forced-colors:border forced-colors:border-[ButtonText] forced-colors:aria-checked:border-2 forced-colors:aria-checked:border-[Highlight]",
          )}
        >
          <Hand aria-hidden="true" className="size-4" />
          {/* Texto a la vista solo cuando sobra sitio (M6: con deshacer y rehacer en la misma barra son 700 px en vertical y 840 en la cabecera horizontal); si no, el icono (nombre accesible completo). */}
          <span className={inSlot ? "max-[839px]:sr-only" : "max-[699px]:sr-only"}>{m.host.panLabel}</span>
        </button>
      ) : null}
      {panAvailable ? (
        <span id={panHintId} className="sr-only">
          {m.host.panHint}
        </span>
      ) : null}
    </>
  );

  const actions = hasControls ? (
    // `ml-auto`: bajo 560 px el parrafo del nombre sale del flujo y no empuja «Descartar»/«Aplicar» al borde derecho.
    <div className="ml-auto flex shrink-0 items-center gap-2">
      {busy && session.hasControls ? (
        <Button variant="ghost" size="md" data-pro-mode-cancel="" className="max-[479px]:px-2" onClick={session.cancelApply}>
          {m.host.cancelApply}
        </Button>
      ) : null}
      <Button
        variant="secondary"
        size="md"
        data-pro-mode-discard=""
        aria-disabled={busy || undefined}
        className={cn(
          "aria-disabled:opacity-50",
          // (M6 · H1) En movil «Descartar» es un icono de 44 px (nombre accesible completo): con texto solo desde 700 px en vertical; siempre icono en la cabecera.
          inSlot ? "w-11 px-0!" : mobile && "max-[699px]:w-11 max-[699px]:px-0",
          busy && "max-[479px]:hidden",
        )}
        onClick={() => {
          if (!busy) session.requestDiscard();
        }}
      >
        <X aria-hidden="true" className="size-4" />
        <span className={inSlot ? "sr-only" : mobile ? "max-[699px]:sr-only" : undefined}>{m.host.discard}</span>
      </Button>
      <Button
        variant="primary"
        size="md"
        data-pro-mode-apply=""
        aria-disabled={!canApply || undefined}
        // Con `aria-disabled` el boton se ve igual que uno activo: se le da el aspecto apagado.
        className={cn(
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:shadow-none",
          // (M6 · H1) «Aplicar» nunca se corta: con texto cuando cabe (≥ 390 px en vertical, ≥ 760 px en la cabecera horizontal con
          // 59 px de zona segura por lado) y, si no, un boton de 44 px con la marca (nombre accesible «Aplicar»); el relleno
          // primario lo distingue de «Descartar». `!`: `cn` no fusiona clases y `px-5`/`text-callout` del boton base ganarian.
          mobile && (inSlot ? "gap-1.5 px-3! text-subheadline! max-[759px]:w-11 max-[759px]:px-0!" : "gap-1.5 px-3! text-subheadline! max-[389px]:w-11 max-[389px]:px-0!"),
        )}
        onClick={() => {
          if (canApply) session.requestApply();
          else if (!busy) doc.announce(m.host.noChanges);
        }}
      >
        <Check aria-hidden="true" className="size-4" />
        <span className={mobile ? (inSlot ? "max-[759px]:sr-only" : "max-[389px]:sr-only") : undefined}>{busy ? m.host.applying : m.host.apply}</span>
      </Button>
    </div>
  ) : null;

  const bar = (
    <div
      ref={barRef}
      role="group"
      aria-label={m.host.barLabel}
      data-pro-mode-bar=""
      data-placement={inSlot ? "header" : bottom ? "bottom" : "top"}
      className={cn(
        "relative flex items-center gap-x-2 gap-y-1",
        inSlot
          ? // (M5 · N1) Dentro de la cabecera la barra NO se encoge: lo que no cabe lo cede el titulo del documento (que se trunca),
            // nunca «Aplicar» (antes se pisaba con «Descargar» al sumar las zonas seguras de un iPhone horizontal).
            "shrink-0"
          : bottom
            ? cn(
                "shrink-0 border-t border-hairline bg-background px-2 py-1",
                // Sin el dock debajo (plegado) la barra hace de borde inferior: respeta la zona segura del iPhone.
                dockBelow ? "" : "pb-[max(0.25rem,env(safe-area-inset-bottom,0px))]",
              )
            : "shrink-0 flex-wrap gap-x-3 border-b border-hairline px-3 py-1.5 md:px-4",
      )}
    >
      {controls}
      <p
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 text-subheadline font-semibold text-foreground",
          // (M6 · H1) Bajo 560 px el nombre solo queda para lectores: el parrafo sale del flujo (si no, aporta dos huecos de 8 px).
          inSlot ? "max-lg:sr-only" : mobile && "max-[559px]:sr-only",
        )}
      >
        {/* (M5 · N4, M6) El nombre del modo se lee ENTERO o no se pinta (el dock ya marca la pestaña): nada de «E…» / «A…».
            Desde 560 px sobra sitio junto a los botones; `shrink-0`: el que cede es el texto de estado, nunca el nombre. */}
        <span data-pro-mode-name="" className={mobile ? "shrink-0 max-[559px]:sr-only" : undefined}>
          {modeName}
        </span>
        {/* En el movil el estado cabe como un punto (la barra ya es estrecha); el texto sigue para lectores de pantalla. */}
        <span
          aria-hidden="true"
          data-pro-mode-dot=""
          className={
            dirty
              ? "size-2 shrink-0 rounded-full bg-signal sm:hidden forced-colors:bg-[Highlight]"
              : "hidden"
          }
        />
        <span
          data-pro-mode-state=""
          className="truncate text-footnote font-normal text-muted-foreground max-sm:sr-only"
        >
          {busy ? m.host.applying : dirty ? m.host.dirty : m.host.clean}
        </span>
        {busy ? <Spinner className="size-4" /> : null}
      </p>
      {actions}
      {hintVisible ? (
        <p
          data-pro-pan-first-hint=""
          className={cn(
            "surface-card shadow-elevation-2 pointer-events-none absolute z-40 rounded-ios px-3 py-2 text-footnote text-foreground",
            inSlot ? "top-[calc(100%+0.5rem)] right-0 w-72" : "inset-x-2 bottom-[calc(100%+0.5rem)]",
          )}
        >
          {m.host.panFirstHint}
        </p>
      ) : null}
    </div>
  );

  return (
    <div
      ref={rootRef}
      role={labelledBy ? "tabpanel" : "group"}
      id={panelId}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : m.host.regionLabel(modeShortName(language, def.tab))}
      tabIndex={-1}
      data-pro-mode-host=""
      data-mode={def.tab}
      data-dirty={dirty ? "" : undefined}
      data-busy={busy ? "" : undefined}
      data-chrome={mobile && collapsed ? "collapsed" : undefined}
      data-pan={pan && panAvailable ? "" : undefined}
      data-armed-tool={activeTool?.id}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col outline-none", FOLD_CLASSES, PAN_CLASSES)}
    >
      {bottom || inSlot ? null : bar}

      {error ? (
        <p
          role="alert"
          data-pro-mode-error=""
          className="flex shrink-0 items-start gap-2 border-b border-hairline px-3 py-2 text-footnote text-destructive-text md:px-4"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      <div
        data-pro-mode-body=""
        // Escape dentro de la bandeja la cierra. El manejador va AQUI y no en la bandeja: las piezas llegan por portal y los eventos
        // de React suben por el arbol de React (el editor), no por el DOM de la bandeja; se comprueba por DOM que viene de ella.
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !showTray || !trayRef.current?.contains(event.target as Node)) return;
          event.stopPropagation();
          onToggleCollapsed();
          window.requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
        }}
        className={cn("relative min-h-0 min-w-0 flex-1 overflow-hidden", mobile ? "p-1 sm:p-2" : "p-2 md:p-3")}
      >
        <ProModeHostContext.Provider value={value}>
          <LiveSinkProvider value={sink}>
            <TrayProvider value={trayValue}>
              <Component
                key={`${document.id}:${snapshot.id}`}
                file={file}
                bytes={snapshot.bytes}
                lang={language}
                onApply={session.onApply}
                onCancel={onCancel}
                onDirtyChange={session.onDirtyChange}
              />
            </TrayProvider>
          </LiveSinkProvider>
        </ProModeHostContext.Provider>
        {trayMode ? (
          <div
            ref={trayRef}
            id={trayId}
            data-pro-tray=""
            data-open={showTray ? "" : undefined}
            className={cn(
              "surface-card shadow-elevation-3 absolute inset-x-1 bottom-1 z-[45] max-h-[calc(100%-0.5rem)] flex-col gap-1 overflow-y-auto overscroll-contain rounded-ios p-1 sm:inset-x-2 sm:bottom-2",
              showTray ? "flex" : "hidden",
            )}
          >
            {trayPalette ? <div ref={setPaletteEl} className="empty:hidden" /> : null}
            {/* «Aplanar» (o el interruptor de Anotar) y la fila de privacidad comparten renglon: la bandeja resta menos hoja. */}
            <div className="hidden flex-wrap items-center justify-between gap-x-3 px-1 has-[>div:not(:empty)]:flex">
              <div ref={setActionsEl} className="empty:hidden" />
              <div ref={setPrivacyEl} className="empty:hidden" />
            </div>
          </div>
        ) : null}
      </div>
      {bottom ? bar : null}
      {inSlot && slot ? createPortal(bar, slot) : null}
    </div>
  );
}

/**
 * Hojas de confirmacion del host: salir con cambios sin aplicar (aplicar / descartar / seguir), descartar y
 * aplicar un PDF con firmas digitales. Se montan siempre en la suite (la hoja de «salir» puede abrirse tambien con
 * el modo ya desmontado por el cambio de pestana).
 */
export function ProModeSheets({ session }: { session: ProModeSession }) {
  const { t, language } = useI18n();
  const doc = useProWorkingDocInstance();
  const m = getModeStrings(language);
  const { def, sheets, actions } = session;
  const name = def ? modeBarName(language, def.tab) : "";
  const canApplyAndLeave = session.hasControls;
  const signatures = doc.getState().document?.signatures ?? "none";
  const signatureText = proWarningText(language, {
    code: signatures === "unknown" ? "signaturesUnknown" : "signaturesInvalidated",
  });
  return (
    <>
      <Sheet
        open={sheets.leave.open}
        onClose={actions.leaveStay}
        title={m.host.leaveTitle}
        closeLabel={t.common.close}
      >
        <p className="pb-4 text-subheadline text-muted-foreground">
          {m.host.leaveBody(def ? modeShortName(language, def.tab) : name)}
        </p>
        <div className="flex flex-col gap-2 pb-2">
          {canApplyAndLeave ? (
            <Button variant="primary" size="md" fullWidth data-pro-mode-leave-apply="" onClick={actions.leaveApply}>
              {m.host.leaveApply}
            </Button>
          ) : null}
          <Button variant="destructive" size="md" fullWidth data-pro-mode-leave-discard="" onClick={actions.leaveDiscard}>
            {m.host.leaveDiscard}
          </Button>
          <Button variant="secondary" size="md" fullWidth data-pro-mode-leave-stay="" onClick={actions.leaveStay}>
            {m.host.leaveStay}
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={sheets.discard.open}
        onClose={actions.discardCancel}
        title={m.host.discardTitle}
        closeLabel={t.common.close}
      >
        <p className="pb-4 text-subheadline text-muted-foreground">{m.host.discardBody}</p>
        <div className="flex flex-col gap-2 pb-2">
          <Button variant="destructive" size="md" fullWidth data-pro-mode-discard-confirm="" onClick={actions.discardConfirm}>
            {m.host.discardConfirm}
          </Button>
          <Button variant="secondary" size="md" fullWidth onClick={actions.discardCancel}>
            {m.host.leaveStay}
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={sheets.signatures.open}
        onClose={actions.signaturesCancel}
        title={m.host.signaturesTitle}
        closeLabel={t.common.close}
      >
        <p className="pb-4 text-subheadline text-muted-foreground">{signatureText}</p>
        <div className="flex flex-col gap-2 pb-2">
          <Button variant="destructive" size="md" fullWidth data-pro-mode-signatures-confirm="" onClick={actions.signaturesConfirm}>
            {m.host.signaturesConfirm}
          </Button>
          <Button variant="secondary" size="md" fullWidth onClick={actions.signaturesCancel}>
            {m.host.signaturesCancel}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/** Resultado de la ultima aplicacion: lo hecho y los avisos (fuente sustituida, original que permanece...). */
export function ProModeResult({ session }: { session: ProModeSession }) {
  const { language } = useI18n();
  const m = getModeStrings(language);
  const { result } = session;
  if (!result) return null;
  const hasNotices = result.notices.length > 0 || result.warnings.length > 0;
  return (
    <div
      role="group"
      aria-label={m.host.appliedTitle(result.label)}
      data-pro-mode-result=""
      className="flex shrink-0 items-start gap-3 border-b border-hairline bg-white/3 px-3 py-2 md:px-4"
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-footnote font-semibold text-foreground">
          <Check aria-hidden="true" className="size-4 shrink-0 text-success-text" />
          {m.host.appliedTitle(result.label)}
        </p>
        {hasNotices ? (
          <ul
            aria-label={m.host.appliedNoticesTitle}
            className="mt-1 list-disc space-y-0.5 pl-6 text-footnote text-muted-foreground"
          >
            {result.notices.map((text, index) => (
              <li key={`n${index}`}>{text}</li>
            ))}
            {result.warnings.map((warning) => (
              <li key={warning.code}>{proWarningText(language, warning)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={m.host.appliedDismiss}
        data-pro-mode-result-dismiss=""
        onClick={session.dismissResult}
        className="flex size-11 shrink-0 items-center justify-center rounded-full -my-2 -mr-2 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
