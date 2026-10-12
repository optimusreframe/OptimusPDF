"use client";

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/Button";
import { createPortal } from "react-dom";
import { AlertTriangle, Info } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useProModeControls, useProModeHost } from "@/app/pdf-pro/modes/modeContext";
import { useBeforeUnloadGuard } from "@/app/pdf-pro/modes/modeFocus";

/**
 * Piezas comunes de los modos de PDF Pro que trabajan SOBRE UN DOCUMENTO con una sesion propia y terminan en
 * «Aplicar» (Firmar y Rellenar, Wave 7 · U7): la identidad de la sesion, el estado de la fase y del trabajo
 * sin aplicar, el aviso de sesion descartada, el retorno del foco, el canal con el anfitrion de modos y la barra
 * de «Aplicar / Descartar».
 */

export type EmbeddedPhase = "editing" | "applying";

export type EmbeddedShellContext = {
  /** Identidad del documento de ESTA sesion (los bytes del snapshot, o el `File`). */
  identity: object;
  /** Identidad del documento VIGENTE ahora mismo (para detectar que cambio mientras se generaba el resultado). */
  getIdentity: () => object;
  phase: EmbeddedPhase;
  setPhase: (phase: EmbeddedPhase) => void;
  setDirty: (dirty: boolean) => void;
  /** Aviso de sesion descartada (o `null`). */
  notice: string | null;
  dismissNotice: () => void;
};

const EmbeddedShellReactContext = createContext<EmbeddedShellContext | null>(null);

/** El contexto de la sesion actual (identidad, fase, trabajo sin aplicar, aviso). Solo dentro de `EmbeddedSessionShell`. */
export function useEmbeddedShell(): EmbeddedShellContext {
  const context = useContext(EmbeddedShellReactContext);
  if (!context) throw new Error("useEmbeddedShell necesita <EmbeddedSessionShell>");
  return context;
}

/**
 * Sesion de un modo con aplicar. La identidad es la del documento con que se abrio (`bytes` si se da, si no el
 * `File`): si desde fuera llega otro (otro snapshot, otro archivo) la sesion se DESCARTA entera -- los hijos se
 * remontan con estado vacio -- y se avisa SOLO si habia trabajo sin aplicar y no se estaba aplicando (si se
 * estaba aplicando, el snapshot nuevo es el resultado esperado). Informa de `dirty` al anfitrion y lo baja a
 * `false` al desmontar.
 */
export function EmbeddedSessionShell({
  file,
  bytes,
  resetNotice,
  onDirtyChange,
  children,
}: {
  file: File;
  bytes?: Uint8Array;
  resetNotice: string;
  onDirtyChange?: (dirty: boolean) => void;
  children: ReactNode;
}) {
  const identity: object = bytes ?? file;
  const [tracked, setTracked] = useState<{ identity: object; id: number }>({ identity, id: 0 });
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<EmbeddedPhase>("editing");
  const [notice, setNotice] = useState<string | null>(null);

  if (tracked.identity !== identity) {
    setTracked({ identity, id: tracked.id + 1 });
    // Se estaba aplicando: el snapshot nuevo es el resultado esperado, no un cambio externo.
    setNotice(phase === "editing" && dirty ? resetNotice : null);
    setDirty(false);
    setPhase("editing");
  }

  const identityRef = useRef<object>(identity);
  useEffect(() => {
    identityRef.current = identity;
  });
  const getIdentity = useCallback(() => identityRef.current, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  // Recargar o cerrar la pestana con trabajo sin aplicar avisa (solo aviso: la sesion no se guarda).
  useBeforeUnloadGuard(dirty);

  const dirtyCallbackRef = useRef(onDirtyChange);
  useEffect(() => {
    dirtyCallbackRef.current = onDirtyChange;
  });
  useEffect(() => {
    dirtyCallbackRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => {
    return () => dirtyCallbackRef.current?.(false);
  }, []);

  const context = useMemo<EmbeddedShellContext>(
    () => ({ identity, getIdentity, phase, setPhase, setDirty, notice, dismissNotice }),
    [identity, getIdentity, phase, notice, dismissNotice],
  );

  return (
    <EmbeddedShellReactContext.Provider value={context}>
      <Fragment key={tracked.id}>{children}</Fragment>
    </EmbeddedShellReactContext.Provider>
  );
}

/**
 * Canal con el anfitrion de modos de PDF Pro (`ProModeHost`), si lo hay. Con anfitrion, el modo REGISTRA su
 * «aplicar» y es el anfitrion quien dibuja «Aplicar» y «Descartar» (y quien pide confirmacion con firmas
 * digitales, salir con cambios y el foco al volver): la barra propia no pinta botones (`hosted`). Sin anfitrion
 * (pruebas, uso aislado) el modo conserva sus botones. `apply` devuelve `true` si el documento se aplico.
 */
export function useModeHostBridge(
  apply: () => Promise<boolean>,
  cancel?: () => void,
): {
  hosted: boolean;
  /** El anfitrion esta aplicando: el modo no debe aceptar mas cambios. */
  hostBusy: boolean;
  /** Pagina (base 0) con la que arranca el modo, o 0. */
  initialPage: number;
  reportPage: (page: number) => void;
} {
  const host = useProModeHost();
  const applyRef = useRef(apply);
  const cancelRef = useRef(cancel);
  useEffect(() => {
    applyRef.current = apply;
    cancelRef.current = cancel;
  });
  useProModeControls(
    host ? { apply: () => applyRef.current(), discard: () => {}, cancel: () => cancelRef.current?.() } : null,
  );
  return {
    hosted: host !== null,
    hostBusy: host?.busy ?? false,
    initialPage: host?.initialPage ?? 0,
    reportPage: host?.reportPage ?? NO_REPORT,
  };
}

const NO_REPORT = (): void => {};

// El foco de los modos vive en `pdf-pro/modes/modeFocus.ts` (lo comparte el anfitrion); se reexporta aqui.
export { useBeforeUnloadGuard, useBusyFocus, useEntryFocus, useFocusReturn } from "@/app/pdf-pro/modes/modeFocus";

/**
 * Barra inferior comun: estado («listo» / «falta algo»), progreso, error y los botones de aplicar y descartar. Con
 * anfitrion los botones son los suyos y, en reposo (sin progreso, error ni avisos propios), la barra no ocupa sitio:
 * el estado queda solo para lectores de pantalla.
 */
export function EmbeddedBar({
  phase,
  progress,
  ready,
  readyText,
  notReadyText,
  error,
  statusId,
  applyLabel,
  discardLabel,
  applyingLabel,
  onApply,
  onCancel,
  hosted = false,
  children,
}: {
  phase: EmbeddedPhase;
  progress: number;
  ready: boolean;
  readyText: string;
  notReadyText: string;
  error: string | null;
  statusId: string;
  applyLabel: string;
  discardLabel: string;
  applyingLabel: string;
  onApply: () => void;
  onCancel: () => void;
  /** El anfitrion dibuja «Aplicar» y «Descartar». */
  hosted?: boolean;
  children?: ReactNode;
}) {
  const busy = phase !== "editing";
  const idle = hosted && !busy && !error && !children;
  if (idle) {
    return (
      <StatusRegion as="p" text={ready ? readyText : notReadyText} id={statusId} className="sr-only">
        {ready ? readyText : notReadyText}
      </StatusRegion>
    );
  }
  return (
    <div
      data-pro-mode-actions=""
      className="shrink-0 border-t border-hairline bg-background/90 px-3 py-2 backdrop-blur md:px-4"
    >
      <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56 outline-none" tabIndex={-1} data-pro-mode-status-wrap="">
          {phase === "applying" ? (
            <ProgressBar value={progress * 100} label={applyingLabel} />
          ) : (
            <StatusRegion
              as="p"
              text={ready ? readyText : notReadyText}
              id={statusId}
              className="text-footnote text-muted-foreground"
            >
              {ready ? readyText : notReadyText}
            </StatusRegion>
          )}
          {children}
          {error ? (
            <p role="alert" className="mt-1 text-footnote text-destructive-text">
              {error}
            </p>
          ) : null}
        </div>
        {hosted ? null : (
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onCancel} disabled={phase === "applying"}>
              {discardLabel}
            </Button>
            <Button
              size="md"
              disabled={!ready || busy}
              aria-describedby={ready ? undefined : statusId}
              onClick={onApply}
            >
              {applyLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hueco de la fila de controles del modo (Wave 7 · U7). `ProSignMode` lo da: asi el conmutador Firmar/Rellenar y
 * los controles de cada herramienta comparten UNA fila sin que el conmutador se remonte (y pierda el foco) al
 * cambiar de herramienta. Sin hueco (un modo suelto), la fila va en su sitio.
 */
export const ModeHeaderSlotContext = createContext<HTMLElement | null>(null);

/** Aviso corto del documento (firmas digitales, copia descifrada) con su texto completo. */
export type ModeWarning = { code: string; short: string; full: string };

/**
 * Cabecera compacta de un modo (Wave 7 · U7): UNA fila con los controles del modo (`leading`), el estado en una
 * linea (`status`) y las notas plegadas en un `<details>`, y debajo los avisos del documento EN UNA LINEA cada uno
 * (el texto completo va en `title` y para lectores de pantalla). El lienzo empieza visible sin desplazarse.
 */
export function ModeHeader({
  leading,
  status,
  notesLabel,
  notes,
  warningsLabel,
  warnings,
}: {
  leading?: ReactNode;
  status?: ReactNode;
  notesLabel: string;
  notes: readonly string[];
  warningsLabel: string;
  warnings: readonly ModeWarning[];
}) {
  const slot = useContext(ModeHeaderSlotContext);
  const items = (
    <>
      {leading}
      {status}
      <details className="min-w-0 text-footnote text-muted-foreground" data-pro-mode-notes="">
        <summary className="flex min-h-11 cursor-pointer select-none items-center gap-1.5 rounded-ios-sm px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
          <Info aria-hidden="true" className="size-4 shrink-0" />
          {notesLabel}
        </summary>
        <div className="space-y-1.5 pb-1 leading-relaxed">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      </details>
    </>
  );
  return (
    <div data-pro-mode-header="">
      {slot ? (
        createPortal(items, slot)
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{items}</div>
      )}
      {warnings.length > 0 ? (
        <ul
          aria-label={warningsLabel}
          data-pro-mode-warnings=""
          className="flex flex-wrap gap-x-4 gap-y-0.5 text-footnote text-foreground"
        >
          {warnings.map((warning) => (
            <li key={warning.code} title={warning.full} className="flex items-center gap-1.5" data-warning={warning.code}>
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-accent-edit" />
              <span className="sr-only">{warning.full}</span>
              <span aria-hidden="true">{warning.short}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
