"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FileText, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { localeTag } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  MAX_SAFE_FILE_SIZE,
  closePdfDocument,
  formatFileSize,
  isPdfFile,
  openPdfDocument,
  renderPageToDataUrl,
} from "@/lib/pdf/core";

export type FileListProps = {
  files: File[];
  onChange: (files: File[]) => void;
  /** Permite reordenar (relevante en herramientas multi-archivo). */
  reorderable?: boolean;
  className?: string;
};

export function FileList({
  files,
  onChange,
  reorderable = false,
  className,
}: FileListProps) {
  const { t, language } = useI18n();
  const locale = localeTag(language);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(files.filter((_, position) => position !== index));
  };

  return (
    <ul className={cn("space-y-2", className)}>
      {files.map((file, index) => {
        const oversized = file.size > MAX_SAFE_FILE_SIZE;
        return (
          <li
            key={`${file.name}-${file.lastModified}-${file.size}`}
            className="glass rounded-ios flex items-center gap-3 p-3"
          >
            <span className="h-11 w-9 shrink-0 overflow-hidden rounded-ios-sm bg-white/6">
              <FileThumbnail file={file} />
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {file.name}
              </p>
              <p
                className={cn(
                  "hud-label text-[10px]",
                  oversized ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {formatFileSize(file.size, locale)}
                {oversized ? ` · ${t.tool.errors.tooLarge}` : ""}
              </p>
            </div>

            {reorderable && files.length > 1 ? (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  label={t.tool.moveUp}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp aria-hidden="true" className="size-4" />
                </IconButton>
                <IconButton
                  label={t.tool.moveDown}
                  disabled={index === files.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown aria-hidden="true" className="size-4" />
                </IconButton>
              </div>
            ) : null}

            <IconButton label={t.tool.remove} onClick={() => remove(index)}>
              <X aria-hidden="true" className="size-4" />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

const THUMB_MAX_WIDTH = 72;

/**
 * Miniatura del archivo: primera pagina si es PDF, la propia imagen si es
 * una foto, o el icono generico como respaldo (formatos no soportados o
 * archivo dañado/cifrado que no se puede rasterizar aqui).
 */
function FileThumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    if (file.type.startsWith("image/")) {
      objectUrl = URL.createObjectURL(file);
      const url = objectUrl;
      queueMicrotask(() => {
        if (!cancelled) setUrl(url);
      });
    } else if (isPdfFile(file)) {
      void (async () => {
        let document: Awaited<ReturnType<typeof openPdfDocument>> | null =
          null;
        try {
          document = await openPdfDocument(file);
          if (cancelled) return;
          const page = await document.getPage(1);
          const dataUrl = await renderPageToDataUrl(page, {
            maxWidth: THUMB_MAX_WIDTH,
          });
          page.cleanup();
          if (!cancelled) setUrl(dataUrl);
        } catch {
          // Se queda en null: el icono generico sirve de respaldo.
        } finally {
          if (document) void closePdfDocument(document);
        }
      })();
    }

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className="h-full w-full object-cover" />
    );
  }

  return (
    <span className="flex h-full w-full items-center justify-center">
      <FileText aria-hidden="true" className="size-4 text-signal" />
    </span>
  );
}
