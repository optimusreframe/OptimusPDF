"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import type { InkColorChoice, PreparedInk } from "@/app/sign-pdf/inkImportModel";
import { inkErrorKey, isAbortError, vaultImageFromPng, vaultIsFull } from "@/app/sign-pdf/inkImportModel";
import { readPngSize, type VaultEntry } from "@/app/sign-pdf/signVault";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";
import { RadioChips } from "@/app/extract-assets/RadioChips";
import { fill, type ExtractStrings } from "@/app/extract-assets/model";
import { entryHas, executeSave, hasConflict, planSave, type ConflictChoice, type ExecuteResult, type SaveErrorReason, type VaultKind } from "@/app/extract-assets/saveModel";
import { toolHref } from "@/lib/tools-registry";
import { CHECKER_STYLE, INPUT_CLASS, useBlobUrl } from "@/app/extract-assets/ui";

export type SaveSignatureSheetProps = {
  open: boolean;
  /** Cambia con cada elemento nuevo: la hoja se monta de cero (nombre, tinta, vista previa). */
  instanceKey: string | number;
  onClose: () => void;
  strings: ExtractStrings;
  closeLabel: string;
  /** Nombre del PDF de origen: va SOLO al campo `sourceDocument` de la entrada. */
  sourceDocument: string;
  /** Pixeles del elemento (PNG/JPG/SVG ya renderizado). `null` mientras no hay elemento. */
  load: (() => Promise<Blob>) | null;
  /** Lo que sale de «Recortar región» ya viene limpio (transparente): no se vuelve a procesar. */
  preCleaned: boolean;
  /** El elemento ya trae transparencia (no se «iguala la iluminacion» de un papel que no hay). */
  hasAlpha: boolean;
  defaultKind: VaultKind;
  /** Texto de exito para la region viva de la pagina. */
  onSaved: (message: string) => void;
  /** «Recortar otra»: la hoja se cierra y quien la abrio vuelve a lo suyo (otro recorte). */
  onCropAnother: () => void;
};

type Prep =
  | { status: "loading" }
  | { status: "ready"; ink: PreparedInk; blob: Blob }
  | { status: "error"; message: string };

/**
 * «Guardar en Firmas guardadas» (F7 · U7.4): hoja con nombre, cargo y tipo (firma / iniciales). Limpia el fondo con
 * `inkExtract` (salvo lo ya limpio de «Recortar región»), muestra la vista previa sobre damero y guarda con
 * `saveVaultEntry` y `origin: "extracted"`. Todo local: la imagen no sale del dispositivo.
 */
export function SaveSignatureSheet(props: SaveSignatureSheetProps) {
  const { open, onClose, strings, closeLabel } = props;
  return (
    <Sheet open={open} onClose={onClose} title={strings.saveTitle} closeLabel={closeLabel} inertBackground initialFocus="[data-extract-save-name]">
      {open && props.load ? <SaveBody key={props.instanceKey} {...props} load={props.load} /> : null}
    </Sheet>
  );
}

function SaveBody({
  strings,
  sourceDocument,
  load,
  preCleaned,
  hasAlpha,
  defaultKind,
  onSaved,
  onCropAnother,
  onClose,
}: Omit<SaveSignatureSheetProps, "load"> & { load: () => Promise<Blob> }) {
  const { status: vaultStatus, entries } = useSignatureVault(true);
  const [prep, setPrep] = useState<Prep>({ status: "loading" });
  const [inkChoice, setInkChoice] = useState<InkColorChoice>("original");
  const [kind, setKind] = useState<VaultKind>(defaultKind);
  const [signer, setSigner] = useState<string>("new");
  const [conflict, setConflict] = useState<ConflictChoice>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [fieldError, setFieldError] = useState<SaveErrorReason | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  /** El elemento sin limpiar, leido UNA vez: cambiar el color de la tinta solo repite la limpieza. */
  const sourceRef = useRef<{ blob: Blob; decoded: Awaited<ReturnType<(typeof import("@/lib/image/inkExtract"))["decodeImageFile"]>> | null } | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const failure = (error: unknown): void => {
      if (controller.signal.aborted || isAbortError(error)) return;
      const key = inkErrorKey(error);
      const message =
        key === "noInk" ? strings.saveNoInk : key === "tooDark" ? strings.saveTooDark : key === "encode" || key === "tooManyPixels" ? strings.saveTooLarge : strings.saveDecode;
      setPrep({ status: "error", message });
    };
    void (async () => {
      try {
        const ink = await import("@/lib/image/inkExtract");
        if (!sourceRef.current) {
          const blob = await load();
          sourceRef.current = { blob, decoded: preCleaned ? null : await ink.decodeImageFile(blob) };
        }
        if (controller.signal.aborted) return;
        const source = sourceRef.current;
        if (preCleaned || !source.decoded) {
          const bytes = new Uint8Array(await source.blob.arrayBuffer());
          const size = readPngSize(bytes);
          if (!size) throw new Error("png");
          if (!controller.signal.aborted) setPrep({ status: "ready", ink: { png: bytes, width: size.width, height: size.height }, blob: source.blob });
          return;
        }
        const result = await ink.extractInkAsync(
          source.decoded,
          { ink: inkChoice, evenLighting: !hasAlpha, crop: "auto", margin: "auto" },
          { signal: controller.signal },
        );
        const encoded = await ink.encodeInkPng(result.image);
        if (controller.signal.aborted) return;
        setPrep({
          status: "ready",
          ink: { png: encoded.bytes, width: encoded.width, height: encoded.height },
          blob: new Blob([encoded.bytes as unknown as BlobPart], { type: "image/png" }),
        });
      } catch (error) {
        failure(error);
      }
    })();
    return () => controller.abort();
  }, [load, preCleaned, hasAlpha, inkChoice, strings.saveNoInk, strings.saveTooDark, strings.saveTooLarge, strings.saveDecode]);

  const previewBlob = prep.status === "ready" ? prep.blob : null;
  const previewUrl = useBlobUrl(previewBlob);
  const full = vaultIsFull(entries.length);
  const tooBig = prep.status === "ready" && vaultImageFromPng(prep.ink.png) === null;
  const existing: VaultEntry | undefined = signer === "new" ? undefined : entries.find((entry) => entry.id === signer);
  const conflicting = hasConflict(existing, kind);
  const showName = signer === "new" || (conflicting && conflict === "other");
  const kindWord = kind === "signature" ? strings.saveKindSignature.toLowerCase() : strings.saveKindInitials.toLowerCase();

  const chooseKind = (next: VaultKind): void => {
    setKind(next);
    setConflict(null);
    setFieldError(null);
  };
  const chooseSigner = (next: string): void => {
    setSigner(next);
    setConflict(null);
    setFieldError(null);
  };

  const errorText = (reason: SaveErrorReason): string => {
    switch (reason) {
      case "nameNeeded":
        return strings.saveNameNeeded;
      case "nameTaken":
        return strings.saveNameTaken;
      case "conflictNeeded":
        return strings.saveConflictNeeded;
      default:
        return strings.saveInvalid;
    }
  };

  const messageForSave = (result: Extract<ExecuteResult, { ok: false }>): string => {
    switch (result.reason) {
      case "limit":
        return strings.saveLimit;
      case "tooLarge":
        return strings.saveTooLarge;
      case "invalid":
        return strings.saveInvalid;
      case "changed":
        return strings.saveChanged;
      default:
        return strings.saveUnavailable;
    }
  };

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (saving || prep.status !== "ready" || vaultStatus === "loading") return;
    setSaveError(null);
    setFieldError(null);
    const plan = planSave({
      entries,
      choice: signer === "new" ? { kind: "new" } : { kind: "existing", id: signer },
      kind,
      conflict,
      name,
      role,
      ink: prep.ink,
      sourceDocument,
    });
    if (plan.action === "error") {
      if (plan.reason === "invalid" || plan.reason === "notFound") setSaveError(tooBig ? strings.saveTooLarge : strings.saveInvalid);
      else {
        setFieldError(plan.reason);
        if (plan.reason !== "conflictNeeded") nameRef.current?.focus();
      }
      return;
    }
    setSaving(true);
    const result = await executeSave(plan);
    if (!aliveRef.current) return;
    setSaving(false);
    if (!result.ok) {
      setSaveError(messageForSave(result));
      return;
    }
    const message =
      result.kind === "duplicate"
        ? fill(strings.savedDuplicate, { name: result.entryName })
        : result.kind === "completed"
          ? fill(kind === "signature" ? strings.savedCompletedSignature : strings.savedCompletedInitials, { name: result.entryName })
          : result.kind === "replaced"
            ? fill(kind === "signature" ? strings.savedReplacedSignature : strings.savedReplacedInitials, { name: result.entryName })
            : fill(strings.saved, { name: result.entryName });
    onSaved(message);
    setDone({ message });
  };

  const kindOptions = useMemo(
    () => [
      { value: "signature" as const, label: strings.saveKindSignature },
      { value: "initials" as const, label: strings.saveKindInitials },
    ],
    [strings.saveKindSignature, strings.saveKindInitials],
  );
  const inkOptions = useMemo(
    () => [
      { value: "original" as const, label: strings.saveInkOriginal },
      { value: "black" as const, label: strings.saveInkBlack },
      { value: "blue" as const, label: strings.saveInkBlue },
    ],
    [strings.saveInkOriginal, strings.saveInkBlack, strings.saveInkBlue],
  );
  const conflictOptions = useMemo(
    () => [
      { value: "replace" as const, label: strings.saveConflictReplace },
      { value: "other" as const, label: strings.saveConflictOther },
    ],
    [strings.saveConflictReplace, strings.saveConflictOther],
  );

  if (done) {
    return (
      <div className="space-y-4 pb-2" data-extract-save-done>
        <p role="status" aria-live="polite" className="flex items-start gap-2 text-subheadline text-foreground">
          <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success-text" />
          <span>{done.message}</span>
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            {strings.saveClose}
          </Button>
          <Button type="button" variant="secondary" onClick={onCropAnother} data-extract-crop-another autoFocus>
            {strings.saveCropAnother}
          </Button>
          <Link href={toolHref("sign-pdf")} className={buttonClasses("primary", "md")} data-extract-view-vault>
            {strings.saveViewVault}
          </Link>
        </div>
      </div>
    );
  }

  const status =
    saveError ?? (prep.status === "error" ? prep.message : prep.status === "loading" ? strings.savePreparing : saving ? strings.saveSaving : strings.saveReady);
  const isError = saveError !== null || prep.status === "error";
  // Hasta tener la lista del baul no se guarda: si no, un nombre repetido pasaria la comprobacion de «ya existe».
  const canSave = prep.status === "ready" && vaultStatus !== "loading" && !saving && !tooBig;

  return (
    <form className="space-y-4 pb-2" onSubmit={(event) => void submit(event)} noValidate data-extract-save>
      <p role="status" aria-live="polite" className={cn("flex items-center gap-2 text-footnote", isError ? "text-destructive-text" : prep.status === "ready" ? "sr-only" : "text-muted-foreground")}>
        {!isError && (prep.status === "loading" || saving) ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
        {status}
      </p>
      <p className="text-subheadline text-muted-foreground">{strings.saveIntro}</p>

      <div>
        <h3 className="ui-label mb-2 text-muted-foreground">{strings.savePreviewTitle}</h3>
        <div className="flex min-h-32 items-center justify-center rounded-ios-sm p-3" style={CHECKER_STYLE}>
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt={strings.savePreviewAlt} className="max-h-48 max-w-full object-contain" data-extract-save-preview />
          ) : prep.status === "loading" ? (
            <Loader2 aria-hidden="true" className="size-6 animate-spin text-neutral-600" />
          ) : null}
        </div>
      </div>

      <RadioChips legend={strings.saveKindLabel} name="extract-save-kind" value={kind} options={kindOptions} onChange={chooseKind} />
      {!preCleaned ? (
        <RadioChips legend={strings.saveInkLabel} name="extract-save-ink" value={inkChoice} options={inkOptions} onChange={setInkChoice} />
      ) : null}

      <fieldset className="min-w-0" data-extract-signers>
        <legend className="ui-label mb-2 text-muted-foreground">{strings.saveSignerLabel}</legend>
        {vaultStatus === "unavailable" ? <p className="mb-2 text-footnote text-muted-foreground">{strings.saveUnavailable}</p> : null}
        <div className="space-y-2">
          {entries.map((entry) => (
            <SignerOption
              key={entry.id}
              value={entry.id}
              checked={signer === entry.id}
              onSelect={chooseSigner}
              title={entry.role ? `${entry.signerName} · ${entry.role}` : entry.signerName}
              detail={[entryHas(entry, "signature") ? strings.saveKindSignature : "", entryHas(entry, "initials") ? strings.saveKindInitials : ""].filter(Boolean).join(" · ")}
            />
          ))}
          <SignerOption value="new" checked={signer === "new"} onSelect={chooseSigner} title={strings.saveSignerNew} detail="" />
        </div>
      </fieldset>

      {existing && conflicting ? (
        <div className="space-y-2 rounded-ios-sm border border-hairline-strong p-3" data-extract-conflict>
          <RadioChips
            legend={fill(strings.saveConflictLegend, { name: existing.signerName, kind: kindWord })}
            name="extract-save-conflict"
            value={conflict ?? ("" as "replace")}
            options={conflictOptions}
            onChange={(next) => {
              setConflict(next);
              setFieldError(null);
            }}
          />
          {fieldError === "conflictNeeded" ? <p className="text-footnote text-destructive-text">{strings.saveConflictNeeded}</p> : null}
        </div>
      ) : null}

      {showName ? (
        <>
          <div>
            <label htmlFor="extract-save-name" className="ui-label mb-2 block text-muted-foreground">
              {strings.saveNameLabel}
            </label>
            <input
              id="extract-save-name"
              ref={nameRef}
              data-extract-save-name
              type="text"
              value={name}
              maxLength={200}
              autoComplete="off"
              aria-invalid={fieldError === "nameNeeded" || fieldError === "nameTaken"}
              aria-describedby={fieldError === "nameNeeded" || fieldError === "nameTaken" ? "extract-save-name-error" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setFieldError(null);
              }}
              className={INPUT_CLASS}
            />
            {fieldError === "nameNeeded" || fieldError === "nameTaken" ? (
              <p id="extract-save-name-error" className="mt-1 text-footnote text-destructive-text">
                {errorText(fieldError)}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="extract-save-role" className="ui-label mb-2 block text-muted-foreground">
              {strings.saveRoleLabel}
            </label>
            <input id="extract-save-role" type="text" value={role} maxLength={200} autoComplete="off" onChange={(event) => setRole(event.target.value)} className={INPUT_CLASS} />
          </div>
        </>
      ) : null}

      {sourceDocument ? <p className="text-footnote text-muted-foreground">{fill(strings.saveSource, { name: sourceDocument })}</p> : null}
      {full && signer === "new" ? <p className="text-footnote text-muted-foreground">{strings.saveVaultFull}</p> : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>
          {strings.saveCancel}
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave} data-extract-save-submit>
          {strings.saveSubmit}
        </Button>
      </div>
    </form>
  );
}

function SignerOption({
  value,
  checked,
  onSelect,
  title,
  detail,
}: {
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-11 cursor-pointer items-center gap-3 rounded-ios-sm border px-3 py-2",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal",
        checked ? "border-signal bg-signal/10" : "border-hairline-strong",
      )}
    >
      <input
        type="radio"
        name="extract-save-signer"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
        data-signer-option={value}
      />
      <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border-2", checked ? "border-signal" : "border-hairline-strong")}>
        {checked ? <span className="size-2.5 rounded-full bg-signal" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-subheadline font-semibold break-words text-foreground">{title}</span>
        {detail ? <span className="block text-footnote text-muted-foreground">{detail}</span> : null}
      </span>
    </label>
  );
}
