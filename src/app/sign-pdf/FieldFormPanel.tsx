"use client";

import { cn } from "@/lib/cn";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type FieldFormPanelProps = {
  /** Todos los campos de texto detectados o anadidos a mano, cualquier pagina. */
  fields: DetectedField[];
  /** Valor actual de cada campo, indexado por `id`. */
  values: Record<string, string>;
  onValueChange: (id: string, value: string) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  /** Al enfocar un campo de la lista, se salta a su pagina en el lienzo. */
  onGoToField?: (field: DetectedField) => void;
  strings: SignStrings;
};

/**
 * Lista desplazable de todos los campos de texto, agrupados por pagina.
 * Escribir aqui es equivalente a tocar el campo sobre la vista previa
 * (`TextFieldPlacer`): ambos escriben en el mismo mapa `values`. Un
 * campo de confianza baja (deteccion raster experimental) se marca con
 * un punto discontinuo en vez del punto solido del resto, igual que su
 * contorno sobre la pagina.
 */
export function FieldFormPanel({
  fields,
  values,
  onValueChange,
  selectedId,
  onSelectedIdChange,
  onGoToField,
  strings,
}: FieldFormPanelProps) {
  if (fields.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        {strings.noTextFields}
      </p>
    );
  }

  const byPage = new Map<number, DetectedField[]>();
  for (const field of fields) {
    const list = byPage.get(field.pageIndex);
    if (list) list.push(field);
    else byPage.set(field.pageIndex, [field]);
  }
  const pageIndexes = [...byPage.keys()].sort((a, b) => a - b);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="hud-label text-[11px] text-muted-foreground">
          {strings.formPanelTitle}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {strings.formPanelHint}
        </p>
      </div>

      {pageIndexes.map((pageIndex) => (
        <div key={pageIndex}>
          <h4 className="hud-label mb-2 text-[10px] text-muted-foreground">
            {strings.pageGroupLabel(pageIndex + 1)}
          </h4>
          <ul className="space-y-3">
            {(byPage.get(pageIndex) ?? []).map((field) => {
              const label =
                field.label ??
                strings.textFieldFallbackLabel(fields.indexOf(field) + 1);
              const active = field.id === selectedId;
              const lowConfidence = field.confidence === "low";

              return (
                <li key={field.id}>
                  <label
                    htmlFor={`text-field-${field.id}`}
                    className="hud-label mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "inline-block size-2 shrink-0 rounded-full",
                        lowConfidence
                          ? "border border-dashed border-amber-400"
                          : "bg-signal",
                      )}
                    />
                    <span className="truncate">{label}</span>
                  </label>
                  <input
                    id={`text-field-${field.id}`}
                    type="text"
                    value={values[field.id] ?? ""}
                    placeholder={strings.textFieldPlaceholder}
                    onFocus={() => {
                      onSelectedIdChange(field.id);
                      onGoToField?.(field);
                    }}
                    onChange={(event) => onValueChange(field.id, event.target.value)}
                    className={cn(
                      "h-11 w-full rounded-ios-sm border bg-white/5 px-3 text-sm text-foreground outline-none transition-colors",
                      "placeholder:text-muted-foreground/60 focus:border-signal/60",
                      active ? "border-signal/60" : "border-white/14",
                    )}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
