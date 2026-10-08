"use client";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { SignStrings } from "@/app/sign-pdf/strings";

/*
 * Piezas del paso "Documento" que comparten "Varios firmantes" y "Solo yo":
 * el estado de la deteccion de campos, la oferta de reutilizar valores de
 * otro documento y el aviso de campos sin rellenar.
 */

/**
 * Region de estado SIEMPRE montada (un `role="status"` que aparece junto con
 * su texto no se anuncia de forma fiable): solo cambia su contenido. Vacia,
 * `empty:-mb-4` anula el hueco del `gap` del contenedor.
 */
export function DetectionStatus({
  detecting,
  failed,
  detectedCount,
  strings,
}: {
  detecting: boolean;
  failed: boolean;
  detectedCount: number;
  strings: SignStrings;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-3 empty:-mb-4"
    >
      {detecting ? (
        <div className="surface-card rounded-ios flex items-center gap-3 p-4">
          <Spinner />
          <p className="text-footnote text-muted-foreground">
            {strings.detectingFields}
          </p>
        </div>
      ) : null}

      {!detecting && failed ? (
        <p className="text-footnote leading-relaxed text-muted-foreground">
          {strings.detectionFailedHint}
        </p>
      ) : null}

      {!detecting && !failed && detectedCount > 0 ? (
        <p className="text-footnote leading-relaxed text-muted-foreground">
          {strings.detectedFieldsSummary(detectedCount)}
        </p>
      ) : null}
    </div>
  );
}

export function ReuseValuesPrompt({
  matches,
  textFields,
  onAccept,
  onDecline,
  strings,
}: {
  matches: Record<string, string>;
  textFields: readonly DetectedField[];
  onAccept: () => void;
  onDecline: () => void;
  strings: SignStrings;
}) {
  return (
    <div className="surface-card rounded-ios flex flex-col gap-3 p-4">
      <p className="text-callout text-foreground">{strings.reuseValuesPrompt}</p>
      {/*
       * El valor se muestra explicitamente antes de aceptar: el
       * historial ahora vive en localStorage (no se olvida al
       * cerrar la pestaña), asi que aceptar "a ciegas" arriesga
       * traer el dato de OTRO cliente si dos documentos usan la
       * misma etiqueta de campo (ej. "Nombre completo").
       */}
      <ul className="space-y-1">
        {Object.entries(matches).map(([fieldId, value]) => {
          const field = textFields.find((candidate) => candidate.id === fieldId);
          return (
            <li
              key={fieldId}
              className="flex items-baseline gap-2 text-xs text-muted-foreground"
            >
              <span className="shrink-0">{field?.label ?? fieldId}:</span>
              <span className="truncate text-foreground">{value}</span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onAccept}>
          {strings.reuseValuesAccept}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDecline}>
          {strings.reuseValuesDecline}
        </Button>
      </div>
    </div>
  );
}

/** Aviso NO bloqueante de campos sin rellenar: region siempre montada. */
export function PendingFieldsNotice({
  missing,
  strings,
}: {
  /** Cuantos faltan; 0 = sin aviso (la region sigue montada, vacia). */
  missing: number;
  strings: SignStrings;
}) {
  return (
    <div role="status" aria-live="polite" className="empty:-mt-4">
      {missing > 0 ? (
        <p className="flex items-start gap-2 text-footnote leading-relaxed text-foreground">
          <span
            aria-hidden="true"
            className="mt-[0.45em] size-2 shrink-0 rounded-full bg-amber-400"
          />
          {strings.pendingTextFieldsWarning(missing)}
        </p>
      ) : null}
    </div>
  );
}
