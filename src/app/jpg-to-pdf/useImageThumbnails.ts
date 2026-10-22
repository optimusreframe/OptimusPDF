"use client";

import { useEffect, useRef, useState } from "react";
import { getThumbnailBlob } from "@/lib/image/thumbnail";

/**
 * URLs de miniatura de `files` (misma posicion que `files`), generadas de una en una, sin bloquear la pantalla, y
 * revocadas al desmontar. `undefined` = todavia no esta; `null` = el navegador no pudo (la interfaz usa entonces el archivo
 * original). Las ya hechas se reutilizan al cambiar el orden o quitar fotos.
 */
export function useImageThumbnails(files: readonly File[]): Array<string | null | undefined> {
  const [thumbs, setThumbs] = useState<ReadonlyMap<File, string | null>>(() => new Map());
  // Verdad mutable (solo se lee en efectos y manejadores, nunca al pintar): que miniaturas existen y hay que revocar.
  const made = useRef(new Map<File, string | null>());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const file of files) {
        if (cancelled) return;
        if (made.current.has(file)) continue;
        const blob = await getThumbnailBlob(file);
        if (cancelled) return;
        const url = blob ? URL.createObjectURL(blob) : null;
        made.current.set(file, url);
        // Actualizacion funcional: varias miniaturas que terminan seguidas no se pisan entre si.
        setThumbs((previous) => new Map(previous).set(file, url));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  // Al desmontar se liberan todas las miniaturas.
  useEffect(() => {
    const store = made.current;
    return () => {
      for (const url of store.values()) if (url) URL.revokeObjectURL(url);
      store.clear();
    };
  }, []);

  return files.map((file) => thumbs.get(file));
}
