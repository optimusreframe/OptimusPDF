"use client";

import { useEffect, useRef } from "react";
import { docStateOf, type DocId, type DocState } from "@/app/sign-pdf/docSet";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";

/*
 * Deteccion de campos de los documentos que aun no se han abierto (W4-U4).
 *
 * En la vista continua, «siguiente campo pendiente» pasa de un documento al
 * siguiente que tenga pendientes. Pero los campos de un documento se detectan
 * cuando su flujo se monta, es decir, al VISITARLO: sin esto, el salto no vería
 * los del documento vecino hasta haberlo abierto una vez.
 *
 * Se detectan en segundo plano, de uno en uno (concurrencia 1), empezando por
 * los mas cercanos al activo y tras un respiro (`BACKGROUND_DETECTION_DELAY_MS`)
 * para no competir con la deteccion del documento que se esta abriendo. El
 * resultado se entrega al estado del documento (`onDetected`) y, ademas, queda
 * guardado para el flujo del documento (`takeBackgroundDetection`): cuando se
 * abra no vuelve a detectar y sigue ofreciendo reutilizar valores.
 */

export const BACKGROUND_DETECTION_DELAY_MS = 600;

const started = new WeakMap<File, Promise<DetectedField[]>>();

/** Lanza (o recupera) la deteccion en segundo plano de un archivo. */
export function startBackgroundDetection(file: File): Promise<DetectedField[]> {
  let pending = started.get(file);
  if (!pending) {
    pending = detectFields(file);
    started.set(file, pending);
  }
  return pending;
}

/**
 * La deteccion que ya se hizo (o esta en marcha) en segundo plano para este
 * archivo, UNA vez: el flujo del documento la usa en vez de detectar otra vez.
 * `null` si no hubo ninguna (el flujo detecta como siempre).
 */
export function takeBackgroundDetection(file: File): Promise<DetectedField[]> | null {
  const pending = started.get(file);
  if (!pending) return null;
  started.delete(file);
  return pending;
}

/** Documento sin ningun dato de campos: ni detectado ni con campos puestos a mano. */
export function needsDetection(state: Pick<DocState, "textFields" | "textFieldsDetectedFor">): boolean {
  return state.textFieldsDetectedFor === null && state.textFields.length === 0;
}

export type BackgroundDetectionParams = {
  enabled: boolean;
  docs: readonly { id: DocId; file: File }[];
  activeId: DocId;
  docStates: Readonly<Record<DocId, DocState>>;
  /** Entrega los campos hallados en un documento (solo si nadie los toco mientras tanto: lo decide quien escribe). */
  onDetected: (docId: DocId, file: File, fields: DetectedField[]) => void;
};

export function useBackgroundDetection({
  enabled,
  docs,
  activeId,
  docStates,
  onDetected,
}: BackgroundDetectionParams): void {
  const onDetectedRef = useRef(onDetected);
  const queueRef = useRef<readonly { id: DocId; file: File }[]>([]);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  });

  const order = docs.map((doc) => doc.id);
  const activeIndex = order.indexOf(activeId);
  const queue = docs
    .filter(
      (doc) => doc.id !== activeId && needsDetection(docStateOf(docStates, doc.id)),
    )
    .sort(
      (a, b) =>
        Math.abs(order.indexOf(a.id) - activeIndex) -
        Math.abs(order.indexOf(b.id) - activeIndex),
    );
  const queueKey = queue.map((doc) => doc.id).join("|");
  useEffect(() => {
    queueRef.current = queue;
  });

  useEffect(() => {
    if (!enabled || queueKey === "") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const doc of queueRef.current) {
          if (cancelled) return;
          try {
            const fields = await startBackgroundDetection(doc.file);
            if (cancelled) return;
            onDetectedRef.current(doc.id, doc.file, fields);
          } catch {
            // Un fallo no bloquea: el flujo del documento lo reintenta (y avisa) al abrirlo.
          }
        }
      })();
    }, BACKGROUND_DETECTION_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, queueKey]);
}
