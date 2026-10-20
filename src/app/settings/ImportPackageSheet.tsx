"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FileUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import {
  applyEverything,
  checkEverythingLimits,
  defaultEverythingDecisions,
  readAndPlanEverything,
  type ApplyEverythingResult,
  type EverythingDecisions,
  type EverythingPlans,
  type ModuleSummary,
  type PackageModuleName,
} from "@/lib/backup/globalPackage";
import { BACKUP_INPUT_CLASS } from "@/app/documents/ExportBackupSheet";
import { ItemCard as LibraryItemCard, LibraryLimitLine } from "@/app/documents/ImportBackupSheet";
import { ItemCard as SignatureItemCard } from "@/app/sign-pdf/SignatureBackupSheet";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { MAX_VAULT_ENTRIES } from "@/app/sign-pdf/signVault";
import { countText, fillText } from "@/app/documents/backupModel";
import { reloadPage } from "@/app/settings/pageReload";
import { DraftItemCard, SettingsCards } from "@/app/settings/PackageItemCards";
import { countsLine, outcomeLines, packageParts, type OutcomeLine } from "@/app/settings/packageModel";

/**
 * «Importar paquete» (U4.7): elegir/soltar el `.zip` → contraseña si hace falta → hoja de VISTA PREVIA por módulo (Firmas,
 * Plantillas y documentos, Borradores, Ajustes) con el estado de cada elemento (Nuevo / Ya lo tienes / Distinto / No se
 * puede importar) y su decisión; las tarjetas de firmas y de documentos son las de sus propias hojas. Límites comprobados
 * ANTES, progreso, y resultado POR MÓDULO: uno que falla no deshace los que ya se aplicaron bien y se dice con claridad.
 * Si se aplicaron ajustes, avisa «Recarga para aplicar los ajustes» con su botón. Leer y revisar no escribe nada. Toda la
 * lógica vive en `lib/backup/globalPackage.ts`. Un paquete de un solo módulo (el de firmas, el de documentos…) entra por aquí.
 */

type Phase = "pick" | "reading" | "password" | "preview" | "importing" | "done";

export function ImportPackageSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: (message: string) => void }) {
  const { t } = useI18n();
  // Mientras se está aplicando la importación la hoja NO se cierra (Escape, clic fuera, X o arrastre): cerrarla a medias
  // perdía el resultado y dejaba la interfaz inconsistente. Cada intento se dice en la región de estado.
  const [applying, setApplying] = useState(false);
  const [blockedAttempts, setBlockedAttempts] = useState(0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t.settings.backup.importTitle}
      closeLabel={t.common.close}
      initialFocus="[data-backup-first]"
      closeLocked={applying}
      onCloseBlocked={() => setBlockedAttempts((count) => count + 1)}
    >
      <ImportBody onClose={onClose} onDone={onDone} onApplyingChange={setApplying} blockedAttempts={blockedAttempts} />
    </Sheet>
  );
}

function ImportBody({
  onClose,
  onDone,
  onApplyingChange,
  blockedAttempts,
}: {
  onClose: () => void;
  onDone?: (message: string) => void;
  onApplyingChange?: (applying: boolean) => void;
  blockedAttempts: number;
}) {
  const { t, language } = useI18n();
  const copy = t.settings.backup;
  const locale = localeTag(language);
  const signCopy = SIGN_STRINGS[language].vaultBackup;
  const [phase, setPhase] = useState<Phase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [plans, setPlans] = useState<EverythingPlans | null>(null);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [encrypted, setEncrypted] = useState(false);
  const [decisions, setDecisions] = useState<EverythingDecisions | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [working, setWorking] = useState<PackageModuleName | null>(null);
  const [result, setResult] = useState<{ outcome: ApplyEverythingResult; lines: OutcomeLine[] } | null>(null);
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
  useEffect(() => {
    onApplyingChange?.(phase === "importing");
    return () => onApplyingChange?.(false);
  }, [phase, onApplyingChange]);

  const openFile = async (target: File, pass?: string) => {
    setFile(target);
    setError("");
    setProgress(null);
    setPhase("reading");
    const read = await readAndPlanEverything(target, pass, {
      onProgress: (done, total) => {
        if (aliveRef.current) setProgress({ done, total });
      },
    });
    if (!aliveRef.current) return;
    setProgress(null);
    if (read.ok) {
      setPlans(read.plans);
      setModules(read.modules);
      setEncrypted(read.encrypted);
      setDecisions(defaultEverythingDecisions(read.plans));
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
    setError(copy.readErrors[read.reason]);
    setPhase("pick");
  };

  const onPicked = (picked: File | undefined) => {
    if (picked) void openFile(picked);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onPicked(event.dataTransfer?.files?.[0]);
  };

  const limits = useMemo(() => (plans && decisions ? checkEverythingLimits(plans, decisions) : null), [plans, decisions]);

  const apply = async () => {
    if (!plans || !decisions || !limits || limits.wanted === 0 || !limits.ok) return;
    setPhase("importing");
    setError("");
    let outcome: Awaited<ReturnType<typeof applyEverything>>;
    try {
      outcome = await applyEverything(plans, decisions, {
        onModule: (module) => {
          if (aliveRef.current) setWorking(module);
        },
      });
    } catch {
      // Un fallo no previsto no debe dejar la hoja bloqueada: se vuelve a la vista previa con un aviso.
      if (!aliveRef.current) return;
      setWorking(null);
      setError(copy.moduleStates.unavailable);
      setPhase("preview");
      return;
    }
    if (!aliveRef.current) return;
    setWorking(null);
    setResult({ outcome, lines: outcomeLines(outcome.outcomes, copy) });
    setPhase("done");
    onDone?.(copy.announceImported);
  };

  const busy = phase === "reading" || phase === "importing";
  const statusText = error
    ? error
    : phase === "reading"
      ? progress
        ? fillText(copy.checkingPdf, { done: progress.done, total: progress.total })
        : copy.reading
      : phase === "importing"
        ? [working ? fillText(copy.importingModule, { module: copy.moduleNames[working] }) : copy.importing, blockedAttempts > 0 ? copy.closeBusy : ""].filter(Boolean).join(" ")
        : phase === "done"
          ? (result?.lines.map((line) => line.text).join(" ") ?? "")
          : "";

  const totals = plans ? previewTotals(plans) : null;
  const parts = totals ? packageParts(modules, copy, totals) : [];

  return (
    <div className="space-y-4 pb-2" data-backup-import="">
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
          className={cn("space-y-3 rounded-ios-sm border border-dashed p-4 transition-colors", dragging ? "border-signal bg-signal/10" : "border-white/20 bg-white/5")}
        >
          <p className="text-subheadline text-muted-foreground">{copy.importIntro}</p>
          <Button size="md" fullWidth wrap disabled={busy} data-backup-first onClick={() => inputRef.current?.click()}>
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
            if (password !== "") void openFile(file, password);
          }}
        >
          <p className="text-subheadline text-muted-foreground">{copy.passwordBody}</p>
          <div>
            <label htmlFor="pkg-import-password" className="ui-label mb-1.5 block text-muted-foreground">
              {copy.passwordLabel}
            </label>
            <input
              ref={passwordRef}
              id="pkg-import-password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              className={BACKUP_INPUT_CLASS}
            />
          </div>
          <Button type="submit" size="md" fullWidth wrap disabled={password === ""}>
            {copy.passwordOpen}
          </Button>
        </form>
      ) : null}

      {(phase === "preview" || phase === "importing") && plans && decisions && limits ? (
        <div className="space-y-5">
          <p className="text-subheadline text-muted-foreground" data-backup-preview-intro="">
            {fillText(copy.previewIntro, { parts: parts.length > 0 ? parts.join(", ") : copy.previewNothing, enc: encrypted ? copy.previewEncrypted : "" })}
          </p>

          {modules.map((summary) => {
            const headingId = `pkg-module-${summary.module}`;
            return (
              <section key={summary.module} aria-labelledby={headingId} className="space-y-2" data-backup-module={summary.module} data-state={summary.state}>
                <div>
                  <h4 id={headingId} className="text-headline text-foreground">
                    {copy.moduleNames[summary.module]}
                  </h4>
                  {summary.importable ? (
                    <p className="text-caption text-muted-foreground">{countsLine(summary.counts, copy)}</p>
                  ) : (
                    <p className="text-footnote text-destructive-text">
                      {summary.state === "newerVersion" || summary.state === "damaged" || summary.state === "unavailable"
                        ? copy.moduleStates[summary.state]
                        : ""}
                    </p>
                  )}
                </div>

                {summary.module === "signatures" && plans.signatures && summary.importable ? (
                  <>
                    <ul className="space-y-2">
                      {plans.signatures.items.map((item) => (
                        <li key={item.id}>
                          <SignatureItemCard
                            item={item}
                            copy={signCopy}
                            decision={decisions.signatures[item.id]}
                            disabled={phase === "importing"}
                            onDecision={(decision) => setDecisions((current) => current && { ...current, signatures: { ...current.signatures, [item.id]: decision } })}
                          />
                        </li>
                      ))}
                    </ul>
                    {limits.signatures ? (
                      <p className={cn("text-footnote leading-relaxed", limits.signatures.ok ? "text-muted-foreground" : "text-destructive-text")} data-backup-limits="signatures">
                        {limits.signatures.ok
                          ? signCopy.limitOk(limits.signatures.entriesAfter, MAX_VAULT_ENTRIES)
                          : signCopy.limitExceeded(limits.signatures.fits, limits.signatures.wanted, MAX_VAULT_ENTRIES)}
                      </p>
                    ) : null}
                  </>
                ) : null}

                {summary.module === "library" && plans.library && summary.importable ? (
                  <>
                    <ul className="space-y-2">
                      {plans.library.items.map((item) => (
                        <li key={item.key}>
                          <LibraryItemCard
                            item={item}
                            locale={locale}
                            decision={decisions.library[item.key]}
                            disabled={phase === "importing"}
                            onDecision={(decision) => setDecisions((current) => current && { ...current, library: { ...current.library, [item.key]: decision } })}
                          />
                        </li>
                      ))}
                    </ul>
                    {limits.library ? <LibraryLimitLine plan={plans.library} check={limits.library} locale={locale} /> : null}
                  </>
                ) : null}

                {summary.module === "drafts" && plans.drafts && summary.importable ? (
                  <>
                    <ul className="space-y-2">
                      {plans.drafts.items.map((item) => (
                        <li key={item.key}>
                          <DraftItemCard
                            item={item}
                            locale={locale}
                            decision={decisions.drafts[item.key]}
                            disabled={phase === "importing"}
                            onDecision={(decision) => setDecisions((current) => current && { ...current, drafts: { ...current.drafts, [item.key]: decision } })}
                          />
                        </li>
                      ))}
                    </ul>
                    {limits.drafts ? (
                      <p className={cn("text-footnote leading-relaxed", limits.drafts.ok ? "text-muted-foreground" : "text-destructive-text")} data-backup-limits="drafts">
                        {limits.drafts.ok ? copy.limitDrafts : fillText(copy.limitDraftsExceeded, { max: limits.drafts.sign.maxCount })}
                      </p>
                    ) : null}
                  </>
                ) : null}

                {summary.module === "settings" && plans.settings && summary.importable ? (
                  <SettingsCards
                    plan={plans.settings}
                    decisions={decisions.settings}
                    historyDecision={decisions.settings.valueHistory}
                    disabled={phase === "importing"}
                    onSettings={(next) => setDecisions((current) => current && { ...current, settings: { ...next, valueHistory: current.settings.valueHistory } })}
                    onHistory={(decision) => setDecisions((current) => current && { ...current, settings: { ...current.settings, valueHistory: decision } })}
                  />
                ) : null}
              </section>
            );
          })}

          {!limits.ok ? (
            <p className="text-footnote leading-relaxed text-destructive-text" data-backup-blocked="">
              {fillText(copy.limitBlocked, { names: limits.blocked.map((name) => copy.moduleNames[name]).join(", ") })}
            </p>
          ) : null}
          <Button size="md" fullWidth wrap disabled={phase === "importing" || limits.wanted === 0 || !limits.ok} onClick={() => void apply()} data-backup-first data-backup-confirm="">
            {limits.wanted === 0 ? copy.importNothing : countText(limits.wanted, copy.importConfirmOne, copy.importConfirmMany)}
          </Button>
        </div>
      ) : null}

      {phase === "done" && result ? (
        <div className="space-y-3">
          <ul className="space-y-1" data-backup-result="">
            {result.lines.map((line) => (
              <li key={line.text} data-tone={line.tone} className={cn("text-subheadline [overflow-wrap:anywhere]", line.tone === "error" ? "text-destructive-text" : "text-foreground")}>
                {line.text}
              </li>
            ))}
          </ul>
          {result.outcome.reloadRequired ? (
            <div className="surface-card rounded-ios-sm space-y-2 p-3" data-backup-reload="">
              <p className="text-subheadline text-foreground">{copy.reloadNotice}</p>
              <Button size="md" fullWidth wrap data-backup-first onClick={reloadPage}>
                <RefreshCw aria-hidden="true" className="size-4" />
                {copy.reloadButton}
              </Button>
            </div>
          ) : null}
          <Button variant={result.outcome.reloadRequired ? "secondary" : "primary"} size="md" fullWidth wrap onClick={onClose} data-backup-first={result.outcome.reloadRequired ? undefined : ""}>
            {copy.doneClose}
          </Button>
        </div>
      ) : null}

      {/* Región de estado ÚNICA. */}
      <p role="status" aria-live="polite" className={cn("flex items-center gap-2 text-footnote", error ? "text-destructive-text" : busy ? "text-muted-foreground" : "sr-only")}>
        {busy && !error ? <Spinner className="size-4" /> : null}
        {statusText}
      </p>
    </div>
  );
}

/** Lo que trae cada módulo importable (sin los inválidos), para «El paquete trae: …». */
function previewTotals(plans: EverythingPlans): { signatures: number; documents: number; templates: number; drafts: number; settings: number } {
  const signatures = plans.signatures?.state === "ok" ? plans.signatures.items.filter((item) => item.status !== "invalid").length : 0;
  let documents = 0;
  let templates = 0;
  if (plans.library?.state === "ok") {
    for (const item of plans.library.items) {
      if (item.status === "invalid") continue;
      if (item.kind === "document" && item.duplicateOf === undefined) documents += 1;
      templates += item.templates.filter((row) => row.status !== "invalid").length;
    }
  }
  const drafts = plans.drafts?.state === "ok" ? plans.drafts.items.filter((item) => item.status !== "invalid").length : 0;
  const settings = plans.settings?.state === "ok" ? plans.settings.items.filter((item) => item.status !== "invalid").length : 0;
  return { signatures, documents, templates, drafts, settings };
}
