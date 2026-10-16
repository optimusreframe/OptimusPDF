"use client";

import { useRef } from "react";
import { FileText } from "lucide-react";
import { useDocumentThumbnail, useNearViewport } from "@/app/documents/useDocumentThumbnail";
import { cn } from "@/lib/cn";
import type { DocumentEntry } from "@/lib/docLibrary/types";

/** Miniatura de la pagina 1 de la copia guardada, dibujada en segundo plano; mientras tanto (o si falla) un icono. */
export function DocThumb({ doc, className }: { doc: Pick<DocumentEntry, "id" | "byteLength" | "fingerprint">; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(ref);
  const url = useDocumentThumbnail(doc, near);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        "flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-hairline bg-white/5",
        className,
      )}
    >
      {url ? (
        // Miniatura local (data URL): no es una imagen remota que `next/image` optimice.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" data-doc-thumb="" className="size-full bg-white object-cover object-top" />
      ) : (
        <FileText className="size-5 text-signal-text" />
      )}
    </span>
  );
}
