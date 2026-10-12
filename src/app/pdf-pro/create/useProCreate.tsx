"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { NewBlankSheet, NewFromImagesSheet } from "@/app/pdf-pro/create/CreateSheets";

/**
 * «Nuevo PDF desde imágenes» y «Nuevo documento en blanco» de PDF Pro (Wave 7 · U8): el selector de imagenes
 * (oculto, se abre desde cualquier boton o menu) y las dos hojas. Se monta UNA vez en `ProApp` y lo comparten el
 * estado vacio y el menu de la suite; `onCreated` recibe el PDF ya creado para abrirlo como documento nuevo.
 */
export function useProCreate(onCreated: (file: File) => void): {
  pickImages: () => void;
  openBlank: () => void;
  node: ReactNode;
} {
  const input = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<"images" | "blank" | null>(null);
  const [files, setFiles] = useState<File[]>([]);

  const pickImages = useCallback(() => input.current?.click(), []);
  const openBlank = useCallback(() => setSheet("blank"), []);
  const close = useCallback(() => setSheet(null), []);
  const created = useCallback(
    (file: File) => {
      setSheet(null);
      onCreated(file);
    },
    [onCreated],
  );

  const node = (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-pro-create-input=""
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length === 0) return;
          setFiles(picked);
          setSheet("images");
        }}
      />
      <NewFromImagesSheet open={sheet === "images"} initialFiles={files} onClose={close} onCreated={created} />
      <NewBlankSheet open={sheet === "blank"} onClose={close} onCreated={created} />
    </>
  );
  return { pickImages, openBlank, node };
}
