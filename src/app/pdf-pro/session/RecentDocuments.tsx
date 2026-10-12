"use client";

import { FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/pdf/core";
import { localeTag, type Language } from "@/lib/i18n";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import { formatProDate, getProStrings } from "@/app/pdf-pro/proStrings";
import { useDraftThumbnails } from "@/app/pdf-pro/session/useDraftThumbnails";

/**
 * Lista de documentos recientes (los borradores de este navegador): miniatura de la primera pagina, nombre, fecha,
 * numero de cambios y peso. Una unica lista para el estado vacio y para la hoja «Documentos recientes» de la suite.
 */
export function RecentDocumentsList({
  drafts,
  language,
  busy,
  onOpen,
  thumbnails = true,
}: {
  drafts: readonly ProDraftSummary[];
  language: Language;
  busy: boolean;
  onOpen: (id: string) => void;
  thumbnails?: boolean;
}) {
  const strings = getProStrings(language);
  const thumbs = useDraftThumbnails(drafts, thumbnails);
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-recent-list="">
      {drafts.map((draft) => {
        const thumb = thumbs[draft.id];
        return (
          <li key={draft.id}>
            <button
              type="button"
              // `aria-disabled` y no `disabled`: un boton que se desactiva con el foco puesto lo dejaria caer a <body>.
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onOpen(draft.id);
              }}
              aria-label={strings.empty.recentOpen(draft.fileName)}
              data-recent-id={draft.id}
              className={cn(
                "surface-card flex min-h-11 w-full items-center gap-3 rounded-ios p-3.5 text-left",
                "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                "hover:border-hairline-strong hover:bg-elevated active:scale-[0.99] active:duration-[80ms]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                "aria-disabled:opacity-60",
              )}
            >
              {thumb ? (
                // Miniatura local (data URL de la primera pagina): no es una imagen remota que `next/image` pueda optimizar.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt=""
                  aria-hidden="true"
                  data-recent-thumb=""
                  className="h-16 w-12 shrink-0 rounded-lg border border-hairline bg-white object-cover object-top"
                />
              ) : (
                <span className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg border border-hairline bg-white/5">
                  <FileText aria-hidden="true" className="size-5 text-muted-foreground" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-subheadline font-semibold text-foreground">{draft.fileName}</span>
                <span className="block truncate text-caption text-muted-foreground">
                  {strings.empty.recentDraftNote(draft.steps, formatProDate(draft.savedAt, language))}
                </span>
                <span className="block truncate text-caption text-muted-foreground">
                  {draft.pageCount ? `${strings.suite.pageCount(draft.pageCount)} · ` : ""}
                  {formatFileSize(draft.fileSize, localeTag(language))}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
