"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ScanText } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useOptionalLanguage } from "@/lib/i18n";
import type { DetectedField } from "@/lib/pdf/detectFields";
import { focusFallbackWhenIdle } from "@/app/settings/focusFallback";
import { AutofillBody } from "@/app/sign-pdf/autofill/AutofillBody";
import { applyPatch, fillableFields, undoPatch, type FillPatch } from "@/app/sign-pdf/autofill/model";
import { AUTOFILL_STRINGS } from "@/app/sign-pdf/autofill/strings";
import type { FlowDone } from "@/app/sign-pdf/autofill/useAutofillFlow";

/**
 * Boton «Rellenar con datos del cliente» del paso Documento de Firmar PDF (y de PDF Pro): visible SOLO si el documento tiene
 * campos de texto o de fecha que rellenar. Abre la hoja de `AutofillBody`.
 *
 * Rellenar escribe en `textValues` por la misma via que la edicion de texto (el llamador pasa `onTextValuesChange`, que acaba en
 * `setOptions({ textValues })`), asi que los valores van al borrador y, al descargar, al historial de valores igual que los
 * escritos a mano. Deshacer de UN paso: tras rellenar queda «Se rellenaron N campos. [Deshacer]» (region viva, el foco vuelve a
 * este boton); deshacer devuelve cada campo a lo que tenia, salvo los que la persona cambio despues.
 */

export type AutofillLauncherProps = {
  textFields: readonly DetectedField[];
  textValues: Readonly<Record<string, string>>;
  /** Sustituye el mapa de valores de los campos de texto (id -> texto). */
  onTextValuesChange: (next: Record<string, string>) => void;
  /** Origen de dato fijado por la plantilla para cada campo (gana sobre la etiqueta). */
  fieldDataKeys?: Readonly<Record<string, string>>;
};

export function AutofillLauncher({ textFields, textValues, onTextValuesChange, fieldDataKeys }: AutofillLauncherProps) {
  // Sin proveedor de idioma (piezas probadas sueltas) cae a espanol, como las demas piezas compartidas de Firmar.
  const language = useOptionalLanguage();
  const strings = AUTOFILL_STRINGS[language];
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<FillPatch | null>(null);
  const [status, setStatus] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Lo ultimo confirmado en pantalla: el relleno y el deshacer escriben sobre ESTO, no sobre un cierre viejo.
  const valuesRef = useRef(textValues);
  const fieldsRef = useRef(textFields);
  useLayoutEffect(() => {
    valuesRef.current = textValues;
    fieldsRef.current = textFields;
  });

  const apply = useCallback(
    (patch: FillPatch) => {
      onTextValuesChange(applyPatch(valuesRef.current, patch));
    },
    [onTextValuesChange],
  );

  /** Cierra la hoja. `Sheet` devuelve el foco al boton; si no pudo (Safari, boton re-pintado), el respaldo lo lleva alli al terminar la salida. */
  const close = useCallback(() => {
    setOpen(false);
    focusFallbackWhenIdle(() => buttonRef.current);
  }, []);

  const done = useCallback(
    (result: FlowDone) => {
      close();
      setLast(result.count > 0 ? result.patch : null);
      setStatus([result.count > 0 ? strings.filled(result.count, result.from) : "", result.profileNote ?? ""].filter(Boolean).join(" "));
    },
    [close, strings],
  );

  const undo = () => {
    if (!last) return;
    onTextValuesChange(undoPatch(valuesRef.current, last, new Set(fieldsRef.current.map((field) => field.id))));
    setLast(null);
    setStatus(strings.undone);
  };

  if (fillableFields(textFields).length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-autofill-launcher="">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button
          ref={buttonRef}
          variant="secondary"
          size="md"
          wrap
          onClick={(event) => {
            // Safari no da el foco a un boton al tocarlo: se lo damos para que la hoja sepa a donde devolverlo al cerrar.
            event.currentTarget.focus({ preventScroll: true });
            setOpen(true);
          }}
          data-autofill-open=""
        >
          <ScanText aria-hidden="true" className="size-4 shrink-0" />
          {strings.button}
        </Button>
        <p className="min-w-0 text-footnote leading-relaxed text-muted-foreground sm:flex-1">{strings.buttonHint}</p>
      </div>

      <StatusRegion text={status} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-foreground empty:hidden" data-autofill-status="">
        {status ? <span className="[overflow-wrap:anywhere]">{status}</span> : null}
        {last ? (
          <Button variant="ghost" size="sm" onClick={undo} data-autofill-undo="">
            {strings.undo}
          </Button>
        ) : null}
      </StatusRegion>

      <Sheet open={open} onClose={close} title={strings.title} closeLabel={strings.close} initialFocus="[data-autofill-initial]" inertBackground>
        <AutofillBody locale={language} fields={textFields} values={textValues} dataKeys={fieldDataKeys} onApply={apply} onDone={done} />
      </Sheet>
    </div>
  );
}
