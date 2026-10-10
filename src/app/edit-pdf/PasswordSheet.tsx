"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";

/*
 * Hoja de contrasena del editor (Wave 5 · U5). Un PDF cifrado cuya contrasena
 * de usuario no es la vacia no se puede abrir sin ella: se pide aqui, con un
 * campo de contrasena (nunca visible por defecto, con boton para mostrarla), un
 * mensaje claro si no es la correcta (el foco vuelve al campo con el texto
 * seleccionado para reescribirla) y una cancelacion que saca el archivo.
 *
 * Cerrar la hoja con Esc o fuera NO cancela (no pierde nada): deja la tarjeta
 * del documento con el boton para volver a abrirla; «Cancelar» es la salida.
 */

export type PasswordSheetProps = {
  open: boolean;
  /** Cierra la hoja sin quitar el archivo (Esc, fuera, Cerrar). */
  onClose: () => void;
  onSubmit: (password: string) => void;
  /** «Cancelar»: la persona renuncia a este documento. */
  onCancel: () => void;
  busy: boolean;
  /** La ultima contrasena no abrio el documento. */
  wrong: boolean;
  /** Otro fallo al abrir con esa contrasena. */
  failed: boolean;
  /** Aumenta con cada intento fallido: devuelve el foco al campo. */
  attempt: number;
  flow: EditFlowStrings;
};

const INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 pr-12 pl-3 text-callout text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

export function PasswordSheet({
  open,
  onClose,
  onSubmit,
  onCancel,
  busy,
  wrong,
  failed,
  attempt,
  flow,
}: PasswordSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={flow.passwordTitle} closeLabel={flow.confirmClose}>
      <PasswordForm
        onSubmit={onSubmit}
        onCancel={onCancel}
        busy={busy}
        wrong={wrong}
        failed={failed}
        attempt={attempt}
        flow={flow}
      />
    </Sheet>
  );
}

function PasswordForm({
  onSubmit,
  onCancel,
  busy,
  wrong,
  failed,
  attempt,
  flow,
}: Omit<PasswordSheetProps, "open" | "onClose">) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const message = wrong ? flow.passwordWrong : failed ? flow.passwordFailed : "";

  // La hoja enfoca su panel al abrir DESPUES de los efectos de los hijos: el
  // campo se enfoca en el cuadro siguiente. Tras un intento fallido vuelve al
  // campo con el texto seleccionado, para reescribir sin borrar a mano.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled) return;
      input.focus({ preventScroll: true });
      if (attempt > 0) input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attempt]);

  return (
    <form
      data-password-form=""
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || password.length === 0) return;
        onSubmit(password);
      }}
      className="space-y-4 pb-2"
    >
      <p className="text-subheadline text-muted-foreground">{flow.passwordBody}</p>

      <div>
        <label htmlFor={`${baseId}-input`} className="ui-label mb-1.5 block text-muted-foreground">
          {flow.passwordLabel}
        </label>
        <div className="relative">
          <input
            ref={inputRef}
            id={`${baseId}-input`}
            name="pdf-password"
            type={visible ? "text" : "password"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={password}
            disabled={busy}
            aria-invalid={message ? true : undefined}
            aria-describedby={`${baseId}-message`}
            onChange={(event) => setPassword(event.target.value)}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            aria-label={visible ? flow.passwordHide : flow.passwordShow}
            aria-pressed={visible}
            disabled={busy}
            onClick={() => setVisible((value) => !value)}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-ios-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal"
          >
            {visible ? (
              <EyeOff aria-hidden="true" className="size-4" />
            ) : (
              <Eye aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
        {/* Region de estado siempre montada: solo cambia su texto. */}
        <p
          id={`${baseId}-message`}
          role="status"
          aria-live="polite"
          data-password-message=""
          className={cn(
            "mt-1.5 flex items-center gap-2 text-footnote",
            message ? "text-destructive-text" : busy ? "text-muted-foreground" : "sr-only",
          )}
        >
          {busy ? <Spinner className="size-4" /> : null}
          {busy ? flow.passwordOpening : message}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button type="submit" size="md" fullWidth disabled={busy || password.length === 0}>
          {flow.passwordSubmit}
        </Button>
        <Button type="button" variant="secondary" size="md" fullWidth onClick={onCancel}>
          {flow.passwordCancel}
        </Button>
      </div>
    </form>
  );
}
