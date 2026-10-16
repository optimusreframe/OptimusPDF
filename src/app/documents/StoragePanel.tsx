"use client";

import { HardDrive, ShieldCheck, ShieldAlert } from "lucide-react";
import { formatBytes, persistView } from "@/app/documents/documentsModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { localeTag, useI18n } from "@/lib/i18n";
import type { LibraryMeta, LibraryUsage } from "@/lib/docLibrary/store";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Uso de almacenamiento, estado de «almacenamiento persistente» (con boton para pedirlo), consejo para iPad/Safari y el
 * hueco de «Respaldar mis documentos» (deshabilitado: lo hara otra fase).
 */
export function StoragePanel({
  usage,
  meta,
  onRequestPersistence,
  requesting,
}: {
  usage: LibraryUsage | null;
  meta: LibraryMeta | null;
  onRequestPersistence: () => void;
  requesting: boolean;
}) {
  const { t, language } = useI18n();
  const locale = localeTag(language);
  const view = persistView(meta?.persistence ?? null);
  const message =
    view === "granted"
      ? t.documents.persistGranted
      : view === "denied"
        ? t.documents.persistDenied
        : view === "unsupported"
          ? t.documents.persistUnsupported
          : t.documents.persistUnknown;
  return (
    <section aria-labelledby="documents-storage-title" data-documents-storage="" className="surface-card mt-10 rounded-ios p-4 md:p-5">
      <h2 id="documents-storage-title" className="flex items-center gap-2 text-title-3 text-foreground">
        <HardDrive aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        {t.documents.storageTitle}
      </h2>
      {usage ? (
        <p className="mt-2 text-subheadline text-muted-foreground" data-storage-usage="">
          {fill(t.documents.storageUsage, {
            used: formatBytes(usage.bytes, locale),
            max: formatBytes(usage.limits.maxTotalBytes, locale),
            n: String(usage.documents),
            maxDocs: String(usage.limits.maxDocuments),
          })}
        </p>
      ) : null}
      <p className="mt-3 flex items-start gap-2 text-subheadline text-foreground" data-persist-state={view}>
        {view === "granted" ? (
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />
        ) : (
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
        )}
        <span className="min-w-0">{message}</span>
      </p>
      {view !== "granted" && view !== "unsupported" ? (
        <Button variant="secondary" size="md" wrap className="mt-3" disabled={requesting} onClick={onRequestPersistence}>
          {t.documents.persistRequest}
        </Button>
      ) : null}
      <p className="mt-3 text-footnote text-muted-foreground">{t.documents.persistTip}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="md" wrap disabled aria-disabled="true">
          {t.documents.backup}
        </Button>
        <Badge variant="soon">{t.documents.backupSoon}</Badge>
      </div>
    </section>
  );
}
