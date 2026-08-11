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
};

/**
 * Paso de confirmacion para una accion destructiva, en forma de `Sheet`.
 * No existia ningun patron de "¿estas seguro?" en el repo antes de esto
 * (las acciones destructivas se ejecutaban directo al toque) -- este
 * componente es el primero, pensado para reutilizarse en cualquier boton
 * que borre algo sin vuelta atras.
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
}: ConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeLabel={closeLabel}>
      <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
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
        <Button variant="ghost" size="md" fullWidth onClick={onClose}>
          {cancelLabel}
        </Button>
      </div>
    </Sheet>
  );
}
