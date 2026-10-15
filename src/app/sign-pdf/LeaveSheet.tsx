"use client";

import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import type { LeaveSheetState } from "@/app/sign-pdf/useLeaveGuard";
import type { ResumeStrings } from "@/app/sign-pdf/strings";

export type LeaveSheetProps = {
  state: LeaveSheetState;
  strings: ResumeStrings;
  /** Etiqueta accesible del boton de cerrar de la hoja. */
  closeLabel: string;
};

/**
 * Lo que dice la hoja, y SOLO lo que es verdad: «todo esta guardado» unicamente con el borrador al dia; si no cabe, si el
 * navegador no dejo guardarlo o si el modo no guarda borrador, lo dice tal cual (F0-fix, D2).
 */
function leaveBody(state: LeaveSheetState, strings: ResumeStrings): string {
  if (state.saved) return strings.leaveBodySaved;
  if (state.reason === "failed") return strings.leaveBodyFailed;
  if (state.reason === "solo") return strings.leaveBodySolo;
  return strings.leaveBodyUnsaved;
}

/**
 * «¿Salir de la firma?» (Fase 0 «Firma agil», U0.3): lo que se ve cuando el «Atras» del navegador, o un enlace de la
 * cabecera o del menu, interrumpe un trabajo con progreso. La opcion segura es quedarse: «Seguir firmando» es el boton
 * primario y recibe el foco al abrirse; Escape, tocar fuera o arrastrar la hoja hacia abajo tambien se quedan (`onStay`).
 *
 * Es un `Sheet` normal: dialogo modal con foco atrapado y devuelto a lo que lo tenia al abrirla. No lleva region viva
 * propia (lo anuncia el rol de dialogo con su nombre).
 */
export function LeaveSheet({ state, strings, closeLabel }: LeaveSheetProps) {
  return (
    <Sheet
      open={state.open}
      onClose={state.onStay}
      title={strings.leaveTitle}
      closeLabel={closeLabel}
      initialFocus="[data-leave-stay]"
    >
      <p className="pb-4 text-subheadline text-muted-foreground" data-leave-reason={state.reason ?? "saved"}>
        {leaveBody(state, strings)}
      </p>
      <div className="flex flex-col gap-2 pb-2">
        <Button size="md" fullWidth data-leave-stay="" onClick={state.onStay}>
          {strings.leaveStay}
        </Button>
        <Button variant="secondary" size="md" fullWidth onClick={state.onLeave}>
          {strings.leaveLeave}
        </Button>
      </div>
    </Sheet>
  );
}
