"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { matchesAccept, type PdfErrorCode } from "@/lib/pdf/core";
import type { Tool } from "@/lib/tools-registry";

/**
 * «Elegir otro archivo» para las herramientas con cabecera propia (Wave 6 · N3): un selector oculto
 * que se abre desde el banner y entrega el archivo elegido a `onPick` (que lo coloca donde estaba el
 * malo). `open()` se llama desde un manejador de clic, asi el navegador permite abrir el selector.
 * Un archivo de otro formato se rechaza con `onInvalid("invalidType")`.
 */
export function useReplaceFilePicker({
  tool,
  onPick,
  onInvalid,
}: {
  tool: Pick<Tool, "accept" | "extensions">;
  onPick: (file: File) => void;
  onInvalid: (code: PdfErrorCode) => void;
}): { open: () => void; input: ReactNode } {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const open = useCallback(() => inputRef.current?.click(), []);
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={[...tool.accept, ...tool.extensions].join(",")}
      aria-label={t.tool.chooseAnother}
      className="sr-only"
      tabIndex={-1}
      onChange={(event) => {
        const picked = Array.from(event.target.files ?? []).find((file) =>
          matchesAccept(file, tool.accept, tool.extensions),
        );
        const any = (event.target.files?.length ?? 0) > 0;
        event.target.value = "";
        if (picked) onPick(picked);
        else if (any) onInvalid("invalidType");
      }}
    />
  );
  return { open, input };
}
