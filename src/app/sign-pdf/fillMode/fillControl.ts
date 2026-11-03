"use client";

import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { AutoMark } from "@/lib/fieldPropagation";

/*
 * Estado del modo «Rellenar» que tiene que SOBREVIVIR a que el lienzo se vuelva a montar: con varios documentos, pasar de un
 * campo al del documento siguiente cambia el documento activo y `MultiFlow` se monta de nuevo (`key={docId}`). Por eso no vive
 * dentro del flujo sino en quien lo monta (`SignToolClient`; `FillEmbedded`, que tiene un solo documento, lo lleva por su cuenta).
 * Los VALORES no estan aqui: estan en la sesion (lo que se escribe va al borrador y se deshace como siempre).
 */

export type FillCursor = { docId: string; fieldId: string };

export type FillState = {
  /** El asistente esta abierto. */
  open: boolean;
  /** Campo que tiene ahora; `null` = aun no se ha puesto (lo elige el asistente al abrir). */
  cursor: FillCursor | null;
  /** Se llego al final: se ve la pantalla «Todo rellenado». */
  finished: boolean;
  /** «Revisar los autorrellenados»: encendido, los campos rellenados solos pasan por el asistente para confirmarlos con un toque. */
  reviewAuto: boolean;
  /** Cuantos cambios hay en la pila de «Deshacer» (la pila va en un ref; esto es lo que la interfaz lee al pintar). */
  undoCount: number;
};

/** Un cambio hecho con el asistente, para «Deshacer»: el valor y la marca que tenia el campo ANTES de pasar por el. */
export type FillUndoEntry = {
  docId: string;
  fieldId: string;
  /** Valor anterior; `undefined` = el campo no tenia entrada. */
  value: string | undefined;
  mark: AutoMark | undefined;
  /** Nombre del campo, para anunciarlo. */
  name: string;
};

export type FillControl = {
  state: FillState;
  setState: (next: Partial<FillState> | ((previous: FillState) => FillState)) => void;
  undoStack: MutableRefObject<FillUndoEntry[]>;
};

export const REVIEW_AUTO_KEY = "optimuspdf.sign.fillReviewAuto";
/** Cuantos cambios se pueden deshacer con el asistente. */
export const MAX_FILL_UNDO = 30;

function readReviewAuto(): boolean {
  try {
    return window.localStorage.getItem(REVIEW_AUTO_KEY) !== "0";
  } catch {
    // Sin almacenamiento: el valor por defecto (revisarlos), nunca saltarse algo en silencio.
    return true;
  }
}

function writeReviewAuto(value: boolean): void {
  try {
    window.localStorage.setItem(REVIEW_AUTO_KEY, value ? "1" : "0");
  } catch {
    // Sin almacenamiento la preferencia no se recuerda; el asistente sigue funcionando.
  }
}

export const CLOSED_FILL: FillState = { open: false, cursor: null, finished: false, reviewAuto: true, undoCount: 0 };

/** El estado del asistente y su pila de «Deshacer». Lo monta quien monta el lienzo (`SignToolClient`, `FillEmbedded`). */
export function useFillControl(): FillControl {
  // `reviewAuto` se lee de las preferencias al ABRIR (no al montar: asi no hay desajuste de hidratacion).
  const [state, setStateRaw] = useState<FillState>(CLOSED_FILL);
  const undoStack = useRef<FillUndoEntry[]>([]);
  const setState = useCallback((next: Partial<FillState> | ((previous: FillState) => FillState)) => {
    setStateRaw((previous) => {
      const resolved = typeof next === "function" ? next(previous) : { ...previous, ...next };
      if (!previous.open && resolved.open) {
        // Al abrir: preferencia guardada y pila limpia (un «Deshacer» de otra sesion de rellenado no tiene sentido).
        undoStack.current = [];
        return { ...resolved, reviewAuto: readReviewAuto(), undoCount: 0 };
      }
      if (resolved.reviewAuto !== previous.reviewAuto) writeReviewAuto(resolved.reviewAuto);
      return resolved;
    });
  }, []);
  return useMemo(() => ({ state, setState, undoStack }), [state, setState]);
}
