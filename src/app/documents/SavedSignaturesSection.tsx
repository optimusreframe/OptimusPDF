"use client";

import { useMemo, useState } from "react";
import { Download, PenLine, Settings2, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { SignatureExportSheet, SignatureRestoreSheet } from "@/app/sign-pdf/SignatureBackupSheet";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { vaultImageToDataUrl, type VaultEntry, type VaultImage } from "@/app/sign-pdf/signVault";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function Thumb({ image, alt }: { image: VaultImage; alt: string }) {
  const src = useMemo(() => vaultImageToDataUrl(image), [image]);
  return (
    <span className="rounded-ios-sm flex h-12 min-w-14 items-center justify-center border border-hairline bg-white px-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-h-10 w-auto max-w-28 object-contain" />
    </span>
  );
}

/**
 * «Firmas guardadas» dentro de Mis documentos: las firmas e iniciales de cada firmante (el baúl de Firmar PDF), a la vista, con
 * «Exportar todas», «Exportar seleccionadas» e «Importar firmas» (las mismas hojas de respaldo de Firmar PDF, cifrado
 * recomendado). Nada sale del dispositivo: el archivo se descarga o se entrega a la hoja de compartir del sistema.
 */
export function SavedSignaturesSection({ onNotice }: { onNotice: (message: string) => void }) {
  const { t, language } = useI18n();
  const copy = t.documents.signatures;
  const strings = SIGN_STRINGS[language];
  const enabled = useSignPdfFeatureFlag("signatureVault");
  const { status, entries } = useSignatureVault(enabled);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Alcance de «Exportar»: `null` = todas; una lista = solo esas. Se fija al abrir la hoja. */
  const [exportScope, setExportScope] = useState<readonly string[] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const sorted = useMemo(() => entries.slice().sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)), [entries]);
  const liveIds = useMemo(() => new Set(sorted.map((entry) => entry.id)), [sorted]);
  const chosen = useMemo(() => sorted.filter((entry) => selected.has(entry.id)).map((entry) => entry.id), [sorted, selected]);

  if (!enabled || status === "loading" || status === "unavailable") return null;

  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set([...previous].filter((value) => liveIds.has(value)));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openExport = (scope: readonly string[] | null) => {
    setExportScope(scope);
    setExportOpen(true);
  };

  return (
    <section aria-labelledby="documents-signatures-title" data-documents-signatures="" className="surface-card mt-10 rounded-ios p-4 md:p-5">
      <h2 id="documents-signatures-title" className="flex items-center gap-2 text-title-3 text-foreground">
        <PenLine aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        {copy.title}
      </h2>
      <p className="mt-1 text-footnote text-muted-foreground">{copy.intro}</p>

      {sorted.length === 0 ? (
        <p className="mt-3 text-subheadline text-muted-foreground" data-signatures-empty="">
          {copy.empty}
        </p>
      ) : (
        <>
          <p className="mt-3 text-subheadline text-muted-foreground" data-signatures-count="">
            {sorted.length === 1 ? copy.countOne : fill(copy.countMany, { n: String(sorted.length) })}
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-2" data-signatures-list="">
            {sorted.map((entry: VaultEntry) => {
              const isSelected = selected.has(entry.id);
              return (
                <li
                  key={entry.id}
                  data-signature-id={entry.id}
                  className={cn("flex items-center gap-3 rounded-ios-sm border p-2", isSelected ? "border-signal/60" : "border-hairline")}
                >
                  <label className="relative -ml-1 flex size-11 shrink-0 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(entry.id)}
                      aria-label={fill(copy.select, { name: entry.signerName })}
                      className="size-[22px] cursor-pointer accent-[var(--color-signal)]"
                    />
                  </label>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="text-callout font-medium text-foreground [overflow-wrap:anywhere]">{entry.signerName}</p>
                      {entry.role ? <p className="text-footnote text-muted-foreground [overflow-wrap:anywhere]">{entry.role}</p> : null}
                      <p className="text-footnote text-muted-foreground">
                        {entry.signature && entry.initials ? copy.both : entry.signature ? copy.onlySignature : copy.onlyInitials}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {entry.signature ? <Thumb image={entry.signature} alt={fill(copy.signatureOf, { name: entry.signerName })} /> : null}
                      {entry.initials ? <Thumb image={entry.initials} alt={fill(copy.initialsOf, { name: entry.signerName })} /> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-signatures-actions="">
        {sorted.length > 0 ? (
          <Button variant="secondary" size="md" wrap data-signatures-export-all="" onClick={() => openExport(null)}>
            <Download aria-hidden="true" className="size-4 shrink-0" />
            {fill(copy.exportAll, { n: String(sorted.length) })}
          </Button>
        ) : null}
        {chosen.length > 0 ? (
          <Button variant="secondary" size="md" wrap data-signatures-export-selected="" onClick={() => openExport(chosen)}>
            <Download aria-hidden="true" className="size-4 shrink-0" />
            {fill(copy.exportSelected, { n: String(chosen.length) })}
          </Button>
        ) : null}
        <Button variant="secondary" size="md" wrap data-signatures-import="" onClick={() => setImportOpen(true)}>
          <Upload aria-hidden="true" className="size-4 shrink-0" />
          {copy.importAction}
        </Button>
        {sorted.length > 0 ? (
          <Button variant="ghost" size="md" wrap data-signatures-manage="" onClick={() => setManageOpen(true)}>
            <Settings2 aria-hidden="true" className="size-4 shrink-0" />
            {copy.manage}
          </Button>
        ) : null}
      </div>
      <p className="mt-3 text-footnote text-muted-foreground">{copy.privacy}</p>

      <SignatureExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        strings={strings}
        count={exportScope ? exportScope.filter((id) => liveIds.has(id)).length : sorted.length}
        entryIds={exportScope}
        onDone={onNotice}
      />
      <SignatureRestoreSheet open={importOpen} onClose={() => setImportOpen(false)} strings={strings} onDone={onNotice} />
      <SignatureVaultSheet open={manageOpen} onClose={() => setManageOpen(false)} strings={strings} />
    </section>
  );
}
