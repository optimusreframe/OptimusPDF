"use client";

import { useState } from "react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { stripSignaturesFromDrafts } from "@/app/sign-pdf/signDrafts";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type StripSavedSignaturesProps = {
  strings: SignStrings;
  className?: string;
};

/**
 * «Quitar ahora las firmas de los borradores guardados» (F0-fix2, N2): boton secundario, con confirmacion, que Ajustes y el
 * aviso de privacidad de Firmar ponen junto al interruptor «Guardar tambien las firmas recogidas». Apagar el interruptor no
 * toca lo ya guardado (hasta 7 dias); esto lo quita ya, de todos los borradores, y lo dice cuando termina (o que no pudo).
 * Ver `stripSignaturesFromDrafts` para lo que conserva.
 */
export function StripSavedSignatures({ strings, className }: StripSavedSignaturesProps) {
  const privacy = strings.draftPrivacy;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean }>({ text: "", failed: false });

  return (
    <div className={className}>
      {/*
        Boton secundario hecho a mano (mismo material y foco que `Button`): el `Button` del sistema no parte el texto en lineas
        (`whitespace-nowrap`, alto fijo) y esta frase, larga, no cabe en una linea a 375 px. Crece, nunca baja de 44 px.
      */}
      <button
        type="button"
        data-strip-signatures=""
        className="material-thin inline-flex min-h-11 select-none items-center justify-center rounded-ios-sm px-5 py-2 text-center text-callout font-semibold text-foreground transition-[scale,background-color] duration-[var(--duration-fast)] ease-[var(--ease-spring)] hover:bg-white/10 active:scale-[0.97] active:bg-white/14 active:duration-[80ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal forced-colors:border forced-colors:border-[ButtonText]"
        onClick={() => {
          setStatus({ text: "", failed: false });
          setConfirmOpen(true);
        }}
      >
        {privacy.clearStrokesButton}
      </button>
      {/* Region de estado siempre montada: solo cambia su contenido. */}
      <StatusRegion
        as="p"
        text={status.text}
        className={status.failed ? "mt-1 text-footnote text-destructive-text" : "mt-1 text-footnote text-muted-foreground"}
        data-strip-signatures-status=""
      >
        {status.text}
      </StatusRegion>
      <ConfirmSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          void stripSignaturesFromDrafts().then((result) => {
            if (!result.ok) setStatus({ text: privacy.clearStrokesFailed, failed: true });
            else {
              setStatus({
                text: result.sessions + result.documents > 0 ? privacy.clearStrokesDone : privacy.clearStrokesNone,
                failed: false,
              });
            }
          });
        }}
        title={privacy.clearStrokesTitle}
        body={privacy.clearStrokesBody}
        confirmLabel={privacy.clearStrokesConfirm}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </div>
  );
}
