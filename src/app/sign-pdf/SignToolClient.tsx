"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignaturePlacer } from "@/app/sign-pdf/SignaturePlacer";
import { SignerManager } from "@/app/sign-pdf/SignerManager";
import { FieldPlacer, TextFieldPlacer } from "@/app/sign-pdf/FieldPlacer";
import { FieldFormPanel } from "@/app/sign-pdf/FieldFormPanel";
import {
  SigningCeremony,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/SigningCeremony";
import {
  documentContentKey,
  useDocumentKey,
} from "@/app/sign-pdf/documentKey";
import { SIGN_STRINGS, type SignStrings } from "@/app/sign-pdf/strings";
import { useI18n } from "@/lib/i18n";
import { PdfError, withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import {
  buildSignerFilenamePrefix,
  dataUrlToBytes,
  signPdf,
  signPdfMulti,
  type SignPlacement,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("sign-pdf");

/** "Solo yo" es el camino rapido de siempre; "varios" abre la ronda por turnos. */
export type SignMode = "single" | "multi";

type MultiStep = "signers" | "fields" | "text" | "sign";

const MULTI_STEPS: readonly MultiStep[] = [
  "signers",
  "fields",
  "text",
  "sign",
] as const;

export type SignToolOptions = {
  mode: SignMode;

  /* --- Solo yo --- */
  signaturePng: string;
  /** alto / ancho del PNG; 0 mientras no hay firma. */
  ratio: number;
  pageIndex: number;
  /** `width: 0` significa "aún sin colocar". */
  rect: NormalizedRect;

  /* --- Varios firmantes --- */
  /** Documento al que pertenecen los huecos y los trazos guardados. */
  signature: string;
  step: MultiStep;
  signers: Signer[];
  fields: SignatureField[];
  captures: CaptureMap;
  activeSignerId: string | null;
  fieldType: SignatureFieldType;
  fieldPageIndex: number;
  selectedFieldId: string | null;

  /* --- Campos de texto: detectados o anadidos a mano --- */
  textFields: DetectedField[];
  /** Valor de cada campo de texto, indexado por `id`. Vacio = no se empotra. */
  textValues: Record<string, string>;
  textFieldPageIndex: number;
  selectedTextFieldId: string | null;
};

const DEFAULT_OPTIONS: SignToolOptions = {
  mode: "single",
  signaturePng: "",
  ratio: 0,
  pageIndex: 0,
  rect: { x: 0, y: 0, width: 0, height: 0 },
  signature: "",
  step: "signers",
  signers: [],
  fields: [],
  captures: {},
  activeSignerId: null,
  fieldType: "signature",
  fieldPageIndex: 0,
  selectedFieldId: null,
  textFields: [],
  textValues: {},
  textFieldPageIndex: 0,
  selectedTextFieldId: null,
};

/* ------------------------------------------------------------------ *
 * Reutilizacion de valores entre documentos (sessionStorage)
 * ------------------------------------------------------------------ */

/**
 * Solo `sessionStorage` (nunca `localStorage`): los datos se olvidan al
 * cerrar la pestaña, igual que el resto de este proyecto no guarda nada
 * mas alla de lo imprescindible para la sesion en curso.
 */
const SESSION_VALUES_KEY = "optimuspdf:sign-fill:lastValues";

/** Marcas diacriticas combinantes U+0300..U+036F (igual que `core.ts:slugify`). */
const FIELD_LABEL_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

/** "Cliente/Asegurado:" -> "cliente asegurado" */
function normalizeFieldLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(FIELD_LABEL_DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadStoredValues(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(SESSION_VALUES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Se llama tras un fill+sign+download con exito; nunca bloquea el flujo si falla. */
function saveStoredValues(
  fields: readonly DetectedField[],
  values: Record<string, string>,
): void {
  try {
    const out: Record<string, string> = {};
    for (const field of fields) {
      const label = field.label;
      const value = values[field.id]?.trim();
      if (!label || !value) continue;
      out[normalizeFieldLabel(label)] = value;
    }
    if (Object.keys(out).length === 0) return;
    window.sessionStorage.setItem(SESSION_VALUES_KEY, JSON.stringify(out));
  } catch {
    // Sin sessionStorage disponible (privado/cuota agotada) no hay nada
    // que guardar: no es motivo para interrumpir la firma.
  }
}

/** Campos cuya etiqueta coincide con un valor guardado de una sesion anterior. */
function matchingStoredValues(
  fields: readonly DetectedField[],
  stored: Record<string, string>,
): Record<string, string> {
  const matches: Record<string, string> = {};
  for (const field of fields) {
    if (!field.label) continue;
    const value = stored[normalizeFieldLabel(field.label)];
    if (value) matches[field.id] = value;
  }
  return matches;
}

/** Al menos un campo de texto tiene algo que empotrar. */
function hasFilledTextValue(
  fields: readonly DetectedField[],
  values: Record<string, string>,
): boolean {
  return fields.some((field) => (values[field.id] ?? "").trim().length > 0);
}

/**
 * Cada hueco se rellena con el trazo que creo su dueño. Un mismo PNG
 * puede repetirse en varios huecos, asi que se decodifica una sola vez.
 * Solo entran trazos cuya huella sigue describiendo estos huecos: una
 * captura anterior a un cambio de campos o de archivo no se reaplica.
 */
function buildPlacements(
  options: SignToolOptions,
  documentKey: string,
): SignPlacement[] {
  const decoded = new Map<string, Uint8Array>();
  const placements: SignPlacement[] = [];

  for (const field of options.fields) {
    const draft = validCapture(
      options.captures,
      options.fields,
      field.signerId,
      documentKey,
    )[field.type];
    if (!draft) throw new PdfError("nothingSelected", "sign:notAllSigned");
    let png = decoded.get(draft.dataUrl);
    if (!png) {
      png = dataUrlToBytes(draft.dataUrl);
      decoded.set(draft.dataUrl, png);
    }
    placements.push({
      kind: "image",
      png,
      pageIndex: field.pageIndex,
      rect: field.rect,
    });
  }

  // Los campos de texto son opcionales y van aparte de la ronda de
  // firmantes: uno vacio simplemente no se empotra (nunca "firma en
  // blanco" ni estropea el documento), asi que aqui se descartan sin
  // avisar en vez de exigir que esten todos rellenos.
  for (const field of options.textFields) {
    const value = options.textValues[field.id]?.trim();
    if (!value) continue;
    placements.push({
      kind: "text",
      value,
      pageIndex: field.pageIndex,
      rect: field.rect,
    });
  }

  return placements;
}

/**
 * Si el documento tiene huecos de firma/inicial, TODOS deben tener trazo
 * -- los campos de texto son opcionales en ese caso y no bastan por si
 * solos (evita habilitar "Firmar" cuando en realidad falta un firmante,
 * que hoy solo fallaria despues con "sign:notAllSigned"). Solo cuando NO
 * hay huecos de imagen se acepta rellenar-y-descargar con al menos un
 * campo de texto lleno.
 */
function multiReady(
  options: SignToolOptions,
  documentKey: string | null,
): boolean {
  if (options.fields.length > 0) {
    return (
      pendingSigners(
        options.signers,
        options.fields,
        options.captures,
        documentKey,
      ).length === 0
    );
  }

  return hasFilledTextValue(options.textFields, options.textValues);
}

export function SignToolClient() {
  const { language, t } = useI18n();
  const strings = SIGN_STRINGS[language];
  const [composerOpen, setComposerOpen] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  /** Lo rellena `ToolShell`: remata la ronda con el mismo procesado de siempre. */
  const runRef = useRef<(() => void) | null>(null);

  /**
   * Respuesta del prompt de prefijo de firmantes (ver `requestFinish`),
   * leida por `process()` en el momento de escribir el archivo. Va en un
   * ref (no en `SignToolOptions`) para no depender de que un `setOptions`
   * asincronico ya se haya reflejado en el render antes de disparar
   * `runRef.current?.()` -- evita una condicion de carrera real entre
   * "guardar la eleccion" y "arrancar el procesado".
   */
  const signerPrefixRef = useRef(false);
  const [prefixPromptOpen, setPrefixPromptOpen] = useState(false);

  /**
   * Se llama al pulsar "Firmar y descargar"/"Aplicar y descargar" en modo
   * multi. Si hay al menos un firmante con nombre, pregunta si prefijar
   * el archivo con esos nombres antes de arrancar el procesado real; si
   * ninguno tiene nombre, no tiene sentido preguntar y se salta directo.
   */
  const requestFinish = useCallback((signers: Signer[]) => {
    const hasNamedSigner = signers.some((signer) => signer.name.trim().length > 0);
    if (!hasNamedSigner) {
      signerPrefixRef.current = false;
      runRef.current?.();
      return;
    }
    setPrefixPromptOpen(true);
  }, []);

  const choosePrefix = useCallback((useSignerPrefix: boolean) => {
    signerPrefixRef.current = useSignerPrefix;
    setPrefixPromptOpen(false);
    runRef.current?.();
  }, []);

  const process = useCallback(
    async (
      files: File[],
      options: SignToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const baseFilename = withSuffix(file.name, strings.filenameSuffix);

      if (options.mode === "single") {
        const blob = await signPdf(
          file,
          {
            signaturePng: options.signaturePng,
            placement: { pageIndex: options.pageIndex, rect: options.rect },
          },
          onProgress,
        );
        return { blob, filename: baseFilename };
      }

      const hasText = hasFilledTextValue(options.textFields, options.textValues);
      if (options.fields.length === 0 && !hasText) {
        throw new PdfError("nothingSelected", "sign:noFields");
      }
      // Comprobacion definitiva justo antes de escribir: el archivo que
      // se firma tiene que ser el mismo que vieron los firmantes, aunque
      // lo hayan cambiado por otro de igual nombre, tamaño y fecha.
      const documentKey = await documentContentKey(file).catch(() => null);
      if (!documentKey) {
        throw new PdfError("inspectionIncomplete", "sign:documentKey");
      }
      const blob = await signPdfMulti(
        file,
        { placements: buildPlacements(options, documentKey) },
        onProgress,
      );
      // Solo se guarda tras un empotrado con exito: si `signPdfMulti`
      // lanza, la linea de arriba corta antes de llegar aqui.
      saveStoredValues(options.textFields, options.textValues);

      const prefix = signerPrefixRef.current
        ? buildSignerFilenamePrefix(options.signers.map((signer) => signer.name))
        : null;
      const filename = prefix ? `${prefix}_${baseFilename}` : baseFilename;
      return { blob, filename };
    },
    [strings.filenameSuffix],
  );

  return (
    <Fragment>
    <ToolShell<SignToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      progressMessage={strings.progressMessage}
      runRef={runRef}
      // "Solo yo" conserva la puerta de siempre (solo el minimo de
      // archivos); la ronda por turnos si exige tenerlo todo firmado.
      // `options.signature` es la huella del documento sobre el que se
      // reservaron los huecos; que siga siendo la del archivo cargado lo
      // vuelve a comprobar `process()` antes de escribir nada.
      canRun={(_files, options) =>
        options.mode === "single" ? true : multiReady(options, options.signature)
      }
      renderMain={({ files, options, setOptions }) => (
        <div className="space-y-6">
          <section>
            <SegmentedControl<SignMode>
              label={strings.modeLabel}
              value={options.mode}
              onChange={(mode) => setOptions({ mode })}
              options={[
                { value: "single", label: strings.modeSingle },
                { value: "multi", label: strings.modeMulti },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {options.mode === "single"
                ? strings.modeSingleHint
                : strings.modeMultiHint}
            </p>
          </section>

          {options.mode === "single" ? (
            <>
              <SignaturePlacer
                file={files[0] ?? null}
                signature={options.signaturePng || null}
                ratio={options.ratio}
                rect={options.rect}
                onRectChange={(rect) => setOptions({ rect })}
                pageIndex={options.pageIndex}
                onPageIndexChange={(pageIndex) => setOptions({ pageIndex })}
                pageCount={pageCount}
                onPageCount={setPageCount}
                strings={strings}
              />
              <SignatureComposer
                open={composerOpen}
                onClose={() => setComposerOpen(false)}
                strings={strings}
                onSave={(draft: SignatureDraft) =>
                  setOptions({
                    signaturePng: draft.dataUrl,
                    ratio: draft.ratio,
                    // Fuerza el recálculo de la colocación por defecto.
                    rect: { x: 0, y: 0, width: 0, height: 0 },
                  })
                }
              />
            </>
          ) : (
            <MultiFlow
              file={files[0] ?? null}
              options={options}
              setOptions={setOptions}
              onFinish={() => requestFinish(options.signers)}
              strings={strings}
            />
          )}
        </div>
      )}
      renderOptions={({ options }) =>
        options.mode === "single" ? (
          <section className="space-y-4">
            <Button
              variant={options.signaturePng ? "secondary" : "primary"}
              size="md"
              fullWidth
              onClick={() => setComposerOpen(true)}
            >
              <PenLine aria-hidden="true" className="size-4" />
              {options.signaturePng
                ? strings.changeSignature
                : strings.createSignature}
            </Button>

            {options.signaturePng ? (
              <div className="rounded-ios-sm flex items-center justify-center border border-white/10 bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={options.signaturePng}
                  alt={strings.createTitle}
                  className="max-h-24 w-auto max-w-full object-contain"
                />
              </div>
            ) : (
              <p role="alert" className="text-xs text-destructive">
                {strings.noSignature}
              </p>
            )}

            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.legalNote}
            </p>
          </section>
        ) : (
          <section className="space-y-3">
            <span className="hud-label block text-[10px] text-muted-foreground">
              {strings.modeMulti}
            </span>
            <p className="text-sm text-foreground tabular-nums">
              {strings.totalFields(options.fields.length)}
            </p>
            {options.fields.length === 0 &&
            !hasFilledTextValue(options.textFields, options.textValues) ? (
              <p className="text-xs leading-relaxed text-destructive">
                {strings.noFieldsError}
              </p>
            ) : multiReady(options, options.signature) ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {strings.allSignedBody}
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-destructive">
                {strings.notAllSignedError}{" "}
                {strings.pendingBody(
                  pendingSigners(
                    options.signers,
                    options.fields,
                    options.captures,
                    options.signature,
                  ).length,
                )}
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.legalNote}
            </p>
          </section>
        )
      }
    />
    <Sheet
      open={prefixPromptOpen}
      onClose={() => setPrefixPromptOpen(false)}
      title={strings.filenamePrefixTitle}
      closeLabel={t.common.close}
    >
      <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
        {strings.filenamePrefixBody}
      </p>
      <div className="flex flex-col gap-2 pb-2">
        <Button size="md" fullWidth onClick={() => choosePrefix(true)}>
          {strings.filenamePrefixYes}
        </Button>
        <Button
          variant="ghost"
          size="md"
          fullWidth
          onClick={() => choosePrefix(false)}
        >
          {strings.filenamePrefixNo}
        </Button>
      </div>
    </Sheet>
    </Fragment>
  );
}

export type MultiFlowProps = {
  file: File | null;
  options: SignToolOptions;
  setOptions: (patch: Partial<SignToolOptions>) => void;
  onFinish: () => void;
  strings: SignStrings;
};

export function MultiFlow({
  file,
  options,
  setOptions,
  onFinish,
  strings,
}: MultiFlowProps) {
  /** Huella del contenido del archivo; `null` mientras se calcula. */
  const documentKey = useDocumentKey(file);
  const [detecting, setDetecting] = useState(false);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [reuseMatches, setReuseMatches] = useState<Record<string, string> | null>(
    null,
  );
  /**
   * Huella para la que ya se lanzo (o esta en marcha) la deteccion. Vive
   * en un ref, no en `options`, a proposito: si estuviera en las
   * dependencias del efecto de deteccion, el propio `setOptions({
   * textFields: ... })` con el que termina la deteccion volveria a
   * disparar ese mismo efecto y cancelaria su propia peticion en marcha
   * antes de que resolviera (esto se detecto de verdad reordenando los
   * tests, no es hipotetico).
   */
  const detectedForRef = useRef<string | null>(null);

  /**
   * Los huecos y los trazos describen un documento concreto. Al cambiar
   * el archivo se empieza de cero: heredarlos colocaria firmas sobre
   * paginas que nadie llego a ver. Los firmantes si sobreviven, porque no
   * dependen del documento. Mientras no haya huella no se decide nada:
   * las capturas ya cuentan como invalidas hasta que llegue.
   */
  useEffect(() => {
    if (documentKey === null || options.signature === documentKey) return;
    // `queueMicrotask` para no llamar a `setState` sincrono en el cuerpo
    // del efecto (mismo patron que `FileList.tsx:FileThumbnail`).
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setOptions({
        signature: documentKey,
        step: "signers",
        fields: [],
        captures: {},
        fieldPageIndex: 0,
        selectedFieldId: null,
        textFields: [],
        textValues: {},
        textFieldPageIndex: 0,
        selectedTextFieldId: null,
      });
      setReuseMatches(null);
      setDetectionFailed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [documentKey, options.signature, setOptions]);

  /**
   * Deteccion de campos de texto (AcroForm + heuristica vectorial/raster)
   * del documento nuevo. Depende solo de `documentKey`/`file` -nunca de
   * `options.signature` ni de nada que la propia deteccion module- para
   * no cancelarse a si misma a mitad. Un fallo nunca bloquea nada: el
   * usuario siempre puede seguir anadiendo campos a mano
   * (`detectionFailedHint`).
   */
  useEffect(() => {
    if (!file || documentKey === null) return;
    if (detectedForRef.current === documentKey) return;
    detectedForRef.current = documentKey;

    let cancelled = false;
    setDetecting(true);
    void detectFields(file)
      .then((detected) => {
        if (cancelled) return;
        setOptions({ textFields: detected });
        const matches = matchingStoredValues(detected, loadStoredValues());
        if (Object.keys(matches).length > 0) setReuseMatches(matches);
      })
      .catch(() => {
        if (!cancelled) setDetectionFailed(true);
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentKey, file, setOptions]);

  const stepLabels: Record<MultiStep, string> = {
    signers: strings.stepSigners,
    fields: strings.stepFields,
    text: strings.stepText,
    sign: strings.stepSign,
  };

  /**
   * Un paso solo se abre cuando el anterior ya tiene lo que necesita. El
   * paso de texto no depende de los firmantes (un campo de texto no
   * tiene dueño), asi que siempre esta abierto; el de firmar se abre con
   * huecos de imagen listos O con algun campo de texto relleno.
   */
  const reachable = (step: MultiStep): boolean => {
    if (step === "signers") return true;
    if (step === "fields") return options.signers.length > 0;
    if (step === "text") return true;
    return (
      options.fields.length > 0 ||
      hasFilledTextValue(options.textFields, options.textValues)
    );
  };

  /** Quita del mapa de valores lo que ya no describe ningun campo vivo. */
  const onTextFieldsChange = (fields: DetectedField[]) => {
    const alive = new Set(fields.map((field) => field.id));
    const values: Record<string, string> = {};
    for (const [id, value] of Object.entries(options.textValues)) {
      if (alive.has(id)) values[id] = value;
    }
    setOptions({ textFields: fields, textValues: values });
  };

  const onTextValueChange = (id: string, value: string) => {
    setOptions({ textValues: { ...options.textValues, [id]: value } });
  };

  const acceptReuse = () => {
    if (!reuseMatches) return;
    setOptions({ textValues: { ...options.textValues, ...reuseMatches } });
    setReuseMatches(null);
  };

  const position = MULTI_STEPS.indexOf(options.step);
  const nextStep = MULTI_STEPS[position + 1];
  const previousStep = MULTI_STEPS[position - 1];

  const fieldCounts: Record<string, number> = {};
  for (const field of options.fields) {
    fieldCounts[field.signerId] = (fieldCounts[field.signerId] ?? 0) + 1;
  }

  /**
   * Al quitar a un firmante desaparecen tambien sus huecos y su trazo:
   * dejarlos sueltos convertiria el documento en algo imposible de
   * completar.
   */
  const onSignersChange = (signers: Signer[]) => {
    const alive = new Set(signers.map((signer) => signer.id));
    const fields = options.fields.filter((field) => alive.has(field.signerId));
    const captures: CaptureMap = {};
    for (const [id, capture] of Object.entries(options.captures)) {
      if (alive.has(id)) captures[id] = capture;
    }
    setOptions({ signers, fields, captures });
  };

  return (
    <div className="space-y-5">
      <nav aria-label={strings.ceremonyTitle} className="flex flex-wrap gap-1.5">
        {MULTI_STEPS.map((step, index) => {
          const active = step === options.step;
          const open = reachable(step);
          return (
            <button
              key={step}
              type="button"
              disabled={!open}
              aria-current={active ? "step" : undefined}
              onClick={() => setOptions({ step })}
              className={
                active
                  ? "hud-label min-h-11 rounded-ios-sm border border-signal/60 bg-signal/15 px-3 text-[10px] text-foreground"
                  : "hud-label min-h-11 rounded-ios-sm border border-white/10 bg-white/5 px-3 text-[10px] text-muted-foreground transition-colors enabled:hover:border-white/25 enabled:hover:text-foreground disabled:opacity-40"
              }
            >
              {index + 1}. {stepLabels[step]}
            </button>
          );
        })}
      </nav>

      {options.step === "signers" ? (
        <SignerManager
          signers={options.signers}
          onSignersChange={onSignersChange}
          activeSignerId={options.activeSignerId}
          onActiveSignerIdChange={(activeSignerId) =>
            setOptions({ activeSignerId })
          }
          fieldCounts={fieldCounts}
          strings={strings}
        />
      ) : null}

      {options.step === "fields" ? (
        <FieldPlacer
          file={file}
          signers={options.signers}
          activeSignerId={options.activeSignerId}
          onActiveSignerIdChange={(activeSignerId) =>
            setOptions({ activeSignerId })
          }
          fields={options.fields}
          onFieldsChange={(fields) => setOptions({ fields })}
          activeType={options.fieldType}
          onActiveTypeChange={(fieldType) => setOptions({ fieldType })}
          pageIndex={options.fieldPageIndex}
          onPageIndexChange={(fieldPageIndex) => setOptions({ fieldPageIndex })}
          selectedId={options.selectedFieldId}
          onSelectedIdChange={(selectedFieldId) =>
            setOptions({ selectedFieldId })
          }
          strings={strings}
        />
      ) : null}

      {options.step === "text" ? (
        <section className="space-y-5">
          {detecting ? (
            <div className="glass rounded-ios flex items-center gap-3 p-5">
              <Spinner />
              <p className="text-sm text-muted-foreground">
                {strings.detectingFields}
              </p>
            </div>
          ) : null}

          {!detecting && detectionFailed ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.detectionFailedHint}
            </p>
          ) : null}

          {!detecting && !detectionFailed && options.textFields.length > 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.detectedFieldsSummary(options.textFields.length)}
            </p>
          ) : null}

          {reuseMatches ? (
            <div className="glass rounded-ios flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm text-foreground">{strings.reuseValuesPrompt}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={acceptReuse}>
                  {strings.reuseValuesAccept}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReuseMatches(null)}
                >
                  {strings.reuseValuesDecline}
                </Button>
              </div>
            </div>
          ) : null}

          <TextFieldPlacer
            file={file}
            fields={options.textFields}
            onFieldsChange={onTextFieldsChange}
            values={options.textValues}
            onValueChange={onTextValueChange}
            pageIndex={options.textFieldPageIndex}
            onPageIndexChange={(textFieldPageIndex) =>
              setOptions({ textFieldPageIndex })
            }
            selectedId={options.selectedTextFieldId}
            onSelectedIdChange={(selectedTextFieldId) =>
              setOptions({ selectedTextFieldId })
            }
            strings={strings}
          />

          <FieldFormPanel
            fields={options.textFields}
            values={options.textValues}
            onValueChange={onTextValueChange}
            selectedId={options.selectedTextFieldId}
            onSelectedIdChange={(selectedTextFieldId) =>
              setOptions({ selectedTextFieldId })
            }
            onGoToField={(targetField) =>
              setOptions({ textFieldPageIndex: targetField.pageIndex })
            }
            strings={strings}
          />
        </section>
      ) : null}

      {options.step === "sign" && options.fields.length > 0 ? (
        <SigningCeremony
          signers={options.signers}
          fields={options.fields}
          captures={options.captures}
          onCapturesChange={(captures) => setOptions({ captures })}
          documentKey={documentKey}
          onFinish={onFinish}
          strings={strings}
        />
      ) : null}

      {/*
       * Sin huecos de imagen no hay ronda que mostrar: `SigningCeremony`
       * (su cola de firmantes viene de `fields`, vacio aqui) se queda
       * con el boton deshabilitado para siempre, aunque el documento ya
       * este listo (rellenar-y-descargar). Se muestra en su lugar un
       * panel minimo con el mismo `onFinish`.
       */}
      {options.step === "sign" && options.fields.length === 0 ? (
        <div className="glass rounded-ios p-5">
          <h4 className="text-base font-black tracking-[-0.02em] text-foreground">
            {strings.textOnlyReadyTitle}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.textOnlyReadyBody}
          </p>
          <div className="mt-4">
            <Button
              size="lg"
              disabled={!hasFilledTextValue(options.textFields, options.textValues)}
              onClick={onFinish}
            >
              {strings.finishAndDownload}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {previousStep ? (
          <Button
            variant="secondary"
            size="md"
            onClick={() => setOptions({ step: previousStep })}
          >
            {strings.back}
          </Button>
        ) : null}
        {nextStep ? (
          <Button
            size="md"
            disabled={!reachable(nextStep)}
            onClick={() => setOptions({ step: nextStep })}
          >
            {strings.next}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
