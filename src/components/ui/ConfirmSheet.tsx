"use client";

import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";

export type ConfirmSheetProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel: string;
  /** Ver `Sheet.restoreFocusOnClose`: `false` = la accion ya movio el foco a otro sitio y la hoja no se lo quita. */
  restoreFocusOnClose?: () => boolean;
  /** Ver `Sheet.inertBackground`. */
  inertBackground?: boolean;
};

/**
 * Paso de confirmacion para una accion destructiva, en forma de `Sheet`.
 * Jerarquia Apple: la accion destructiva es la prominente (tintada en
 * rojo) y cancelar es un boton secundario de material, ambos de 44 px.
 * Hereda del Sheet el arrastre, el foco atrapado y la salida animada.
 */
export function ConfirmSheet({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel,
  closeLabel,
  restoreFocusOnClose,
  inertBackground,
}: ConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeLabel={closeLabel} restoreFocusOnClose={restoreFocusOnClose} inertBackground={inertBackground}>
      <p className="pb-4 text-subheadline text-muted-foreground">{body}</p>
      <div className="flex flex-col gap-2 pb-2">
        <Button
          variant="destructive"
          size="md"
          fullWidth
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="secondary" size="md" fullWidth onClick={onClose}>
          {cancelLabel}
        </Button>
      </div>
    </Sheet>
  );
}
