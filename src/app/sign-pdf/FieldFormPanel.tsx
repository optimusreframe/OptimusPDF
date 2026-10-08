"use client";

import { cn } from "@/lib/cn";
import { isFieldFilled, type DetectedField } from "@/lib/pdf/detectFields";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type FieldFormPanelProps = {
  /** Todos los campos de texto detectados o anadidos a mano, cualquier pagina. */
  fields: DetectedField[];
  /** Valor actual de cada campo, indexado por `id`. */
  values: Record<string, string>;
  /**
   * Saltar a un campo: cambia de pagina y abre su editor en linea sobre
   * el lienzo directamente, en un solo toque -- ya no hay un input
   * propio aqui, el lienzo es la unica forma de escribir.
   */
  onJumpToField: (field: DetectedField) => void;
  strings: SignStrings;
};

/**
 * Resumen de avance del paso de texto, ya no una lista de inputs
 * duplicada: rellenar ocurre exclusivamente tocando el campo sobre el
 * lienzo (`TextFieldPlacer`). Esto es solo un indice para ver de un
 * vistazo cuanto falta y saltar directo a un campo sin buscarlo
 * visualmente en el documento.
 */
export function FieldFormPanel({
  fields,
  values,
  onJumpToField,
  strings,
}: FieldFormPanelProps) {
  if (fields.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        {strings.noTextFields}
      </p>
    );
  }

  const filled = fields.filter((field) =>
    isFieldFilled(field, values[field.id]),
  ).length;

  const byPage = new Map<number, DetectedField[]>();
  for (const field of fields) {
    const list = byPage.get(field.pageIndex);
    if (list) list.push(field);
    else byPage.set(field.pageIndex, [field]);
  }
  const pageIndexes = [...byPage.keys()].sort((a, b) => a - b);

  return (
    <div className="space-y-4">
      <p className="text-footnote text-muted-foreground tabular-nums">
        {strings.fieldsFilledSummary(filled, fields.length)}
      </p>

      {pageIndexes.map((pageIndex) => (
        <div key={pageIndex}>
          <h4 className="ui-label mb-2 text-muted-foreground">
            {strings.pageGroupLabel(pageIndex + 1)}
          </h4>
          <ul className="space-y-1.5">
            {(byPage.get(pageIndex) ?? []).map((field) => {
              const label =
                field.label ??
                strings.textFieldFallbackLabel(fields.indexOf(field) + 1);
              const hasValue = isFieldFilled(field, values[field.id]);
              const lowConfidence = field.confidence === "low";

              return (
                <li key={field.id}>
                  <button
                    type="button"
                    onClick={() => onJumpToField(field)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2.5 rounded-ios-sm border px-3 text-left text-sm transition-colors",
                      "border-white/14 bg-white/5 hover:border-signal/40 hover:bg-white/8",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "inline-block size-2 shrink-0 rounded-full",
                        lowConfidence
                          ? "border border-dashed border-amber-400"
                          : hasValue
                            ? "bg-signal"
                            : "border border-white/25",
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        hasValue ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {hasValue ? values[field.id] : label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
