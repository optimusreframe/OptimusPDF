"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Hand, PanelBottomClose, PanelBottomOpen, X } from "lucide-react";
import { createBatchedSink, LiveSinkProvider } from "@/components/tool/liveRouting";
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
import { useCoarsePointer } from "@/app/pdf-pro/shell/useIsDesktop";

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
};

const DESKTOP_LAYOUT: ProModeHostLayout = {
  mobile: false,
  collapsed: false,
  onToggleCollapsed: () => {},
  slot: null,
  dockBelow: false,
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
  // «Desplazar» solo tiene sentido con un dedo y en los modos que dibujan sobre la hoja (Editar y Anotar).
  const [pan, setPan] = useState(false);
  const panAvailable = coarse && (def.tab === "edit" || def.tab === "annotate");
  // Al salir del modo, el foco nunca cae a <body> en el instante en que se retira la barra (sus botones).
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useFocusReturn(rootRef, barRef);
  /*
   * Todo lo que el modo dice (entrar, campos detectados, avisos...) sale por la UNICA region viva de PDF Pro. Un aviso que
   * llega en el segundo siguiente a otro se SUMA a el en vez de pisarlo («Anotar: modo abierto... Buscando campos...»).
   */
  const speak = useCallback((text: string) => doc.announce(text, { mergeWithinMs: MERGE_WINDOW_MS }), [doc]);
  useEffect(() => {
    speak(m.host.entered(modeShortName(language, def.tab)));
  }, [speak, m, language, def.tab]);

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
  const { mobile, collapsed, onToggleCollapsed, slot, dockBelow } = layout;
  // En un movil horizontal la barra va dentro de la cabecera (si su hueco ya existe); si no, abajo.
  const inSlot = mobile && slot !== null;
  const bottom = mobile && !inSlot;

  const controls = (
    <>
      {mobile ? (
        <button
          type="button"
          data-pro-fold-toggle=""
          aria-expanded={!collapsed}
          aria-label={collapsed ? m.host.showTools : m.host.hideTools}
          title={collapsed ? m.host.showTools : m.host.hideTools}
          onClick={onToggleCollapsed}
          className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]"
        >
          <span className="flex size-8 items-center justify-center rounded-full text-foreground transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-active:scale-90 group-active:duration-[80ms] forced-colors:border forced-colors:border-[ButtonText]">
            {collapsed ? (
              <PanelBottomOpen aria-hidden="true" className="size-[18px]" />
            ) : (
              <PanelBottomClose aria-hidden="true" className="size-[18px]" />
            )}
          </span>
        </button>
      ) : null}
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
          <span className={inSlot ? "sr-only" : "max-[389px]:sr-only"}>{m.host.panLabel}</span>
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
    <div className="flex shrink-0 items-center gap-2">
      {busy && session.hasControls ? (
        <Button variant="ghost" size="md" data-pro-mode-cancel="" onClick={session.cancelApply}>
          {m.host.cancelApply}
        </Button>
      ) : null}
      <Button
        variant="secondary"
        size="md"
        data-pro-mode-discard=""
        aria-disabled={busy || undefined}
        className="aria-disabled:opacity-50"
        onClick={() => {
          if (!busy) session.requestDiscard();
        }}
      >
        <X aria-hidden="true" className="size-4" />
        {/* En movil estrecho solo el icono (el nombre accesible sigue siendo «Descartar»): «Aplicar» conserva su texto. */}
        <span className={inSlot ? "sr-only" : mobile ? "max-[420px]:sr-only" : undefined}>{m.host.discard}</span>
      </Button>
      <Button
        variant="primary"
        size="md"
        data-pro-mode-apply=""
        aria-disabled={!canApply || undefined}
        // Con `aria-disabled` el boton se ve igual que uno activo: se le da el aspecto apagado.
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:shadow-none"
        onClick={() => {
          if (canApply) session.requestApply();
          else if (!busy) doc.announce(m.host.noChanges);
        }}
      >
        <Check aria-hidden="true" className="size-4" />
        {busy ? m.host.applying : m.host.apply}
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
        "flex items-center gap-x-2 gap-y-1",
        inSlot
          ? "min-w-0 shrink"
          : bottom
            ? cn(
                "shrink-0 border-t border-hairline bg-background pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))] py-1",
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
          inSlot && "max-lg:sr-only",
        )}
      >
        <span data-pro-mode-name="" className={mobile ? "truncate max-[359px]:sr-only" : undefined}>
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
        className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", mobile ? "p-1 sm:p-2" : "p-2 md:p-3")}
      >
        <ProModeHostContext.Provider value={value}>
          <LiveSinkProvider value={sink}>
            <Component
              key={`${document.id}:${snapshot.id}`}
              file={file}
              bytes={snapshot.bytes}
              lang={language}
              onApply={session.onApply}
              onCancel={onCancel}
              onDirtyChange={session.onDirtyChange}
            />
          </LiveSinkProvider>
        </ProModeHostContext.Provider>
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
