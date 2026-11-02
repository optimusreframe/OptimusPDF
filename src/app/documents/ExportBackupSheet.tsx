"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Download, Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { passwordBoxAvailable } from "@/lib/crypto/passwordBox";
import { downloadBlob } from "@/lib/pdf/core";
import { describeExport, recordBackup, type PackageModuleName } from "@/lib/backup/globalPackage";
import { markLastBackup } from "@/lib/backup/lastBackup";
import { summarizeLibraryExport, type LibraryExportSummary } from "@/lib/backup/modules/library";
import { buildLibraryExport, canShareFile, checkNewPassword, passwordStrength, shareFile, toFile } from "@/app/documents/backupFlow";
import { countText, fillText } from "@/app/documents/backupModel";
import { formatBytes } from "@/app/documents/documentsModel";

/**
 * «Exportar plantillas y documentos» (U4.5 + U4.2): resumen previo («N documentos, M plantillas, X MB»), casilla de contraseña
 * (marcada por defecto, recomendada), y descarga o `navigator.share({files})` en iPad. Mismo patrón que la hoja de firmas.
 * Nada sale del dispositivo: el archivo se descarga o se entrega a la hoja de compartir del sistema.
 */

export const BACKUP_INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

const LEVEL_COLORS = ["bg-destructive", "bg-accent-edit", "bg-signal", "bg-success"] as const;

type Phase = "form" | "building" | "ready" | "done";

/**
 * `documentIds` = exportar SOLO esos documentos y sus plantillas («Exportar seleccionados»). Sin él, toda la biblioteca. Un
 * subconjunto NO cuenta como respaldo (no marca «último respaldo»): lo que no viaja sigue sin respaldar.
 */
export function ExportBackupSheet({
  open,
  onClose,
  onDone,
  documentIds,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: (message: string) => void;
  documentIds?: readonly string[] | null;
}) {
  const { t } = useI18n();
  const subset = documentIds ?? null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={subset ? t.documents.backup.exportSelectedTitle : t.documents.backup.exportTitle}
      closeLabel={t.common.close}
      initialFocus="[data-backup-first]"
    >
      <ExportBody onClose={onClose} onDone={onDone} documentIds={subset} />
    </Sheet>
  );
}

function ExportBody({ onClose, onDone, documentIds }: { onClose: () => void; onDone?: (message: string) => void; documentIds: readonly string[] | null }) {
  const { t, language } = useI18n();
  const copy = t.documents.backup;
  const locale = localeTag(language);
  const canEncrypt = useMemo(() => passwordBoxAvailable(), []);
  const coarse = useMediaQuery("(pointer: coarse)");
  const [summary, setSummary] = useState<LibraryExportSummary | null>(null);
  const [protect, setProtect] = useState(canEncrypt);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [ready, setReady] = useState<{ file: File; documents: number; templates: number; encrypted: boolean; skipped: number } | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const aliveRef = useRef(true);
  /** Las demás partes del paquete que no tienen nada que respaldar (se calcula al abrir): cuentan como respaldadas. */
  const emptyPartsRef = useRef<PackageModuleName[] | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    void summarizeLibraryExport(documentIds ? { documentIds } : {}).then((value) => {
      if (aliveRef.current) setSummary(value);
    });
    void describeExport({ modules: { signatures: true, library: true, drafts: true, settings: true } })
      .then((all) => {
        emptyPartsRef.current = all.willOmitEmpty.filter((name) => name !== "library");
      })
      .catch(() => {
        emptyPartsRef.current = null;
      });
    return () => {
      aliveRef.current = false;
    };
    // El alcance se fija al abrir la hoja (se monta de nuevo cada vez): no cambia mientras esta abierta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === "ready" || phase === "done") headingRef.current?.focus();
  }, [phase]);

  const level = passwordStrength(password);
  const strengthText = password === "" ? copy.strengthNone : copy.strength[level];
  const wantsPassword = protect && canEncrypt;
  const building = phase === "building";
  const empty = summary !== null && summary.documents === 0 && summary.templates === 0;
  const docsText = (n: number) => countText(n, copy.docsOne, copy.docsMany);
  const templatesText = (n: number) => countText(n, copy.templatesOne, copy.templatesMany);

  const finish = (file: File, documents: number, templates: number, encrypted: boolean, skipped: number) => {
    // Solo viajaron plantillas y documentos: no es un respaldo completo si hay firmas o borradores sin respaldar.
    const announce = () =>
      onDone?.(fillText(documentIds ? copy.announceExportedSelected : copy.announceExported, { docs: docsText(documents), templates: templatesText(templates) }));
    if (documentIds) {
      // Solo viajo una parte: no es un respaldo y no se marca como tal.
      announce();
    } else if (emptyPartsRef.current) {
      markLastBackup(new Date(), { traveled: ["library"], empty: emptyPartsRef.current });
      announce();
    } else {
      void recordBackup(["library"]).then(announce);
    }
    const done = fillText(encrypted ? copy.doneEncrypted : copy.donePlain, { docs: docsText(documents), templates: templatesText(templates) });
    setInfo(`${done} ${fillText(copy.doneFile, { name: file.name })}`);
    setNotes(skipped > 0 ? [countText(skipped, copy.withoutCopyDoneOne, copy.withoutCopyDoneMany)] : []);
    setError("");
    setPhase("done");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (building || empty) return;
    setError("");
    if (wantsPassword) {
      const check = checkNewPassword(password, repeat);
      if (check === "empty" || check === "tooShort") {
        setError(copy.passwordTooShort);
        passwordRef.current?.focus();
        return;
      }
      if (check === "mismatch") {
        setError(copy.passwordMismatch);
        return;
      }
    }
    setPhase("building");
    const result = await buildLibraryExport({ password: wantsPassword ? password : undefined, ...(documentIds ? { documentIds } : {}) });
    if (!aliveRef.current) return;
    if (!result.ok) {
      setPhase("form");
      setError(
        result.reason === "tooLarge" && result.overBy
          ? `${copy.exportErrors.tooLarge} ${fillText(copy.tooLargeOver, { over: formatBytes(result.overBy, locale) })}`
          : copy.exportErrors[result.reason],
      );
      return;
    }
    const file = toFile(result.blob, result.filename);
    // iPad / móvil: la hoja de compartir pide un toque propio (Safari exige un gesto reciente y el cifrado ya tardó).
    if (coarse && canShareFile(file)) {
      setReady({ file, documents: result.documents, templates: result.templates, encrypted: result.encrypted, skipped: result.skippedDocuments });
      setInfo(fillText(copy.readyTitle, { name: file.name }));
      setPhase("ready");
      return;
    }
    downloadBlob(result.blob, result.filename);
    finish(file, result.documents, result.templates, result.encrypted, result.skippedDocuments);
  };

  const share = async () => {
    if (!ready) return;
    const outcome = await shareFile(ready.file);
    if (!aliveRef.current) return;
    if (outcome === "shared") finish(ready.file, ready.documents, ready.templates, ready.encrypted, ready.skipped);
    else if (outcome === "cancelled") setError(copy.shareCancelled);
    else {
      downloadBlob(ready.file, ready.file.name);
      finish(ready.file, ready.documents, ready.templates, ready.encrypted, ready.skipped);
    }
  };

  const download = () => {
    if (!ready) return;
    downloadBlob(ready.file, ready.file.name);
    finish(ready.file, ready.documents, ready.templates, ready.encrypted, ready.skipped);
  };

  const passwordId = "docs-backup-password";
  const repeatId = "docs-backup-repeat";

  return (
    <div className="space-y-4 pb-2" data-backup-export="">
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">
        {copy.exportTitle}
      </h3>

      {phase === "form" || phase === "building" ? (
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <p className="text-subheadline text-foreground [overflow-wrap:anywhere]" data-backup-summary="">
            {summary === null
              ? copy.summaryLoading
              : empty
                ? copy.exportEmpty
                : fillText(copy.summary, {
                    docs: docsText(summary.documents),
                    templates: templatesText(summary.templates),
                    size: formatBytes(summary.bytes, locale),
                  })}
          </p>
          {summary && summary.withoutCopy > 0 ? (
            <p className="text-footnote text-muted-foreground">
              {countText(summary.withoutCopy, copy.withoutCopyOne, copy.withoutCopyMany)}
            </p>
          ) : null}
          {documentIds ? (
            <p className="text-footnote text-muted-foreground" data-backup-selection-note="">
              {copy.exportSelectedNote}
            </p>
          ) : null}
          <p className="text-footnote text-muted-foreground">{copy.exportNever}</p>

          <Checkbox
            label={copy.protect}
            hint={canEncrypt ? copy.protectHint : copy.encryptionUnavailable}
            checked={wantsPassword}
            disabled={!canEncrypt || building}
            onChange={(next) => {
              setProtect(next);
              setError("");
            }}
          />

          {wantsPassword ? (
            <div className="space-y-3">
              <div>
                <label htmlFor={passwordId} className="ui-label mb-1.5 block text-muted-foreground">
                  {copy.password}
                </label>
                <input
                  ref={passwordRef}
                  id={passwordId}
                  data-backup-first
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  readOnly={building}
                  aria-describedby="docs-backup-strength"
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError("");
                  }}
                  className={BACKUP_INPUT_CLASS}
                />
                <div className="mt-2 flex items-center gap-2" id="docs-backup-strength">
                  <div
                    role="meter"
                    aria-label={copy.strengthLabel}
                    aria-valuemin={0}
                    aria-valuemax={3}
                    aria-valuenow={level}
                    aria-valuetext={strengthText}
                    className="flex h-1.5 w-24 shrink-0 gap-1"
                  >
                    {[1, 2, 3].map((segment) => (
                      <span key={segment} className={cn("h-full flex-1 rounded-full", level >= segment ? LEVEL_COLORS[level] : "bg-white/15")} />
                    ))}
                  </div>
                  <span className="text-footnote text-muted-foreground">{strengthText}</span>
                </div>
              </div>
              <div>
                <label htmlFor={repeatId} className="ui-label mb-1.5 block text-muted-foreground">
                  {copy.confirmPassword}
                </label>
                <input
                  id={repeatId}
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  readOnly={building}
                  aria-invalid={error === copy.passwordMismatch ? true : undefined}
                  onChange={(event) => {
                    setRepeat(event.target.value);
                    setError("");
                  }}
                  className={BACKUP_INPUT_CLASS}
                />
              </div>
            </div>
          ) : (
            <p
              data-backup-first
              tabIndex={-1}
              className="rounded-ios-sm border border-white/10 bg-white/5 p-3 text-footnote leading-relaxed text-foreground"
            >
              {copy.plainWarning}
            </p>
          )}

          <Button type="submit" size="md" fullWidth wrap disabled={building || summary === null || empty}>
            {copy.exportConfirm}
          </Button>
        </form>
      ) : null}

      {phase === "ready" && ready ? (
        <div className="space-y-3">
          <p className="text-subheadline text-foreground [overflow-wrap:anywhere]">{fillText(copy.readyTitle, { name: ready.file.name })}</p>
          <div className="flex flex-col gap-2">
            <Button size="md" fullWidth wrap onClick={() => void share()} data-backup-first>
              <Share2 aria-hidden="true" className="size-4" />
              {copy.shareButton}
            </Button>
            <Button variant="secondary" size="md" fullWidth wrap onClick={download}>
              <Download aria-hidden="true" className="size-4" />
              {copy.downloadButton}
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "done" ? (
        <div className="space-y-3">
          <p className="text-subheadline text-foreground [overflow-wrap:anywhere]" data-backup-result="">
            {info}
          </p>
          {notes.map((note) => (
            <p key={note} className="text-footnote text-destructive-text [overflow-wrap:anywhere]" data-backup-note="">
              {note}
            </p>
          ))}
          <Button size="md" fullWidth wrap onClick={onClose} data-backup-first>
            {copy.doneClose}
          </Button>
        </div>
      ) : null}

      {/* Región de estado ÚNICA. */}
      <p
        role="status"
        aria-live="polite"
        className={cn("flex items-center gap-2 text-footnote", error ? "text-destructive-text" : building ? "text-muted-foreground" : "sr-only")}
      >
        {building ? <Spinner className="size-4" /> : null}
        {building ? copy.exportWorking : error || (phase === "done" ? info : "")}
      </p>
    </div>
  );
}
