"use client";

import { useEffect, useState } from "react";
import { sha256Hex } from "@/lib/pdf/core";

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
    documentContentKey(file)
      .then((key) => {
        computed.set(file, key);
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
