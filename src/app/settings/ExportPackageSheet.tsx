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
import { markLastBackup } from "@/lib/backup/lastBackup";
import {
  describeExport,
  exportEverything,
  type ExportDescription,
  type ExportEverythingResult,
  type ModuleChoice,
  type PackageModuleName,
} from "@/lib/backup/globalPackage";
import { canShareFile, checkNewPassword, passwordStrength, shareFile, toFile } from "@/app/documents/backupFlow";
import { countText, fillText } from "@/app/documents/backupModel";
import { BACKUP_INPUT_CLASS } from "@/app/documents/ExportBackupSheet";
import { chosenModules, defaultExportChoice, moduleAvailability, omissionNotes, summaryLine, tooLargeText, withoutCopyNote } from "@/app/settings/packageModel";

/**
 * «Exportar mi paquete» (U4.7): una hoja con una casilla por módulo (Firmas, Plantillas y documentos, Borradores, Ajustes),
 * cada una con su recuento; el historial de valores (datos de clientes) DESMARCADO por defecto; el aviso «contienen tu firma»
 * cuando los borradores llevan trazos; la contraseña (recomendada, no obligatoria: marcada por defecto si hay firmas,
 * borradores o historial, y se puede desmarcar con un aviso); un resumen previo con el tamaño; y la descarga o, en iPad,
 * `navigator.share({files})` en un SEGUNDO toque (Safari exige un gesto reciente). Toda la lógica vive en
 * `lib/backup/globalPackage.ts`. Nada sale del dispositivo.
 */

const LEVEL_COLORS = ["bg-destructive", "bg-accent-edit", "bg-signal", "bg-success"] as const;

type Phase = "form" | "building" | "ready" | "done";

type ReadyFile = { file: File; parts: string[]; encrypted: boolean; notes: string[]; included: PackageModuleName[] };

export function ExportPackageSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: (message: string) => void }) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onClose={onClose} title={t.settings.backup.exportTitle} closeLabel={t.common.close} initialFocus="[data-backup-first]">
      <ExportBody onClose={onClose} onDone={onDone} />
    </Sheet>
  );
}

function ExportBody({ onClose, onDone }: { onClose: () => void; onDone?: (message: string) => void }) {
  const { t, language } = useI18n();
  const copy = t.settings.backup;
  const locale = localeTag(language);
  const canEncrypt = useMemo(() => passwordBoxAvailable(), []);
  const coarse = useMediaQuery("(pointer: coarse)");

  const [choice, setChoice] = useState<ModuleChoice | null>(null);
  const [history, setHistory] = useState(false);
  const [strokes, setStrokes] = useState(true);
  const [description, setDescription] = useState<ExportDescription | null>(null);
  /** Lo que la persona puede elegir aunque la selección actual lo oculte (se calcula una vez con todo marcado). */
  const [capabilities, setCapabilities] = useState<{ strokes: boolean; history: boolean } | null>(null);
  /** Partes que no tienen nada que respaldar: cuentan como respaldadas al anotar el último respaldo (no hay nada que perder). */
  const emptyPartsRef = useRef<PackageModuleName[]>([]);
  const [protectChoice, setProtectChoice] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [ready, setReady] = useState<ReadyFile | null>(null);
  const aliveRef = useRef(true);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    void describeExport({ modules: { signatures: true, library: true, drafts: true, settings: true } }).then((all) => {
      if (!aliveRef.current) return;
      setCapabilities({ strokes: all.drafts.includesStrokes, history: all.settings.valueHistoryLabels > 0 });
      emptyPartsRef.current = all.willOmitEmpty;
      setChoice(defaultExportChoice(all));
    });
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (choice === null) return;
    let alive = true;
    void describeExport({ modules: choice, includeValueHistory: history && choice.settings === true, includeStrokes: strokes }).then((next) => {
      if (alive && aliveRef.current) setDescription(next);
    });
    return () => {
      alive = false;
    };
  }, [choice, history, strokes]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === "ready" || phase === "done") headingRef.current?.focus();
  }, [phase]);

  const building = phase === "building";
  const includeHistory = history && choice?.settings === true;
  const recommended = description?.encryptionRecommended ?? false;
  const protect = protectChoice ?? recommended;
  const wantsPassword = protect && canEncrypt;
  const level = passwordStrength(password);
  const strengthText = password === "" ? copy.strengthNone : copy.strength[level];
  const selection = choice ? chosenModules(choice) : [];
  const canSubmit = description !== null && choice !== null && selection.length > 0 && !description.nothingToExport && !description.tooLarge && !building;

  const setModule = (name: PackageModuleName, on: boolean) => {
    setChoice((current) => ({ ...(current ?? {}), [name]: on }));
    setError("");
  };

  const finish = (entry: ReadyFile) => {
    // Solo lo que de verdad viajó: un respaldo parcial (p. ej. solo Ajustes) no presume de uno completo ni reinicia el
    // contador de lo que se quedó fuera.
    markLastBackup(new Date(), { traveled: entry.included, empty: emptyPartsRef.current.filter((name) => !entry.included.includes(name)) });
    const done = fillText(entry.encrypted ? copy.doneEncrypted : copy.donePlain, { parts: entry.parts.join(", ") });
    setInfo(`${done} ${fillText(copy.doneFile, { name: entry.file.name })}`);
    setNotes(entry.notes);
    setError("");
    setPhase("done");
    onDone?.(fillText(copy.announceExported, { parts: entry.parts.join(", ") }));
  };

  const partsOf = (result: Extract<ExportEverythingResult, { ok: true }>): string[] => {
    const parts: string[] = [];
    const { counts } = result;
    if (counts.signatures > 0) parts.push(countText(counts.signatures, copy.sigOne, copy.sigMany));
    if (counts.documents > 0) parts.push(countText(counts.documents, copy.docsOne, copy.docsMany));
    if (counts.templates > 0) parts.push(countText(counts.templates, copy.templatesOne, copy.templatesMany));
    if (counts.drafts > 0) parts.push(countText(counts.drafts, copy.draftsOne, copy.draftsMany));
    if (result.included.includes("settings")) parts.push(counts.valueHistory ? `${copy.summarySettings}, ${copy.summaryHistory}` : copy.summarySettings);
    return parts;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !choice) return;
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
    const result = await exportEverything({
      modules: choice,
      includeValueHistory: includeHistory,
      includeStrokes: strokes,
      password: wantsPassword ? password : undefined,
    });
    if (!aliveRef.current) return;
    if (!result.ok) {
      setPhase("form");
      setError(copy.exportErrors[result.reason]);
      return;
    }
    const entry: ReadyFile = {
      file: toFile(result.blob, result.filename),
      parts: partsOf(result),
      encrypted: result.encrypted,
      notes: [...omissionNotes(result.omitted, copy), withoutCopyNote(result.libraryWithoutCopy, copy, "after")].filter((note): note is string => note !== null),
      included: result.included,
    };
    // iPad / móvil: la hoja de compartir pide un toque propio (Safari exige un gesto reciente y el cifrado ya tardó).
    if (coarse && canShareFile(entry.file)) {
      setReady(entry);
      setInfo(fillText(copy.readyTitle, { name: entry.file.name }));
      setPhase("ready");
      return;
    }
    downloadBlob(result.blob, result.filename);
    finish(entry);
  };

  const share = async () => {
    if (!ready) return;
    const outcome = await shareFile(ready.file);
    if (!aliveRef.current) return;
    if (outcome === "shared") finish(ready);
    else if (outcome === "cancelled") setError(copy.shareCancelled);
    else {
      downloadBlob(ready.file, ready.file.name);
      finish(ready);
    }
  };

  const download = () => {
    if (!ready) return;
    downloadBlob(ready.file, ready.file.name);
    finish(ready);
  };

  const availability = (name: PackageModuleName) => (description ? moduleAvailability(description, name) : "ok");
  const hintFor = (name: PackageModuleName, base: string) => {
    const state = availability(name);
    return state === "empty" ? copy.moduleEmpty : state === "unavailable" ? copy.moduleUnavailable : base;
  };
  const labelWithCount = (label: string, count: string | null) => (count ? `${label} (${count})` : label);

  const sig = description?.signatures;
  const lib = description?.library;
  const drafts = description?.drafts;
  const settings = description?.settings;
  const libCount = lib
    ? [
        lib.documents > 0 ? countText(lib.documents, copy.docsOne, copy.docsMany) : "",
        lib.templates > 0 ? countText(lib.templates, copy.templatesOne, copy.templatesMany) : "",
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  const passwordId = "pkg-backup-password";
  const repeatId = "pkg-backup-repeat";
  const showStrokesOption = capabilities?.strokes === true && choice?.drafts === true && (drafts?.withSignatureStrokes ?? 0) > 0;
  const showHistoryOption = capabilities?.history === true && choice?.settings === true;
  const contactsStrokesWarning = description?.containsSignatureStrokes === true;
  /** Documentos de la biblioteca sin copia del PDF: no viajan; se avisa ANTES de exportar (y después, con el resultado). */
  const withoutCopyBefore = description && choice?.library === true ? withoutCopyNote(description.library.withoutCopy, copy, "before") : null;

  return (
    <div className="space-y-4 pb-2" data-backup-export="">
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">
        {copy.exportTitle}
      </h3>

      {phase === "form" || phase === "building" ? (
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <p data-backup-first tabIndex={-1} className="text-subheadline text-muted-foreground [overflow-wrap:anywhere]">
            {copy.exportIntro}
          </p>

          <fieldset className="space-y-1" disabled={building}>
            <legend className="ui-label mb-1 text-muted-foreground">{copy.modulesLegend}</legend>
            <Checkbox
              label={labelWithCount(copy.sigLabel, sig && sig.count > 0 ? countText(sig.count, copy.sigOne, copy.sigMany) : null)}
              hint={hintFor("signatures", copy.sigHint)}
              checked={choice?.signatures === true && availability("signatures") === "ok"}
              disabled={availability("signatures") !== "ok" || building}
              onChange={(on) => setModule("signatures", on)}
            />
            <Checkbox
              label={labelWithCount(copy.libLabel, libCount)}
              hint={hintFor("library", copy.libHint)}
              checked={choice?.library === true && availability("library") === "ok"}
              disabled={availability("library") !== "ok" || building}
              onChange={(on) => setModule("library", on)}
            />
            <Checkbox
              label={labelWithCount(copy.draftsLabel, drafts && drafts.count > 0 ? countText(drafts.count, copy.draftsOne, copy.draftsMany) : null)}
              hint={hintFor("drafts", copy.draftsHint)}
              checked={choice?.drafts === true && availability("drafts") === "ok"}
              disabled={availability("drafts") !== "ok" || building}
              onChange={(on) => setModule("drafts", on)}
            />
            {showStrokesOption ? (
              <div className="pl-[34px]">
                <Checkbox label={copy.strokesLabel} hint={copy.strokesHint} checked={strokes} disabled={building} onChange={setStrokes} />
              </div>
            ) : null}
            {contactsStrokesWarning ? (
              <p className="rounded-ios-sm border border-accent-edit/40 bg-accent-edit/10 p-3 text-footnote leading-relaxed text-foreground" data-backup-strokes-warning="">
                {copy.strokesWarning}
              </p>
            ) : drafts && drafts.strokesHeldBack && choice?.drafts === true ? (
              <p className="text-footnote text-muted-foreground">{copy.strokesHeldBack}</p>
            ) : null}
            <Checkbox
              label={labelWithCount(copy.settingsLabel, settings && settings.keys > 0 ? countText(settings.keys, copy.keysOne, copy.keysMany) : null)}
              hint={hintFor("settings", copy.settingsHint)}
              checked={choice?.settings === true && availability("settings") === "ok"}
              disabled={availability("settings") !== "ok" || building}
              onChange={(on) => setModule("settings", on)}
            />
            {showHistoryOption ? (
              <div className="pl-[34px]">
                <Checkbox
                  label={labelWithCount(copy.historyLabel, settings ? countText(settings.valueHistoryLabels, copy.labelsOne, copy.labelsMany) : null)}
                  hint={copy.historyHint}
                  checked={history}
                  disabled={building}
                  onChange={setHistory}
                />
              </div>
            ) : null}
          </fieldset>

          <p className="text-subheadline text-foreground [overflow-wrap:anywhere]" data-backup-summary="">
            {summaryLine(description, copy, locale, { includeValueHistory: includeHistory })}
          </p>
          {withoutCopyBefore ? (
            <p className="text-footnote text-muted-foreground [overflow-wrap:anywhere]" data-backup-without-copy="">
              {withoutCopyBefore}
            </p>
          ) : null}
          {description && description.tooLarge ? (
            <p className="text-footnote text-destructive-text [overflow-wrap:anywhere]" data-backup-too-large="">
              {tooLargeText(description, copy, locale)}
            </p>
          ) : null}

          <Checkbox
            label={copy.protect}
            hint={canEncrypt ? copy.protectHint : copy.encryptionUnavailable}
            checked={wantsPassword}
            disabled={!canEncrypt || building}
            onChange={(next) => {
              setProtectChoice(next);
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
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  readOnly={building}
                  aria-describedby="pkg-backup-strength"
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError("");
                  }}
                  className={BACKUP_INPUT_CLASS}
                />
                <div className="mt-2 flex items-center gap-2" id="pkg-backup-strength">
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
              data-backup-plain-warning={recommended ? "sensitive" : "plain"}
              className="rounded-ios-sm border border-white/10 bg-white/5 p-3 text-footnote leading-relaxed text-foreground"
            >
              {recommended ? copy.plainWarningSensitive : copy.plainWarning}
            </p>
          )}

          <Button type="submit" size="md" fullWidth wrap disabled={!canSubmit}>
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
