"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SignatureField } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";

/*
 * Deshacer / rehacer del modo «Editar campos» (W3-B1). Hasta ahora «Deshacer» solo existia como el aviso de 6 s tras borrar
 * (`pendingUndo` del lienzo) o en el autorrelleno; aqui hay una pila de verdad sobre lo que se edita en el lienzo: los
 * huecos de firma, los campos de texto y sus valores de ESTE documento.
 *
 * La pila guarda INSTANTANEAS completas (son listas pequenas) y se alimenta sola: cada cambio de las propiedades se compara
 * con la instantanea vigente y, pasado `COALESCE_MS` sin nuevos cambios, se apila UNA entrada. Asi arrastrar un campo o
 * escribir una frase son un solo paso, no uno por pixel o por letra. Deshacer/rehacer aplican la instantanea por los mismos
 * cauces del lienzo (`apply`), de modo que el borrador, el autorrelleno y la memoria se enteran como de cualquier edicion.
 *
 * Empieza vacia al abrir el modo (la linea base es lo que habia): no se puede «deshacer» mas atras de la entrada.
 */

export type EditSnapshot = {
  slots: SignatureField[];
  textFields: DetectedField[];
  values: Record<string, string>;
};

/** Tras tanto tiempo sin cambios se cierra el paso. */
export const COALESCE_MS = 450;
/** Pasos que se recuerdan. */
export const HISTORY_LIMIT = 100;

type Entry = { snap: EditSnapshot; sig: string };

/**
 * Firma de una instantanea. Un valor vacio y un valor ausente son lo mismo (deshacer deja `""` donde antes no habia clave): sin
 * normalizarlo, aplicar una instantanea cambiaria su propia firma y se apilaria como un paso nuevo, borrando el «Rehacer».
 */
const signatureOf = (snap: EditSnapshot): string =>
  JSON.stringify([
    snap.slots,
    snap.textFields,
    Object.entries(snap.values)
      .filter(([, value]) => value !== "")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);

export type EditHistory = {
  canUndo: boolean;
  canRedo: boolean;
  /** Devuelve `false` si no habia nada que deshacer. */
  undo: () => boolean;
  redo: () => boolean;
};

export function useEditHistory({
  enabled,
  slots,
  textFields,
  values,
  apply,
}: {
  enabled: boolean;
  slots: SignatureField[];
  textFields: DetectedField[];
  values: Record<string, string>;
  /** Pone la instantanea en la sesion (por los mismos cauces que cualquier edicion). */
  apply: (snap: EditSnapshot) => void;
}): EditHistory {
  const stackRef = useRef<Entry[]>([]);
  const indexRef = useRef(-1);
  const timerRef = useRef<number | null>(null);
  /** Firma de la instantanea que se acaba de aplicar con deshacer/rehacer: el cambio de propiedades que provoca no es un paso nuevo. */
  const applyingRef = useRef<string | null>(null);
  const latestRef = useRef<EditSnapshot>({ slots, textFields, values });
  const applyRef = useRef(apply);
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false });

  useEffect(() => {
    latestRef.current = { slots, textFields, values };
    applyRef.current = apply;
  });

  const publish = useCallback(() => {
    const index = indexRef.current;
    const length = stackRef.current.length;
    const next = { canUndo: index > 0, canRedo: index >= 0 && index < length - 1 };
    setFlags((current) =>
      current.canUndo === next.canUndo && current.canRedo === next.canRedo ? current : next,
    );
  }, []);

  /** Cierra el paso en curso: apila la instantanea vigente si cambio respecto a la de la entrada actual. */
  const commit = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stack = stackRef.current;
    if (stack.length === 0) return;
    const snap = latestRef.current;
    const sig = signatureOf(snap);
    if (sig === stack[indexRef.current].sig) return;
    stack.length = indexRef.current + 1;
    stack.push({ snap, sig });
    if (stack.length > HISTORY_LIMIT) stack.shift();
    indexRef.current = stack.length - 1;
    publish();
  }, [publish]);

  useEffect(() => {
    if (!enabled) {
      stackRef.current = [];
      indexRef.current = -1;
      applyingRef.current = null;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }
    const snap = { slots, textFields, values };
    const sig = signatureOf(snap);
    const stack = stackRef.current;
    if (stack.length === 0) {
      stack.push({ snap, sig });
      indexRef.current = 0;
      return;
    }
    if (applyingRef.current !== null) {
      // El cambio lo provoco deshacer/rehacer: la entrada vigente ya es esta instantanea.
      applyingRef.current = null;
      return;
    }
    if (sig === stack[indexRef.current].sig) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(commit, COALESCE_MS);
    // Mientras el paso sigue abierto ya hay algo que deshacer (el boton no espera a que se cierre el paso).
    window.setTimeout(() => setFlags((current) => (current.canUndo ? current : { ...current, canUndo: true })), 0);
  }, [enabled, slots, textFields, values, commit]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const go = useCallback(
    (direction: -1 | 1): boolean => {
      commit();
      const stack = stackRef.current;
      const target = indexRef.current + direction;
      if (target < 0 || target >= stack.length) return false;
      indexRef.current = target;
      applyingRef.current = stack[target].sig;
      applyRef.current(stack[target].snap);
      // Si aplicar no cambia nada (no hay nuevo render), la marca no debe quedarse y tragarse la siguiente edicion.
      window.setTimeout(() => {
        applyingRef.current = null;
      }, 300);
      publish();
      return true;
    },
    [commit, publish],
  );

  const undo = useCallback(() => go(-1), [go]);
  const redo = useCallback(() => go(1), [go]);

  return { canUndo: flags.canUndo, canRedo: flags.canRedo, undo, redo };
}
