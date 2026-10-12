"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { createBatchedSink, LiveSinkProvider } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n } from "@/lib/i18n";
import { proWarningText } from "@/app/pdf-pro/proStrings";
import { useProMode, useProWorkingDoc, useProWorkingDocInstance } from "@/app/pdf-pro/useProWorkingDoc";
import { ProModeHostContext, type ProModeHostValue } from "@/app/pdf-pro/modes/modeContext";
import { useFocusReturn } from "@/app/pdf-pro/modes/modeFocus";
import { getModeStrings, modeBarName, modeShortName } from "@/app/pdf-pro/modes/modeStrings";
import type { ProModeSession } from "@/app/pdf-pro/modes/useProModeSession";

/**
 * Host de modos de PDF Pro (Wave 7 · U6): monta el modo de la pestana activa EN LUGAR DEL VISOR, con su barra
 * («Editando · Aplicar · Descartar»), y registra el modo en el documento de trabajo con deshacer propio para que
 * el Ctrl/Cmd+Z global NO actue mientras se edita. La logica vive en `useProModeSession`.
 */
/** Dos avisos del modo con menos de este tiempo de diferencia se leen juntos. */
const MERGE_WINDOW_MS = 1200;

export function ProModeHost({
  session,
  panelId,
  labelledBy,
}: {
  session: ProModeSession;
  panelId: string;
  /** Id de la pestaña que lo abre (escritorio); sin el (movil: no hay pestañas) la region lleva su propia etiqueta. */
  labelledBy?: string;
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
    />
  );
}

function ProModeHostInner({
  session,
  def,
  panelId,
  labelledBy,
  language,
}: {
  session: ProModeSession;
  def: NonNullable<ProModeSession["def"]>;
  panelId: string;
  labelledBy?: string;
  language: "es" | "en";
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
  // Al salir del modo, el foco nunca cae a <body> en el instante en que se retira la barra (sus botones).
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusReturn(rootRef);
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
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
    >
      <div
        role="group"
        aria-label={m.host.barLabel}
        data-pro-mode-bar=""
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-1.5 md:px-4"
      >
        <p className="flex min-w-0 flex-1 items-center gap-2 text-subheadline font-semibold text-foreground">
          <span data-pro-mode-name="">{modeName}</span>
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
        {hasControls ? (
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
              {m.host.discard}
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
        ) : null}
      </div>

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

      <div data-pro-mode-body="" className="min-h-0 min-w-0 flex-1 overflow-hidden p-2 md:p-3">
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
