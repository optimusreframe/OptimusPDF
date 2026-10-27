"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion, useIsPresent } from "motion/react";
import { useIsClient } from "@/hooks/useIsClient";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/lib/i18n";
import { crossFadeTransition, springs, withCrossFadeOpacity } from "@/lib/motion";

export type ProcessingOverlayProps = {
  /** Progreso 0..100. */
  progress: number;
  message: string;
  onCancel?: () => void;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  "select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Tarea modal: scrim que atenua la pagina y una tarjeta de material
 * grueso que "materializa" (escala 0.96 -> 1 + fundido, spring suave;
 * bajo reduced motion solo fundido). Se monta en un portal sobre `body`
 * y, mientras esta presente, el resto de hijos de `body` quedan `inert`
 * (no reciben foco ni clics): es la trampa de foco mas robusta porque no
 * depende de interceptar teclas; Tab ademas cicla dentro del dialogo por
 * si el navegador no implementa `inert`. El dialogo recibe el foco al
 * abrir; el foco DESPUES (cancelar, terminar) lo decide ToolShell segun
 * la fase, no este componente (lo que habia antes se desmonta al
 * procesar). Montado dentro de un AnimatePresence: la salida se anima y
 * `inert` se retira en cuanto empieza a salir, para que el foco pueda ir
 * ya a la pantalla siguiente.
 */
export function ProcessingOverlay({
  progress,
  message,
  onCancel,
}: ProcessingOverlayProps) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  /* Raiz del overlay: hijo directo de body (portal), lo unico no inert. */
  const rootRef = useRef<HTMLDivElement>(null);
  /* `useIsPresent` (no `usePresence`): solo lee la presencia, sin
     bloquear el desmontaje -- `usePresence` obliga a llamar a
     `safeToRemove` o el overlay no se quita nunca. */
  const isPresent = useIsPresent();
  const isClient = useIsClient();

  // Trampa de foco: inert en todo lo que no sea este overlay mientras este
  // presente (se retira al empezar la salida y, pase lo que pase, al
  // desmontar). Solo se toca lo que no estaba ya inert.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isPresent) return;
    const touched: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === root || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      touched.push(child);
    }
    return () => {
      for (const element of touched) element.removeAttribute("inert");
    };
  }, [isPresent]);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  const cycleFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || current === dialogRef.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isClient) return null;

  return createPortal(
    <div
      ref={rootRef}
      data-processing-overlay=""
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={crossFadeTransition}
        className="absolute inset-0 bg-[var(--color-scrim)]"
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={cycleFocus}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 4 }}
        transition={withCrossFadeOpacity(springs.gentle)}
        className="material-thick relative w-full max-w-sm rounded-ios-lg p-6 text-center shadow-elevation-3 outline-none"
      >
        <div className="flex justify-center">
          <Spinner className="size-7 text-foreground" />
        </div>
        <h2 id={titleId} className="mt-4 text-headline text-foreground">
          {t.tool.processingTitle}
        </h2>
        {/* `aria-live`: «Optimizando foto 12 de 40» se anuncia foto a foto (el dialogo modal no relee su descripcion). */}
        <p id={descriptionId} aria-live="polite" aria-atomic="true" className="mt-1 text-subheadline text-muted-foreground">
          {message}
        </p>

        <ProgressBar
          value={progress}
          label={t.tool.processingTitle}
          className="mt-6"
        />

        <p className="mt-4 text-footnote text-muted-foreground">
          {t.tool.processingHint}
        </p>

        {onCancel ? (
          <Button variant="ghost" size="md" className="mt-3" onClick={onCancel}>
            {t.common.cancel}
          </Button>
        ) : null}
      </motion.div>
    </div>,
    document.body,
  );
}
