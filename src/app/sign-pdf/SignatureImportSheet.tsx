"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { Camera, Crop, ImageUp, Trash2 } from "lucide-react";
import { ChoiceGroup } from "@/components/tool/OptionControls";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/Spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { DecodedInkImage } from "@/lib/image/inkDecode";
import type { ExtractResult } from "@/lib/image/inkCore";
import { InkCropper } from "@/app/sign-pdf/InkCropper";
import {
  VIEW_MAX_SIDE,
  loadInkEngine,
  paintImage,
  sniffFile,
  viewCopy,
} from "@/app/sign-pdf/inkImportEngine";
import {
  CLEAN_MAX,
  CLEAN_MIN,
  DEFAULT_INK_SETTINGS,
  buildUploadEntry,
  cleaningFromThreshold,
  initialManualCrop,
  inkErrorKey,
  isAbortError,
  missingKind,
  settingsKey,
  settingsToInkOptions,
  thresholdFromCleaning,
  vaultImageFromPng,
  vaultIsFull,
  type CropFraction,
  type InkColorChoice,
  type InkSettings,
  type PreparedInk,
} from "@/app/sign-pdf/inkImportModel";
import { saveVaultEntry, vaultImageToDataUrl, type SaveVaultResult } from "@/app/sign-pdf/signVault";
import type { InkImportStrings, SignStrings } from "@/app/sign-pdf/strings";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";

/**
 * «Subir firma o iniciales» (F6 · U6.2): elegir (o fotografiar, arrastrar, pegar) una imagen, recortarla, limpiar el
 * fondo con `inkExtract` y guardarla en «Firmas guardadas» con `origin: "uploaded"`; o, desde el compositor, devolver
 * el PNG limpio como borrador. La imagen ORIGINAL vive solo en memoria mientras la hoja esta abierta: lo unico que sale
 * de aqui es el PNG de tinta resultante, y nunca va a ninguna red.
 */

const ACCEPT =
  "image/png,image/jpeg,image/webp,image/svg+xml,image/heic,image/heif,.png,.jpg,.jpeg,.webp,.svg,.heic,.heif";

const INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

const CHECKER_STYLE = {
  backgroundColor: "#ffffff",
  backgroundImage:
    "linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%), linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
} as const;

type Step = "pick" | "adjust" | "summary";
type Kind = "signature" | "initials";

export type DraftResult = { dataUrl: string; ratio: number };

export type SignatureImportTarget =
  | { kind: "vault" }
  | { kind: "draft"; variant: Kind; onUse: (draft: DraftResult) => void };

export type SignatureImportSheetProps = {
  open: boolean;
  onClose: () => void;
  strings: SignStrings;
  target: SignatureImportTarget;
  /** Nombre ya conocido del firmante (precarga el campo). */
  preferSignerName?: string;
  /** Texto de exito para la region de estado de quien abrio la hoja (solo al guardar en «Firmas guardadas»). */
  onSaved?: (message: string) => void;
};

export function SignatureImportSheet({
  open,
  onClose,
  strings,
  target,
  preferSignerName,
  onSaved,
}: SignatureImportSheetProps) {
  const { t } = useI18n();
  const copy = strings.inkImport;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={target.kind === "draft" ? copy.composeTitle : copy.title}
      closeLabel={t.common.close}
      initialFocus="[data-ink-pick]"
    >
      <ImportBody
        copy={copy}
        target={target}
        onClose={onClose}
        preferSignerName={preferSignerName}
        onSaved={onSaved}
      />
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Cuerpo (se monta de cero cada vez que se abre la hoja)
 * ------------------------------------------------------------------ */

type Source = {
  id: number;
  decoded: DecodedInkImage;
  view: DecodedInkImage | { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
  format: string | null;
};

type Preview = {
  key: string;
  view: { width: number; height: number; data: Uint8ClampedArray | Uint8Array };
  threshold: number;
  inkBounds: ExtractResult["inkBounds"];
};

function ImportBody({
  copy,
  target,
  onClose,
  preferSignerName,
  onSaved,
}: {
  copy: InkImportStrings;
  target: SignatureImportTarget;
  onClose: () => void;
  preferSignerName?: string;
  onSaved?: (message: string) => void;
}) {
  const isDraft = target.kind === "draft";
  const coarse = useMediaQuery("(pointer: coarse)");
  const { entries } = useSignatureVault(!isDraft);

  const [step, setStep] = useState<Step>("pick");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [settings, setSettings] = useState<InkSettings>(DEFAULT_INK_SETTINGS);
  const [cropOpen, setCropOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{ key: string; message: string } | null>(null);
  const [kind, setKind] = useState<Kind>(isDraft ? target.variant : "signature");
  const [accepting, setAccepting] = useState(false);
  const [prepared, setPrepared] = useState<{ signature: PreparedInk | null; initials: PreparedInk | null }>({
    signature: null,
    initials: null,
  });
  const [name, setName] = useState(preferSignerName?.trim() ?? "");
  const [role, setRole] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const checkerRef = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLCanvasElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const sourceIdRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  /** Resultado COMPLETO (a resolucion de salida) de la ultima vista previa: se reutiliza al aceptar. */
  const fullRef = useRef<{ key: string; result: ExtractResult } | null>(null);
  const settingsRef = useRef(settings);
  const aliveRef = useRef(true);
  const firstStepRef = useRef(true);

  useEffect(() => {
    settingsRef.current = settings;
  });
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      loadControllerRef.current?.abort();
      // Nada de la imagen original queda referenciado al cerrar la hoja.
      fullRef.current = null;
    };
  }, []);

  const currentKey = source ? `${source.id}|${settingsKey(settings)}` : "";
  const previewFresh = preview !== null && preview.key === currentKey;
  const failure = previewFailure && previewFailure.key === currentKey ? previewFailure.message : null;
  const previewing = step === "adjust" && source !== null && !previewFresh && failure === null;

  /* ---- Cargar un archivo ---------------------------------------------------------------------------------- */

  const loadFile = async (file: File) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setReading(true);
    setPickError(null);
    let format: string | null = null;
    try {
      format = await sniffFile(file);
      const engine = await loadInkEngine();
      const decoded = await engine.decodeImageFile(file);
      if (controller.signal.aborted || !aliveRef.current) return;
      const view = await viewCopy(decoded, VIEW_MAX_SIDE, controller.signal);
      if (controller.signal.aborted || !aliveRef.current) return;
      sourceIdRef.current += 1;
      fullRef.current = null;
      setPreview(null);
      setPreviewFailure(null);
      setSettings(DEFAULT_INK_SETTINGS);
      setCropOpen(false);
      setSource({ id: sourceIdRef.current, decoded, view: view as Source["view"], format });
      setStep("adjust");
    } catch (error) {
      if (controller.signal.aborted || !aliveRef.current) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPickError(copy.errors[inkErrorKey(error, format)]);
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        if (aliveRef.current) setReading(false);
      }
    }
  };
  const loadFileRef = useRef(loadFile);
  useEffect(() => {
    loadFileRef.current = loadFile;
  });

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void loadFile(file);
  };

  /* ---- Arrastrar y soltar / pegar -------------------------------------------------------------------------- */

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = Array.from(event.dataTransfer?.files ?? []).find(
      (candidate) => candidate.type.startsWith("image/") || /\.(png|jpe?g|webp|svg|heic|heif)$/i.test(candidate.name),
    );
    if (file) void loadFile(file);
    else if (event.dataTransfer?.files?.length) setPickError(copy.errors.unsupported);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      const image = files.find((file) => file.type.startsWith("image/"));
      if (!image) return;
      event.preventDefault();
      void loadFileRef.current(image);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  /* ---- Vista previa en vivo ----------------------------------------------------------------------------- */

  useEffect(() => {
    if (step !== "adjust" || !source) return;
    const controller = new AbortController();
    const key = `${source.id}|${settingsKey(settingsRef.current)}`;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const engine = await loadInkEngine();
          const current = settingsRef.current;
          const result = await engine.extractInkAsync(
            source.decoded,
            settingsToInkOptions(current, source.decoded),
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          const view = await viewCopy(result.image, VIEW_MAX_SIDE, controller.signal);
          if (controller.signal.aborted) return;
          fullRef.current = { key, result };
          setPreviewFailure(null);
          setPreview({ key, view, threshold: result.threshold, inkBounds: result.inkBounds });
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          fullRef.current = null;
          setPreview(null);
          setPreviewFailure({ key, message: copy.errors[inkErrorKey(error, source.format)] });
        }
      })();
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [step, source, settings, copy]);

  useEffect(() => {
    if (!preview) return;
    paintImage(checkerRef.current, preview.view);
    paintImage(lineRef.current, preview.view);
  }, [preview]);

  /* ---- Foco al cambiar de paso ------------------------------------------------------------------------------ */

  useEffect(() => {
    if (firstStepRef.current) {
      firstStepRef.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: false });
  }, [step]);

  /* ---- Ajustes -------------------------------------------------------------------------------------------- */

  const patch = (next: Partial<InkSettings>) => setSettings((current) => ({ ...current, ...next }));
  const autoThreshold = settings.threshold === "auto";
  const cleaning =
    settings.threshold === "auto"
      ? cleaningFromThreshold(preview?.threshold ?? thresholdFromCleaning(50))
      : cleaningFromThreshold(settings.threshold);

  const openCrop = () => {
    if (!source) return;
    patch({
      crop:
        settings.crop ??
        initialManualCrop(preview?.inkBounds, { width: source.decoded.width, height: source.decoded.height }),
    });
    setCropOpen(true);
  };
  const resetCrop = () => {
    patch({ crop: null });
    setCropOpen(false);
  };

  /* ---- Aceptar la imagen limpia ------------------------------------------------------------------------------ */

  const accept = async () => {
    if (!source || accepting) return;
    setAccepting(true);
    setPickError(null);
    try {
      const engine = await loadInkEngine();
      const stored = fullRef.current;
      const result =
        stored && stored.key === currentKey
          ? stored.result
          : await engine.extractInkAsync(source.decoded, settingsToInkOptions(settings, source.decoded));
      const blob = await engine.encodePng(result);
      const png = new Uint8Array(await blob.arrayBuffer());
      const image = vaultImageFromPng(png);
      if (!image) throw Object.assign(new Error("encode"), { name: "InkError", code: "encode-failed" });
      if (!aliveRef.current) return;
      if (target.kind === "draft") {
        target.onUse({ dataUrl: vaultImageToDataUrl(image), ratio: image.ratio });
        onClose();
        return;
      }
      setPrepared((current) => ({ ...current, [kind]: { png, width: image.width, height: image.height } }));
      // La imagen original se suelta: lo que sigue solo necesita el PNG limpio.
      fullRef.current = null;
      setSource(null);
      setPreview(null);
      setStep("summary");
    } catch (error) {
      if (!aliveRef.current) return;
      setPreviewFailure({ key: currentKey, message: copy.errors[inkErrorKey(error, source.format)] });
    } finally {
      if (aliveRef.current) setAccepting(false);
    }
  };

  /* ---- Resumen y guardado ---------------------------------------------------------------------------------- */

  const addOther = () => {
    const missing = missingKind(prepared);
    setKind(missing ?? "signature");
    setPickError(null);
    setStep("pick");
  };
  const replaceKind = (which: Kind) => {
    setKind(which);
    setPickError(null);
    setStep("pick");
  };
  const removeKind = (which: Kind) => {
    const next = { ...prepared, [which]: null };
    setPrepared(next);
    if (!next.signature && !next.initials) {
      setKind("signature");
      setStep("pick");
    }
  };

  const messageForSave = (result: Extract<SaveVaultResult, { ok: false }>): string => {
    switch (result.reason) {
      case "limit":
        return copy.saveLimit;
      case "tooLarge":
        return copy.saveTooLarge;
      case "invalid":
        return copy.saveInvalid;
      default:
        return copy.saveUnavailable;
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    setSaveError(null);
    if (name.trim() === "") {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    const entry = buildUploadEntry({
      signerName: name,
      role,
      signature: prepared.signature,
      initials: prepared.initials,
    });
    if (!entry) {
      setSaveError(copy.saveInvalid);
      return;
    }
    setSaving(true);
    const result = await saveVaultEntry(entry);
    if (!aliveRef.current) return;
    setSaving(false);
    if (!result.ok) {
      setSaveError(messageForSave(result));
      return;
    }
    const kinds = entry.signature && entry.initials ? "both" : entry.initials ? "initials" : "signature";
    onSaved?.(
      result.duplicate ? copy.savedDuplicate(result.entry.signerName) : copy.saved(result.entry.signerName, kinds),
    );
    onClose();
  };

  /* ---- Texto de la region de estado (una sola, siempre montada) ---------------------------------------------- */

  const statusError = pickError ?? failure ?? saveError;
  const statusText = statusError
    ? statusError
    : reading
      ? copy.reading
      : accepting || saving
        ? copy.saving
        : previewing
          ? copy.previewWorking
          : step === "adjust" && previewFresh
            ? copy.previewReady
            : "";

  const slotUrl = (which: Kind): string | null => {
    const item = prepared[which];
    const image = item ? vaultImageFromPng(item.png) : null;
    return image ? vaultImageToDataUrl(image) : null;
  };
  const signatureUrl = useMemo(
    () => (prepared.signature ? slotUrl("signature") : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prepared.signature],
  );
  const initialsUrl = useMemo(
    () => (prepared.initials ? slotUrl("initials") : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prepared.initials],
  );

  const vaultFull = !isDraft && vaultIsFull(entries.length);
  const kindChoices = [
    { value: "signature" as const, label: copy.kindSignature },
    { value: "initials" as const, label: copy.kindInitials },
  ];
  const showCamera = coarse;

  return (
    <div className="space-y-4 pb-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-ink-file-input
        onChange={onPicked}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-ink-camera-input
        onChange={onPicked}
      />

      {/* Region de estado UNICA: mensajes, errores y progreso pasan por aqui. */}
      <p
        role="status"
        aria-live="polite"
        data-ink-status
        className={cn(
          "flex items-center gap-2 text-footnote",
          statusError ? "text-destructive-text" : statusText ? "text-muted-foreground" : "sr-only",
        )}
      >
        {!statusError && (reading || accepting || saving || previewing) ? <Spinner className="size-4" /> : null}
        {statusText}
      </p>

      {step === "pick" ? (
        <div className="space-y-4">
          <h3 ref={headingRef} tabIndex={-1} className="sr-only">
            {isDraft ? copy.composeTitle : copy.title}
          </h3>
          <p className="text-subheadline text-muted-foreground">{copy.tip}</p>
          <div
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            data-ink-dropzone
            className={cn(
              "space-y-3 rounded-ios-sm border border-dashed p-4 transition-colors",
              dragging ? "border-signal bg-signal/10" : "border-white/20 bg-white/5",
            )}
          >
            <div className={cn("grid gap-2", showCamera && "sm:grid-cols-2")}>
              <Button
                size="md"
                fullWidth
                wrap
                disabled={reading}
                data-ink-pick
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageUp aria-hidden="true" className="size-4" />
                {copy.pickFile}
              </Button>
              {showCamera ? (
                <Button
                  variant="secondary"
                  size="md"
                  fullWidth
                  wrap
                  disabled={reading}
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera aria-hidden="true" className="size-4" />
                  {copy.takePhoto}
                </Button>
              ) : null}
            </div>
            <p className="text-footnote text-muted-foreground">{dragging ? copy.dropActive : copy.dropHint}</p>
            <p className="text-footnote text-muted-foreground">{copy.formats}</p>
          </div>
          <p className="text-footnote leading-relaxed text-muted-foreground">{copy.privacy}</p>
          {vaultFull ? (
            <p className="rounded-ios-sm border border-white/10 bg-white/5 p-3 text-footnote leading-relaxed text-muted-foreground">
              {copy.vaultFull}
            </p>
          ) : null}
          {prepared.signature || prepared.initials ? (
            <Button variant="ghost" size="md" fullWidth wrap onClick={() => setStep("summary")}>
              {copy.summaryTitle}
            </Button>
          ) : null}
        </div>
      ) : null}

      {step === "adjust" && source ? (
        <div className="space-y-5">
          <h3 ref={headingRef} tabIndex={-1} className="text-headline text-foreground">
            {copy.adjustTitle}
          </h3>

          <section aria-label={copy.previewTitle} className="space-y-2">
            <p className="ui-label text-muted-foreground">{copy.previewTitle}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <figure className="m-0 space-y-1">
                <div
                  className="flex min-h-28 items-center justify-center rounded-ios-sm border border-white/10 p-2"
                  style={CHECKER_STYLE}
                >
                  {preview ? (
                    <canvas
                      ref={checkerRef}
                      role="img"
                      aria-label={copy.previewAlt}
                      data-ink-preview="checker"
                      className="block max-h-28 w-auto max-w-full"
                    />
                  ) : null}
                </div>
                <figcaption className="text-caption text-muted-foreground">{copy.previewChecker}</figcaption>
              </figure>
              <figure className="m-0 space-y-1">
                <div className="flex min-h-28 flex-col items-center justify-end rounded-ios-sm border border-white/10 bg-white px-2 pt-2">
                  {preview ? (
                    <canvas
                      ref={lineRef}
                      aria-hidden="true"
                      data-ink-preview="line"
                      className="-mb-3 block max-h-24 w-auto max-w-full"
                    />
                  ) : null}
                  <div className="mb-3 h-px w-full bg-neutral-500" aria-hidden="true" />
                </div>
                <figcaption className="text-caption text-muted-foreground">{copy.previewLine}</figcaption>
              </figure>
            </div>
          </section>

          <section aria-label={copy.cropTitle} className="space-y-2">
            <p className="ui-label text-muted-foreground">{copy.cropTitle}</p>
            {cropOpen && settings.crop ? (
              <div className="space-y-2">
                <p className="text-footnote text-muted-foreground">{copy.cropHelp}</p>
                <InkCropper
                  image={source.view}
                  crop={settings.crop}
                  onChange={(crop: CropFraction) => patch({ crop })}
                  strings={copy}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="md" wrap onClick={() => setCropOpen(false)}>
                    {copy.cropDone}
                  </Button>
                  <Button variant="ghost" size="md" wrap onClick={resetCrop}>
                    {copy.cropReset}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-footnote text-muted-foreground">
                  {settings.crop ? copy.cropManual : copy.cropAutoHint}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="md" wrap onClick={openCrop}>
                    <Crop aria-hidden="true" className="size-4" />
                    {copy.cropManual}
                  </Button>
                  {settings.crop ? (
                    <Button variant="ghost" size="md" wrap onClick={resetCrop}>
                      {copy.cropReset}
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <div className="space-y-2">
              <Slider
                label={autoThreshold ? `${copy.cleanLabel} (${copy.cleanAutoActive})` : copy.cleanLabel}
                value={cleaning}
                min={CLEAN_MIN}
                max={CLEAN_MAX}
                step={1}
                onChange={(value) => patch({ threshold: thresholdFromCleaning(value) })}
              />
              <Button
                variant="ghost"
                size="sm"
                className="pointer-coarse:h-11 pointer-coarse:before:hidden"
                disabled={autoThreshold}
                onClick={() => patch({ threshold: "auto" })}
              >
                {copy.cleanAuto}
              </Button>
            </div>
            <InkSwitch
              label={copy.evenLighting}
              hint={copy.evenLightingHint}
              checked={settings.evenLighting}
              onChange={(value) => patch({ evenLighting: value })}
            />
            <InkSwitch
              label={copy.removeSpecks}
              hint={copy.removeSpecksHint}
              checked={settings.removeSpecks}
              onChange={(value) => patch({ removeSpecks: value })}
            />
            <ChoiceGroup<InkColorChoice>
              label={copy.inkLabel}
              value={settings.ink}
              columns={3}
              choices={[
                { value: "original", label: copy.inkOriginal },
                { value: "black", label: copy.inkBlack },
                { value: "blue", label: copy.inkBlue },
              ]}
              onChange={(ink) => patch({ ink })}
            />
          </section>

          {!isDraft ? (
            <ChoiceGroup<Kind> label={copy.kindLabel} value={kind} columns={2} choices={kindChoices} onChange={setKind} />
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              size="md"
              wrap
              disabled={accepting || !previewFresh}
              data-ink-accept
              onClick={() => void accept()}
            >
              {isDraft ? copy.useDraft : copy.useAs(kind)}
            </Button>
            <Button
              variant="ghost"
              size="md"
              wrap
              onClick={() => {
                fullRef.current = null;
                setSource(null);
                setPreview(null);
                setStep("pick");
              }}
            >
              {copy.chooseAnother}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "summary" ? (
        <form className="space-y-5" onSubmit={(event) => void save(event)} noValidate>
          <h3 ref={headingRef} tabIndex={-1} className="text-headline text-foreground">
            {copy.summaryTitle}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["signature", "initials"] as const).map((which) => {
              const url = which === "signature" ? signatureUrl : initialsUrl;
              const label = which === "signature" ? copy.slotSignature : copy.slotInitials;
              return (
                <div key={which} className="surface-card rounded-ios-sm space-y-2 p-3">
                  <p className="ui-label text-muted-foreground">{label}</p>
                  <div
                    className="flex min-h-20 items-center justify-center rounded-ios-sm border border-white/10 p-2"
                    style={CHECKER_STYLE}
                  >
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt={copy.slotAlt(which)} className="max-h-16 w-auto max-w-full object-contain" />
                    ) : (
                      <span className="text-footnote text-neutral-600">{copy.slotEmpty}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {url ? (
                      <>
                        <Button variant="ghost" size="md" wrap onClick={() => replaceKind(which)}>
                          {copy.changeImage}
                        </Button>
                        <Button
                          variant="ghost"
                          size="md"
                          wrap
                          aria-label={`${copy.removeImage}: ${label}`}
                          onClick={() => removeKind(which)}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                          {copy.removeImage}
                        </Button>
                      </>
                    ) : (
                      <Button variant="secondary" size="md" wrap onClick={addOther}>
                        {which === "initials" ? copy.addInitials : copy.addSignature}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <label htmlFor="ink-import-name" className="ui-label mb-1.5 block text-muted-foreground">
              {copy.nameLabel}
            </label>
            <input
              ref={nameRef}
              id="ink-import-name"
              type="text"
              value={name}
              maxLength={200}
              autoComplete="off"
              aria-required="true"
              aria-invalid={nameMissing ? true : undefined}
              aria-describedby={nameMissing ? "ink-import-name-error" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameMissing(false);
                setSaveError(null);
              }}
              className={INPUT_CLASS}
            />
            {nameMissing ? (
              <p id="ink-import-name-error" className="mt-1.5 text-footnote text-destructive-text">
                {copy.nameNeeded}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="ink-import-role" className="ui-label mb-1.5 block text-muted-foreground">
              {copy.roleLabel}
            </label>
            <input
              id="ink-import-role"
              type="text"
              value={role}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => setRole(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          {vaultFull ? (
            <p className="rounded-ios-sm border border-white/10 bg-white/5 p-3 text-footnote leading-relaxed text-muted-foreground">
              {copy.vaultFull}
            </p>
          ) : null}
          <p className="text-footnote leading-relaxed text-muted-foreground">{copy.privacy}</p>
          <Button type="submit" size="md" fullWidth wrap disabled={saving} data-ink-save>
            {copy.save}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Interruptor con etiqueta y ayuda (≥ 44 px, sin depender del hover)
 * ------------------------------------------------------------------ */

function InkSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hintId = `ink-switch-${label.replace(/\W+/g, "-").toLowerCase()}-hint`;
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hintId}
        onClick={() => onChange(!checked)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-ios-sm border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors hover:border-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal forced-colors:border-[ButtonText]"
      >
        <span className="min-w-0 text-subheadline font-medium text-foreground">{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 forced-colors:border forced-colors:border-[ButtonText]",
            checked ? "bg-signal forced-colors:bg-[Highlight]" : "bg-white/15",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-foreground transition-transform duration-200 ease-spring motion-reduce:transition-none",
              checked ? "translate-x-4 forced-colors:bg-[HighlightText]" : "forced-colors:bg-[ButtonText]",
            )}
          />
        </span>
      </button>
      <p id={hintId} className="mt-1.5 text-footnote leading-relaxed text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
