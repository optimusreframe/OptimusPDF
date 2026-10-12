"use client";

import { useEffect, useState } from "react";
import { localeTag, useI18n } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import { readMetadata } from "@/lib/pdf/metadata";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

type MetaState = { snapshotId: string; title: string; author: string } | "failed" | null;

/**
 * Resumen del documento de trabajo (pestaña Inicio): nombre, paginas, peso, firmas, cifrado, titulo y autor
 * (leidos del snapshot ACTUAL, asi que se actualizan tras cambiar los metadatos) y pasos del historial.
 */
export function DocSummary() {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.summary;
  const { document } = useProWorkingDoc();
  const snapshot = document ? document.snapshots[document.cursor] : null;
  const [meta, setMeta] = useState<MetaState>(null);
  const snapshotId = snapshot?.id ?? "";
  const bytes = snapshot?.bytes ?? null;

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    readMetadata(bytes)
      .then((info) => {
        if (!cancelled) setMeta({ snapshotId, title: info.title, author: info.author });
      })
      .catch(() => {
        if (!cancelled) setMeta("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotId, bytes]);

  if (!document || !snapshot) return null;
  const locale = localeTag(language);
  const metaReady = meta !== null && meta !== "failed" && meta.snapshotId === snapshot.id ? meta : null;
  const metaText = (value: string | undefined): string =>
    meta === "failed" ? s.metadataNone : metaReady ? value || s.metadataNone : s.metadataLoading;

  const rows: Array<[string, string]> = [
    [s.name, document.name],
    [s.pages, getProStrings(language).suite.pageCount(snapshot.pageCount)],
    [s.size, formatFileSize(snapshot.byteLength, locale)],
    [s.signatures, s.signaturesValue[document.signatures]],
    [s.encryption, document.wasEncrypted ? s.encryptedValue : s.plainValue],
    [s.metadataTitle, metaText(metaReady?.title)],
    [s.metadataAuthor, metaText(metaReady?.author)],
    [s.history, s.historyValue(document.cursor)],
  ];

  return (
    <section aria-labelledby="pro-summary-title" data-doc-summary="">
      <h2 id="pro-summary-title" className="ui-label mb-2 text-muted-foreground">
        {s.title}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-ios-sm border border-hairline bg-white/5 p-3 text-subheadline">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0 truncate text-right text-foreground" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
