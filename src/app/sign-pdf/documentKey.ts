"use client";

import { useEffect, useRef, useState } from "react";
import { sha256Hex } from "@/lib/pdf/core";
import type { DocId } from "@/app/sign-pdf/docSet";

/**
 * Identidad del documento por su contenido, para firma.
 *
 * La identidad barata de `fileKey()` (nombre, tamaño y fecha) sirve para
 * decidir si hay que rehacer un plan de paginas, pero no para atar una
 * firma a un documento: dos PDF distintos pueden coincidir en las tres
 * cosas, y entonces los trazos de uno se aplicarian sobre el otro sin que
 * nadie llegase a verlo. El hash del contenido no se confunde.
 */
export async function documentContentKey(file: File): Promise<string> {
  return sha256Hex(new Uint8Array(await file.arrayBuffer()));
}

/** Huellas ya calculadas; la entrada se libera con el propio `File`. */
const computed = new WeakMap<File, string>();

/** Calculos en vuelo: dos consumidores del mismo archivo comparten UNA lectura. */
const inflight = new WeakMap<File, Promise<string>>();

/**
 * Huella con cache y sin lecturas duplicadas: la usan `useDocumentKey` (el
 * documento activo) y `useDocumentKeys` (toda la cola) para no leer dos veces
 * el mismo PDF.
 */
function contentKeyOnce(file: File): Promise<string> {
  const known = computed.get(file);
  if (known !== undefined) return Promise.resolve(known);
  let pending = inflight.get(file);
  if (!pending) {
    pending = documentContentKey(file)
      .then((key) => {
        computed.set(file, key);
        return key;
      })
      .finally(() => {
        inflight.delete(file);
      });
    inflight.set(file, pending);
  }
  return pending;
}

/**
 * Huella del archivo cargado. Devuelve `null` mientras se calcula y si no
 * se puede calcular (navegador sin `crypto.subtle`, lectura fallida): sin
 * huella no se da por buena ninguna captura anterior, porque repetir una
 * firma cuesta mucho menos que aplicarla a ciegas.
 */
export function useDocumentKey(file: File | null): string | null {
  const known = file ? (computed.get(file) ?? null) : null;
  const [state, setState] = useState<{ file: File | null; key: string | null }>(
    { file, key: known },
  );

  // Ajuste durante el render: al cambiar de archivo la huella anterior
  // deja de valer en el acto, sin esperar a que corra el efecto.
  if (state.file !== file) setState({ file, key: known });

  useEffect(() => {
    if (!file || computed.has(file)) return;
    let alive = true;
    contentKeyOnce(file)
      .then((key) => {
        if (alive) setState({ file, key });
      })
      .catch(() => {
        if (alive) setState({ file, key: null });
      });
    return () => {
      alive = false;
    };
  }, [file]);

  return state.file === file ? state.key : known;
}

/** Un documento de la ronda: su `DocId` estable y el archivo cuya huella se pide. */
export type KeyedDoc = { id: DocId; file: File };

/** Huellas que se calculan a la vez: leer un PDF grande entero en memoria no se multiplica por N. */
export const KEY_CONCURRENCY = 2;

type ResolvedKey = { file: File; key: string | null };

/**
 * Huella de VARIOS documentos, indexada por `DocId` (no por huella ni por
 * posicion). `null` = aun calculandose o imposible de calcular, igual que
 * `useDocumentKey`: sin huella no se da por buena ninguna captura.
 *
 *  - Cola de concurrencia limitada (`KEY_CONCURRENCY`) en el orden de la
 *    cola de documentos; comparte cache y lecturas en vuelo con
 *    `useDocumentKey`, asi que un documento ya calculado (o calculandose en
 *    el flujo activo) no se lee dos veces.
 *  - Un resultado solo se acepta si su `DocId` sigue vivo CON EL MISMO
 *    ARCHIVO cuando llega: si el documento se quito (o se cambio por otro)
 *    mientras se calculaba, la huella se descarta. Es lo que cierra por
 *    construccion las carreras de "quitar y subir".
 *  - Dos copias identicas dan la misma huella con distinto `DocId`: se
 *    aceptan (ver `duplicateGroups` en `docSet.ts` para avisarlo).
 */
export function useDocumentKeys(
  docs: readonly KeyedDoc[],
  concurrency: number = KEY_CONCURRENCY,
): Record<DocId, string | null> {
  const [resolved, setResolved] = useState<Record<DocId, ResolvedKey>>({});
  /** Documentos vivos ahora mismo (`DocId` -> archivo). */
  const liveRef = useRef<Map<DocId, File>>(new Map());
  /** Documentos para los que ya se entrego un resultado (`DocId` -> archivo). */
  const settledRef = useRef<Map<DocId, File>>(new Map());
  const queueRef = useRef<KeyedDoc[]>([]);
  /** Archivos que se estan leyendo (por archivo, no por `DocId`: el mismo `DocId` puede pasar a otro archivo mientras se lee el anterior). */
  const runningRef = useRef<Set<File>>(new Set());
  const aliveRef = useRef(true);
  const pumpRef = useRef<() => void>(() => {});

  useEffect(() => {
    aliveRef.current = true;
    pumpRef.current = () => {
      while (
        aliveRef.current &&
        runningRef.current.size < Math.max(1, concurrency) &&
        queueRef.current.length > 0
      ) {
        const next = queueRef.current.shift();
        if (!next) break;
        // Retirado mientras esperaba turno: ni se lee.
        if (liveRef.current.get(next.id) !== next.file) continue;
        runningRef.current.add(next.file);
        const settle = (key: string | null) => {
          runningRef.current.delete(next.file);
          // Solo cuenta si el documento sigue siendo ESE archivo.
          if (aliveRef.current && liveRef.current.get(next.id) === next.file) {
            settledRef.current.set(next.id, next.file);
            setResolved((previous) => ({
              ...previous,
              [next.id]: { file: next.file, key },
            }));
          }
          pumpRef.current();
        };
        contentKeyOnce(next.file).then(settle, () => settle(null));
      }
    };
    return () => {
      aliveRef.current = false;
    };
  }, [concurrency]);

  useEffect(() => {
    liveRef.current = new Map(docs.map((doc) => [doc.id, doc.file]));
    for (const id of [...settledRef.current.keys()]) {
      if (!liveRef.current.has(id)) settledRef.current.delete(id);
    }
    const queued = new Set<DocId>();
    queueRef.current = docs.filter((doc) => {
      if (settledRef.current.get(doc.id) === doc.file) return false;
      if (runningRef.current.has(doc.file)) return false;
      if (queued.has(doc.id)) return false;
      queued.add(doc.id);
      return true;
    });
    pumpRef.current();
  }, [docs]);

  const keys: Record<DocId, string | null> = {};
  for (const doc of docs) {
    const entry = resolved[doc.id];
    keys[doc.id] = entry && entry.file === doc.file ? entry.key : null;
  }
  return keys;
}
