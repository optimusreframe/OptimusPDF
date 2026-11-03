"use client";

import { ClipboardPenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useFillStrings } from "@/app/sign-pdf/fillMode/fillStrings";

/**
 * Entrada al asistente «Rellenar» (W3-B2): el boton destacado «Rellenar (N campos)» del paso «Documento». Se pinta solo si hay algo
 * que rellenar y mientras el asistente esta cerrado; trae una linea que dice cuantos campos ya tienen datos (p. ej. tras aplicar una
 * plantilla o el autorrelleno), para que se vea que lo hecho no se pierde.
 */
export type FillEntryProps = {
  /** Cuantos campos recorre el asistente en total. */
  count: number;
  /** Cuantos de ellos ya tienen algo escrito. */
  filled: number;
  onStart: () => void;
  disabled?: boolean;
};

/** Selector del boton, para devolverle el foco al cerrar el asistente. */
export const FILL_ENTRY_SELECTOR = "[data-fill-entry]";

export function FillEntry({ count, filled, onStart, disabled = false }: FillEntryProps) {
  const strings = useFillStrings();
  if (count <= 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between" data-fill-entry-card="">
      <div className="min-w-0">
        <p className="text-subheadline font-semibold text-foreground">{strings.entryTitle}</p>
        <p className="mt-0.5 text-footnote leading-relaxed text-muted-foreground">{strings.entryBody(filled, count)}</p>
      </div>
      <Button size="md" wrap disabled={disabled} onClick={onStart} data-fill-entry="" className="sm:shrink-0">
        <ClipboardPenLine aria-hidden="true" className="size-4 shrink-0" />
        {strings.entryButton(count)}
      </Button>
    </div>
  );
}
