"use client";

import { Download, HardDrive, ShieldCheck, ShieldAlert, Upload } from "lucide-react";
import { fillText, lastBackupView, type LastBackupView } from "@/app/documents/backupModel";
import { formatBytes, persistView } from "@/app/documents/documentsModel";
import { Button } from "@/components/ui/Button";
import { localeTag, useI18n } from "@/lib/i18n";
import type { LibraryMeta, LibraryUsage } from "@/lib/docLibrary/store";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function lastBackupText(view: LastBackupView, copy: { lastNever: string; lastToday: string; lastYesterday: string; lastDays: string }): string {
  if (view.kind === "never") return copy.lastNever;
  if (view.kind === "today") return copy.lastToday;
  if (view.kind === "yesterday") return copy.lastYesterday;
  return fillText(copy.lastDays, { n: view.n });
}

/**
 * Uso de almacenamiento, estado de «almacenamiento persistente» (con boton para pedirlo), consejo para iPad/Safari y el
 * respaldo (U4.5 + U4.2): «Exportar plantillas y documentos», «Importar» y «Último respaldo».
 */
export function StoragePanel({
  usage,
  meta,
  onRequestPersistence,
  requesting,
  lastBackup,
  onExport,
  onImport,
}: {
  usage: LibraryUsage | null;
  meta: LibraryMeta | null;
  onRequestPersistence: () => void;
  requesting: boolean;
  /** Fecha del último respaldo exportado desde este navegador (`null` = nunca). */
  lastBackup: Date | null;
  onExport: () => void;
  onImport: () => void;
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
      <div className="mt-5 border-t border-hairline pt-4" data-documents-backup="">
        <h3 className="text-headline text-foreground">{t.documents.backup.title}</h3>
        <p className="mt-1 text-footnote text-muted-foreground">{t.documents.backup.intro}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="secondary" size="md" wrap onClick={onExport} data-backup-export-open="">
            <Download aria-hidden="true" className="size-4 shrink-0" />
            {t.documents.backup.exportAction}
          </Button>
          <Button variant="secondary" size="md" wrap onClick={onImport} data-backup-import-open="">
            <Upload aria-hidden="true" className="size-4 shrink-0" />
            {t.documents.backup.importAction}
          </Button>
        </div>
        <p className="mt-3 text-footnote text-muted-foreground" data-backup-last="">
          {lastBackupText(lastBackupView(lastBackup), t.documents.backup)}
        </p>
      </div>
    </section>
  );
}
