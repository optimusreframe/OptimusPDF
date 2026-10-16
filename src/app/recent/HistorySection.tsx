"use client";

import { useId } from "react";
import Link from "next/link";
import { FileText, FolderOpen, Trash2 } from "lucide-react";
import { DocThumb } from "@/app/documents/DocThumb";
import { useOpenInSign } from "@/app/documents/useOpenInSign";
import type { RecentRow } from "@/app/recent/recentIndex";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { HIT_44 } from "@/components/ui/touchTarget";
import { formatDateTime } from "@/lib/formatDate";
import { localeTag, useI18n } from "@/lib/i18n";
import type { DocumentEntry } from "@/lib/docLibrary/types";
import { removeRecentEntry } from "@/lib/recent";
import { TOOL_SLUGS, toolHref, type ToolSlug } from "@/lib/tools-registry";

function isKnownSlug(slug: string): slug is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(slug);
}

/** «Abrir de nuevo» con la copia de «Mis documentos»: deja el traspaso y abre Firmar. Solo se monta con coincidencia. */
function ReopenButton({ documentId, describedBy }: { documentId: string; describedBy: string }) {
  const { t } = useI18n();
  const openInSign = useOpenInSign();
  return (
    <Button variant="secondary" size="md" aria-describedby={describedBy} onClick={() => openInSign([documentId], "sign")}>
      {t.recent.reopen}
    </Button>
  );
}

/**
 * «Historial»: lo que ya terminaste. Cada fila: miniatura (si el documento esta en Mis documentos), nombre, herramienta,
 * «Terminado», fecha y «Abrir herramienta» (la herramienta pide el archivo). Si el trabajo apuntaba a un documento
 * cuya huella coincide con uno de Mis documentos, ofrece «Abrir de nuevo» con esa copia. «Borrar» quita la fila.
 */
export function HistorySection({
  rows,
  documents,
  onRemoved,
  children,
}: {
  rows: readonly RecentRow[];
  documents: readonly DocumentEntry[];
  onRemoved: () => void;
  /** Los botones de la seccion («Borrar historial»). */
  children?: React.ReactNode;
}) {
  const { t, language } = useI18n();
  const baseId = useId();
  if (rows.length === 0) return null;
  const locale = localeTag(language);
  return (
    <section aria-labelledby="recent-history-title" data-recent-history="">
      <h2 id="recent-history-title" className="text-title-3 text-foreground">
        {t.recent.historyTitle}
      </h2>
      <p className="mt-1 mb-3 text-subheadline text-muted-foreground">{t.recent.historyHint}</p>
      <ul className="space-y-2">
        {rows.map((row) => {
          const slug = isKnownSlug(row.slug) ? row.slug : null;
          const name = slug ? t.tools[slug].name : row.slug;
          const infoId = `${baseId}-${row.key.replace(/[^a-z0-9-]/gi, "_")}`;
          const library = row.library ? documents.find((doc) => doc.id === row.library?.id) : undefined;
          return (
            <li key={row.key} data-recent-key={row.key}>
              <div className="surface-card flex flex-wrap items-center gap-3 rounded-ios p-3">
                {library ? (
                  <DocThumb doc={library} className="h-12 w-10" />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                    <FileText aria-hidden="true" className="size-4 text-signal-text" />
                  </span>
                )}
                <div id={infoId} className="min-w-0 flex-1 basis-48">
                  <p className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground" title={row.fileName}>
                      {row.fileName}
                    </span>
                    <Badge variant="neutral" className="shrink-0" data-recent-status="finished">
                      {t.recent.statusFinished}
                    </Badge>
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {[name, formatDateTime(row.date, locale)].filter(Boolean).join(" · ")}
                  </p>
                  {row.library ? (
                    <p className="mt-0.5 flex items-center gap-1 text-caption text-muted-foreground">
                      <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{t.recent.reopenHint}</span>
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {row.library ? (
                    <ReopenButton documentId={row.library.id} describedBy={infoId} />
                  ) : slug ? (
                    <Link href={toolHref(slug)} className={buttonClasses("ghost", "md")}>
                      {t.recent.openTool}
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t.recent.removeRow.replace("{name}", row.fileName)}
                    onClick={() => {
                      if (row.entryId) removeRecentEntry(row.entryId);
                      onRemoved();
                    }}
                    className={`${HIT_44} flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal`}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {children}
    </section>
  );
}
