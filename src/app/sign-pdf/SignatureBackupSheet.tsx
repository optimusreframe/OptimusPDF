"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Download, FileUp, Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { passwordBoxAvailable } from "@/lib/crypto/passwordBox";
import { decisionOptions, describeApplyFailure, exportErrorKey } from "@/app/sign-pdf/backupModel";
import {
  applyBackupImport,
  buildSignaturesExport,
  canShareFile,
  checkNewPassword,
  passwordStrength,
  readSignaturesBackup,
  shareFile,
  toFile,
} from "@/app/sign-pdf/backupFlow";
import {
  checkSignaturesLimits,
  defaultSignatureDecisions,
  type ImportPlan,
  type SignatureDecision,
  type SignatureImportItem,
} from "@/lib/backup/modules/signatures";
import { MAX_VAULT_ENTRIES } from "@/app/sign-pdf/signVault";
import type { SignStrings, VaultBackupStrings } from "@/app/sign-pdf/strings";

/**
 * Hojas de respaldo de «Firmas guardadas» (U4.4-UI): «Exportar todas mis firmas» (con contrasena opcional, recomendada)
 * e «Importar firmas» (vista previa por elemento, fusion sin pisar nada que el usuario no apruebe). La logica vive en
 * `backupFlow.ts` / `backupModel.ts` y en `lib/backup`; aqui solo se pinta y se encadena. Nada sale del dispositivo:
 * el archivo se descarga o se entrega a la hoja de compartir del sistema, y el usuario decide el destino.
 */

const INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

const LEVEL_COLORS = ["bg-destructive", "bg-accent-edit", "bg-signal", "bg-success"] as const;

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

export type SignatureExportSheetProps = {
  open: boolean;
  onClose: () => void;
  strings: SignStrings;
  /** Firmas guardadas ahora (para el texto). */
  count: number;
  /** Aviso para la region de estado de quien abrio la hoja. */
  onDone?: (message: string) => void;
};

export function SignatureExportSheet({ open, onClose, strings, count, onDone }: SignatureExportSheetProps) {
  const { t } = useI18n();
  const copy = strings.vaultBackup;
  return (
    <Sheet open={open} onClose={onClose} title={copy.exportTitle} closeLabel={t.common.close} initialFocus="[data-backup-first]">
      <ExportBody copy={copy} count={count} onClose={onClose} onDone={onDone} />
    </Sheet>
  );
}

type ExportPhase = "form" | "building" | "ready" | "done";

function ExportBody({
  copy,
  count,
  onClose,
  onDone,
}: {
  copy: VaultBackupStrings;
  count: number;
  onClose: () => void;
  onDone?: (message: string) => void;
}) {
  const canEncrypt = useMemo(() => passwordBoxAvailable(), []);
  const coarse = useMediaQuery("(pointer: coarse)");
  const [protect, setProtect] = useState(canEncrypt);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [phase, setPhase] = useState<ExportPhase>("form");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [ready, setReady] = useState<{
    file: File;
    count: number;
    encrypted: boolean;
    sharing: boolean;
  } | null>(null);
  const aliveRef = useRef(true);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
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

  const finish = (file: File, exported: number, encrypted: boolean) => {
    const message = `${copy.done(exported, encrypted)} ${copy.doneFile(file.name)}`;
    setInfo(message);
    setError("");
    setPhase("done");
    onDone?.(copy.done(exported, encrypted));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (phase === "building") return;
    setError("");
    if (protect && canEncrypt) {
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
    const result = await buildSignaturesExport({ password: protect && canEncrypt ? password : undefined });
    if (!aliveRef.current) return;
    if (!result.ok) {
      setPhase("form");
      setError(copy[exportErrorKey(result.reason)]);
      return;
    }
    const file = toFile(result.blob, result.filename);
    // iPad / movil: la hoja de compartir pide un toque propio (Safari exige un gesto reciente y el cifrado ya tardo).
    if (coarse && canShareFile(file)) {
      setReady({ file, count: result.count, encrypted: result.encrypted, sharing: true });
      setInfo(copy.readyTitle(file.name));
      setPhase("ready");
      return;
    }
    downloadBlob(result.blob, result.filename);
    finish(file, result.count, result.encrypted);
  };

  const share = async () => {
    if (!ready) return;
    const outcome = await shareFile(ready.file);
    if (!aliveRef.current) return;
    if (outcome === "shared") {
      finish(ready.file, ready.count, ready.encrypted);
    } else if (outcome === "cancelled") {
      setError(copy.shareCancelled);
    } else {
      downloadBlob(ready.file, ready.file.name);
      finish(ready.file, ready.count, ready.encrypted);
    }
  };

  const download = () => {
    if (!ready) return;
    downloadBlob(ready.file, ready.file.name);
    finish(ready.file, ready.count, ready.encrypted);
  };

  const building = phase === "building";
  const passwordId = "backup-export-password";
  const repeatId = "backup-export-repeat";
  const wantsPassword = protect && canEncrypt;

  return (
    <div className="space-y-4 pb-2">
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">
        {copy.exportTitle}
      </h3>

      {phase === "form" || phase === "building" ? (
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <p className="text-subheadline text-muted-foreground">{copy.exportBody(count)}</p>

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
                  aria-describedby="backup-export-strength"
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError("");
                  }}
                  className={INPUT_CLASS}
                />
                <div className="mt-2 flex items-center gap-2" id="backup-export-strength">
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
                      <span
                        key={segment}
                        className={cn("h-full flex-1 rounded-full", level >= segment ? LEVEL_COLORS[level] : "bg-white/15")}
                      />
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
                  className={INPUT_CLASS}
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

          <Button type="submit" size="md" fullWidth wrap disabled={building || count === 0}>
            {copy.exportConfirm}
          </Button>
        </form>
      ) : null}

      {phase === "ready" && ready ? (
        <div className="space-y-3">
          <p className="text-subheadline text-foreground [overflow-wrap:anywhere]">{copy.readyTitle(ready.file.name)}</p>
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
          <p className="text-subheadline text-foreground [overflow-wrap:anywhere]">{info}</p>
          <Button size="md" fullWidth wrap onClick={onClose} data-backup-first>
            {copy.doneClose}
          </Button>
        </div>
      ) : null}

      {/* Region de estado UNICA. */}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-footnote",
          error ? "text-destructive-text" : building ? "text-muted-foreground" : "sr-only",
        )}
      >
        {building ? <Spinner className="size-4" /> : null}
        {building ? copy.exportWorking : error || (phase === "done" ? info : "")}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Importar
 * ------------------------------------------------------------------ */

export type SignatureRestoreSheetProps = {
  open: boolean;
  onClose: () => void;
  strings: SignStrings;
  /** Un archivo que NO es un paquete (p. ej. el de UNA firma, de antes): lo importa quien abrio la hoja. */
  onLegacyFile?: (file: File) => void;
  /** Aviso para la region de estado de quien abrio la hoja. */
  onDone?: (message: string) => void;
};

export function SignatureRestoreSheet({ open, onClose, strings, onLegacyFile, onDone }: SignatureRestoreSheetProps) {
  const { t } = useI18n();
  const copy = strings.vaultBackup;
  // Mientras se escribe la importación la hoja no se cierra (Escape, clic fuera, X): se perdería su resultado.
  const [applying, setApplying] = useState(false);
  const [blockedAttempts, setBlockedAttempts] = useState(0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={copy.importTitle}
      closeLabel={t.common.close}
      initialFocus="[data-backup-first]"
      closeLocked={applying}
      onCloseBlocked={() => setBlockedAttempts((count) => count + 1)}
    >
      <RestoreBody copy={copy} onClose={onClose} onLegacyFile={onLegacyFile} onDone={onDone} onApplyingChange={setApplying} blockedAttempts={blockedAttempts} />
    </Sheet>
  );
}

type RestorePhase = "pick" | "reading" | "password" | "preview" | "importing" | "done";

function RestoreBody({
  copy,
  onClose,
  onLegacyFile,
  onDone,
  onApplyingChange,
  blockedAttempts = 0,
}: {
  copy: VaultBackupStrings;
  onClose: () => void;
  onLegacyFile?: (file: File) => void;
  onDone?: (message: string) => void;
  onApplyingChange?: (applying: boolean) => void;
  blockedAttempts?: number;
}) {
  const [phase, setPhase] = useState<RestorePhase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, SignatureDecision>>({});
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const aliveRef = useRef(true);
  const mountedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === "password") passwordRef.current?.focus();
    else headingRef.current?.focus();
  }, [phase]);

  const open = async (target: File, pass?: string) => {
    setFile(target);
    setError("");
    setPhase("reading");
    const read = await readSignaturesBackup(target, pass);
    if (!aliveRef.current) return;
    if (read.ok) {
      setPlan(read.plan);
      setEncrypted(read.encrypted);
      setDecisions(defaultSignatureDecisions(read.plan));
      setPhase("preview");
      return;
    }
    if (read.reason === "needsPassword") {
      setPassword("");
      setPhase("password");
      return;
    }
    if (read.reason === "wrongPassword") {
      setPassword("");
      setError(copy.wrongPassword);
      setPhase("password");
      return;
    }
    if (read.code === "invalidManifest" && onLegacyFile) {
      // No es un paquete: puede ser el archivo de UNA firma (formato anterior); lo recibe quien sabe leerlo.
      onLegacyFile(target);
      onClose();
      return;
    }
    setError(copy.readErrors[read.reason]);
    setPhase("pick");
  };

  const onPicked = (picked: File | undefined) => {
    if (picked) void open(picked);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onPicked(event.dataTransfer?.files?.[0]);
  };

  const check = plan ? checkSignaturesLimits(plan, decisions) : null;

  const apply = async () => {
    if (!plan || !check || check.wanted === 0 || !check.ok) return;
    setPhase("importing");
    let outcome: Awaited<ReturnType<typeof applyBackupImport>>;
    try {
      outcome = await applyBackupImport(plan, decisions);
    } catch {
      // Un fallo no previsto no debe dejar la hoja bloqueada.
      if (!aliveRef.current) return;
      setError(copy.applyFailed.unavailable);
      setPhase("preview");
      return;
    }
    if (!aliveRef.current) return;
    if (!outcome.ok) {
      const failure = describeApplyFailure(outcome.reason);
      if (failure === "changed" && file) {
        // Otra pestaña cambio lo que se iba a reemplazar: nada se escribio; se vuelve a leer el archivo contra el baul
        // de AHORA y se muestra la vista previa nueva (con las decisiones sugeridas) junto al aviso.
        const fresh = await readSignaturesBackup(file, password === "" ? undefined : password);
        if (!aliveRef.current) return;
        if (fresh.ok) {
          setPlan(fresh.plan);
          setDecisions(defaultSignatureDecisions(fresh.plan));
        }
      }
      setError(copy.applyFailed[failure]);
      setPhase("preview");
      return;
    }
    const message = copy.result(outcome.summary.imported, outcome.summary.skipped, outcome.summary.replaced);
    setResult(message);
    setError("");
    setPhase("done");
    onDone?.(message);
  };

  useEffect(() => {
    onApplyingChange?.(phase === "importing");
    return () => onApplyingChange?.(false);
  }, [phase, onApplyingChange]);

  const working = phase === "reading" || phase === "importing";

  return (
    <div className="space-y-4 pb-2">
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">
        {phase === "preview" || phase === "importing" ? copy.previewTitle : copy.importTitle}
      </h3>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-backup-file-input
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          onPicked(picked);
        }}
      />

      {phase === "pick" || phase === "reading" ? (
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setDragging(false);
          }}
          onDrop={onDrop}
          className={cn(
            "space-y-3 rounded-ios-sm border border-dashed p-4 transition-colors",
            dragging ? "border-signal bg-signal/10" : "border-white/20 bg-white/5",
          )}
        >
          <p className="text-subheadline text-muted-foreground">{copy.importIntro}</p>
          <Button size="md" fullWidth wrap disabled={working} data-backup-first onClick={() => inputRef.current?.click()}>
            <FileUp aria-hidden="true" className="size-4" />
            {copy.pickZip}
          </Button>
          <p className="text-footnote text-muted-foreground">{dragging ? copy.dropZipActive : copy.dropZip}</p>
        </div>
      ) : null}

      {phase === "password" && file ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (password !== "") void open(file, password);
          }}
        >
          <p className="text-subheadline text-muted-foreground">{copy.passwordBody}</p>
          <div>
            <label htmlFor="backup-import-password" className="ui-label mb-1.5 block text-muted-foreground">
              {copy.passwordLabel}
            </label>
            <input
              ref={passwordRef}
              id="backup-import-password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              className={INPUT_CLASS}
            />
          </div>
          <Button type="submit" size="md" fullWidth wrap disabled={password === ""}>
            {copy.passwordOpen}
          </Button>
        </form>
      ) : null}

      {(phase === "preview" || phase === "importing") && plan && check ? (
        <div className="space-y-4">
          <p className="text-subheadline text-muted-foreground">{copy.previewIntro(plan.items.length, encrypted)}</p>
          <ul className="space-y-2">
            {plan.items.map((item) => (
              <li key={item.id}>
                <ItemCard
                  item={item}
                  copy={copy}
                  decision={decisions[item.id]}
                  disabled={phase === "importing"}
                  onDecision={(decision) => setDecisions((current) => ({ ...current, [item.id]: decision }))}
                />
              </li>
            ))}
          </ul>
          <p
            className={cn("text-footnote leading-relaxed", check.ok ? "text-muted-foreground" : "text-destructive-text")}
            data-backup-limits
          >
            {check.ok
              ? copy.limitOk(check.entriesAfter, MAX_VAULT_ENTRIES)
              : copy.limitExceeded(check.fits, check.wanted, MAX_VAULT_ENTRIES)}
          </p>
          <Button
            size="md"
            fullWidth
            wrap
            disabled={phase === "importing" || check.wanted === 0 || !check.ok}
            onClick={() => void apply()}
            data-backup-first
          >
            {check.wanted === 0 ? copy.importNothing : copy.importConfirm(check.wanted)}
          </Button>
        </div>
      ) : null}

      {phase === "done" ? (
        <div className="space-y-3">
          <p className="text-subheadline text-foreground">{result}</p>
          <Button size="md" fullWidth wrap onClick={onClose} data-backup-first>
            {copy.doneClose}
          </Button>
        </div>
      ) : null}

      {/* Region de estado UNICA. */}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 text-footnote",
          error ? "text-destructive-text" : working ? "text-muted-foreground" : "sr-only",
        )}
      >
        {working && !error ? <Spinner className="size-4" /> : null}
        {error || (phase === "reading" ? copy.reading : phase === "importing" ? (blockedAttempts > 0 ? `${copy.importing} ${copy.closeBusy}` : copy.importing) : phase === "done" ? result : "")}
      </p>
    </div>
  );
}

/** Tarjeta de un elemento de la vista previa; la reutiliza la hoja del paquete global (U4.7). */
export function ItemCard({
  item,
  copy,
  decision,
  disabled,
  onDecision,
}: {
  item: SignatureImportItem;
  copy: VaultBackupStrings;
  decision: SignatureDecision | undefined;
  disabled: boolean;
  onDecision: (decision: SignatureDecision) => void;
}) {
  const sameDrawings = item.status === "different" && item.difference === "data";
  const statusLabel =
    item.status === "new"
      ? copy.statusNew
      : item.status === "identical"
        ? copy.statusIdentical
        : item.status === "different"
          ? sameDrawings
            ? copy.statusSameDrawings
            : copy.statusDifferent
          : copy.statusInvalid;
  const options = decisionOptions(item.status, item);
  const labels: Record<SignatureDecision, string> = {
    import: copy.decisionImport,
    replace: copy.decisionReplace,
    keepBoth: copy.decisionKeepBoth,
    omit: sameDrawings ? copy.decisionKeepExisting : copy.decisionOmit,
  };
  return (
    <div className="surface-card rounded-ios-sm space-y-2 p-3" data-backup-item={item.id} data-status={item.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-callout font-semibold text-foreground [overflow-wrap:anywhere]">
          {item.signerName || "—"}
        </p>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-caption font-medium",
            item.status === "new" && "border-success/40 text-success-text",
            item.status === "different" && "border-signal/50 text-signal-text",
            item.status === "identical" && "border-white/20 text-muted-foreground",
            item.status === "invalid" && "border-destructive/40 text-destructive-text",
          )}
        >
          {statusLabel}
        </span>
      </div>
      {item.role ? <p className="text-footnote text-muted-foreground [overflow-wrap:anywhere]">{item.role}</p> : null}
      {item.status !== "invalid" ? (
        <p className="text-caption text-muted-foreground">{copy.contents(item.hasSignature, item.hasInitials)}</p>
      ) : item.reason ? (
        <p className="text-footnote text-destructive-text">{copy.invalidReasons[item.reason]}</p>
      ) : null}
      {item.status === "different" && item.conflictWith ? (
        <p className="text-footnote text-muted-foreground" data-backup-hint>
          {item.canReplace === false
            ? copy.otherPersonHint(item.conflictWith.signerName)
            : sameDrawings
              ? copy.sameDrawingsHint(item.conflictWith.signerName, item.differs ?? ["name"])
              : copy.differentHint(item.conflictWith.signerName)}
        </p>
      ) : null}
      {options.length > 0 ? (
        <div role="radiogroup" aria-label={copy.decisionGroup(item.signerName)} className="flex flex-wrap gap-1.5">
          {options.map((option) => {
            const active = decision === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                data-decision={option}
                onClick={() => onDecision(option)}
                className={cn(
                  "min-h-11 flex-1 rounded-ios-sm border px-3 py-2 text-center text-footnote leading-tight font-medium whitespace-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50 forced-colors:border-[ButtonText]",
                  active
                    ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-2 forced-colors:border-[Highlight]"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:text-foreground",
                )}
              >
                {labels[option]}
              </button>
            );
          })}
        </div>
      ) : null}
      {item.status === "different" && decision === "replace" && sameDrawings ? (
        <p className="text-footnote text-muted-foreground">{copy.replaceKeeps}</p>
      ) : item.status === "different" && decision === "replace" && item.supersedes === false ? (
        <p className="text-footnote text-muted-foreground">{copy.replaceLoses}</p>
      ) : null}
    </div>
  );
}
