"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Spinner } from "@/components/ui/Spinner";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignaturePlacer } from "@/app/sign-pdf/SignaturePlacer";
import {
  SignerManager,
  nextSignerId,
  recolor,
  reserveSignerIds,
} from "@/app/sign-pdf/SignerManager";
import {
  FieldPlacer,
  TextFieldPlacer,
  nextFieldId,
  nextTextFieldId,
  reserveFieldIds,
  reserveTextFieldIds,
} from "@/app/sign-pdf/FieldPlacer";
import { FieldFormPanel } from "@/app/sign-pdf/FieldFormPanel";
import { PrivacyNotice } from "@/app/sign-pdf/PrivacyNotice";
import { DraftsSheet } from "@/app/sign-pdf/DraftsSheet";
import { TemplatesSheet } from "@/app/sign-pdf/TemplatesSheet";
import {
  instantiateTemplate,
  saveTemplate,
  TEMPLATE_NAME_MAX,
  type SignTemplate,
} from "@/app/sign-pdf/signTemplates";
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
import {
  exportSignConfig,
  importSignConfig,
  signConfigFilename,
  type SignConfigManifest,
} from "@/app/sign-pdf/signConfig";
import {
  deleteDraft,
  loadDraft,
  saveDraft,
  type SaveDraftParams,
} from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS, type SignStrings } from "@/app/sign-pdf/strings";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { useI18n, type Language } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  downloadBlob,
  loadPdf,
  matchesAccept,
  toPdfError,
  withSuffix,
  type PdfErrorCode,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  detectFields,
  embeddedValueFor,
  fieldTypeOf,
  isFieldFilled,
  type DetectedField,
} from "@/lib/pdf/detectFields";
import {
  SIGNER_COLORS,
  buildSignerFilenamePrefix,
  dataUrlToBytes,
  normalizeFieldLabel,
  signPdf,
  signPdfMulti,
  type SignPlacement,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { getTool } from "@/lib/tools-registry";
import { bestMatchForKey, recordValue } from "@/lib/valueHistory";

const TOOL = getTool("sign-pdf");

/** "Solo yo" es el camino rapido de siempre; "varios" abre la ronda por turnos. */
export type SignMode = "single" | "multi";

export type MultiStep = "signers" | "fields" | "text" | "sign";

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
  /** Campo con el input en linea abierto (distinto de "seleccionado"). */
  editingTextFieldId: string | null;
  /**
   * Huella del documento para el que `textFields` ya viene resuelto (por
   * deteccion real o por restaurar un borrador/una configuracion
   * importada) -- `null` si todavia no hay nada resuelto. Sin esto, el
   * efecto de deteccion de `MultiFlow` (que no mira `textFields`, solo la
   * huella) volveria a detectar y pisaria en silencio los campos ya
   * restaurados de un borrador (incluidos los anadidos a mano, que la
   * deteccion real nunca podria reconstruir).
   */
  textFieldsDetectedFor: string | null;
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
  editingTextFieldId: null,
  textFieldsDetectedFor: null,
};

/* ------------------------------------------------------------------ *
 * Reutilizacion de valores entre documentos (src/lib/valueHistory.ts)
 * ------------------------------------------------------------------ */

/** Se llama tras un fill+sign+download con exito; nunca bloquea el flujo si falla. */
function recordFilledValues(
  fields: readonly DetectedField[],
  values: Record<string, string>,
): void {
  for (const field of fields) {
    const label = field.label;
    const value = values[field.id]?.trim();
    if (!label || !value) continue;
    recordValue(normalizeFieldLabel(label), value);
  }
}

/**
 * Documentos para los que el usuario ya dijo "no, empezar en blanco" en
 * esta pestaña. `sessionStorage` (no `localStorage`, y no un `ref`): a
 * diferencia del historial de valores, esto es un dato de interfaz (que
 * no volver a preguntar), no PII, y tiene que sobrevivir a que `MultiFlow`
 * se desmonte y remonte (ej. alternar "Solo yo" <-> "Varios firmantes"),
 * que un `ref` de componente no sobrevive.
 */
const DECLINED_REUSE_KEY = "optimuspdf:sign-fill:declinedReuse";

function hasDeclinedReuse(documentKey: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(DECLINED_REUSE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.includes(documentKey);
  } catch {
    return false;
  }
}

function markDeclinedReuse(documentKey: string): void {
  try {
    const raw = window.sessionStorage.getItem(DECLINED_REUSE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
    if (!list.includes(documentKey)) list.push(documentKey);
    window.sessionStorage.setItem(DECLINED_REUSE_KEY, JSON.stringify(list));
  } catch {
    // Sin sessionStorage disponible no hay nada que recordar: el banner
    // podria reaparecer, pero nunca es motivo para romper el flujo.
  }
}

/** Campos cuya etiqueta coincide con un valor ya guardado de otro documento. */
function matchingStoredValues(
  fields: readonly DetectedField[],
): Record<string, string> {
  const matches: Record<string, string> = {};
  for (const field of fields) {
    if (!field.label) continue;
    const value = bestMatchForKey(normalizeFieldLabel(field.label));
    if (value) matches[field.id] = value;
  }
  return matches;
}

/** Al menos un campo de texto tiene algo que empotrar. */
function hasFilledTextValue(
  fields: readonly DetectedField[],
  values: Record<string, string>,
): boolean {
  return fields.some((field) => isFieldFilled(field, values[field.id]));
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
  language: Language,
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
    const raw = options.textValues[field.id] ?? "";
    const value = embeddedValueFor(field, raw, language);
    if (!value) continue;
    placements.push({
      kind: "text",
      value,
      pageIndex: field.pageIndex,
      rect: field.rect,
      align: fieldTypeOf(field) === "checkbox" ? "center" : "left",
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
  const completionCertificateEnabled = useSignPdfFeatureFlag(
    "completionCertificate",
  );
  const [composerOpen, setComposerOpen] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  /** Lo rellena `ToolShell`: remata la ronda con el mismo procesado de siempre. */
  const runRef = useRef<(() => void) | null>(null);
  /** Lo rellena `ToolShell`: reinicia el flujo con un patch parcial de opciones. */
  const resetRef = useRef<
    ((patch?: Partial<SignToolOptions>) => void) | null
  >(null);
  /** Lo rellena `ToolShell`: carga un archivo (borrador/importacion) sin pasar por el dropzone. */
  const loadRef = useRef<
    ((files: File[], patch?: Partial<SignToolOptions>) => void) | null
  >(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const reusableTemplatesEnabled = useSignPdfFeatureFlag("reusableTemplates");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  /** Mensaje de la ultima accion de plantilla (exito, error o "N campos descartados"). Compartido entre guardar/aplicar: solo una accion de plantilla esta en marcha a la vez. */
  const [templateFeedback, setTemplateFeedback] = useState<string | null>(
    null,
  );
  /** Plantilla elegida en el sheet, esperando confirmacion porque ya hay disposicion cargada que se perderia. */
  const [pendingApplyTemplate, setPendingApplyTemplate] =
    useState<SignTemplate | null>(null);

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

  /**
   * Errores de "cargar sin pasar por el dropzone" (reanudar un borrador,
   * importar una configuracion): `ToolShell` no expone su propio
   * `setError` fuera de `renderMain`/`renderOptions` (solo se pintan
   * mientras hay archivo), y estas acciones tienen sentido tambien sin
   * ninguno cargado todavia -- de ahi este estado propio.
   */
  const [loadError, setLoadError] = useState<PdfErrorCode | null>(null);

  /** Valida como lo haria `FileDropzone`: un borrador/importacion no se salta esa puerta. */
  const validateLoadedFile = useCallback((file: File): boolean => {
    if (
      !matchesAccept(file, TOOL.accept, TOOL.extensions) ||
      file.size > MAX_SAFE_FILE_SIZE
    ) {
      setLoadError(file.size > MAX_SAFE_FILE_SIZE ? "tooLarge" : "invalidType");
      return false;
    }
    return true;
  }, []);

  const handleResumeDraft = useCallback(
    async (id: string) => {
      const loaded = await loadDraft(id);
      if (!loaded) {
        setLoadError("unknown");
        return;
      }
      const file = new File([loaded.bytes as BlobPart], loaded.meta.fileName, {
        type: "application/pdf",
      });
      if (!validateLoadedFile(file)) return;

      reserveSignerIds(loaded.meta.signers.map((signer) => signer.id));
      reserveFieldIds(loaded.meta.fields.map((field) => field.id));
      reserveTextFieldIds(loaded.meta.textFields.map((field) => field.id));

      loadRef.current?.([file], {
        mode: loaded.meta.mode,
        signature: loaded.meta.id,
        step: loaded.meta.step,
        signers: loaded.meta.signers,
        fields: loaded.meta.fields,
        captures: loaded.meta.captures,
        textFields: loaded.meta.textFields,
        textValues: loaded.meta.textValues,
        textFieldsDetectedFor: loaded.meta.textFieldsDetectedFor,
      });
      setLoadError(null);
      setDraftsOpen(false);
    },
    [validateLoadedFile],
  );

  const handleImportConfig = useCallback(
    async (zipFile: File) => {
      try {
        const { file, manifest } = await importSignConfig(zipFile);
        if (!validateLoadedFile(file)) return;
        const documentKey = await documentContentKey(file);

        reserveSignerIds(manifest.signers.map((signer) => signer.id));
        reserveFieldIds(manifest.fields.map((field) => field.id));
        reserveTextFieldIds(manifest.textFields.map((field) => field.id));

        loadRef.current?.([file], {
          mode: manifest.mode,
          signature: documentKey,
          step: "signers",
          signers: manifest.signers,
          fields: manifest.fields,
          captures: {},
          textFields: manifest.textFields,
          textValues: manifest.textValues,
          textFieldsDetectedFor: documentKey,
        });
        setLoadError(null);
      } catch (caught) {
        setLoadError(toPdfError(caught).code);
      }
    },
    [validateLoadedFile],
  );

  const handleExportConfig = useCallback(
    async (file: File, options: SignToolOptions) => {
      try {
        const manifest: Omit<SignConfigManifest, "version"> = {
          mode: options.mode,
          signers: options.signers,
          fields: options.fields,
          textFields: options.textFields,
          textValues: options.textValues,
        };
        const blob = await exportSignConfig(file, manifest);
        downloadBlob(blob, signConfigFilename(file.name));
        setLoadError(null);
      } catch (caught) {
        setLoadError(toPdfError(caught).code);
      }
    },
    [],
  );

  /**
   * Guarda la disposicion ACTUAL (firmantes + huecos + campos de texto,
   * sin valores) como plantilla con nombre, reutilizable en otro
   * documento. `pageCount` se resuelve del propio archivo en vez de
   * confiar en el `pageCount` de estado del componente: ese solo lo
   * alimenta `SignaturePlacer` (modo "solo yo"), nunca el flujo multi.
   */
  const handleSaveTemplate = useCallback(
    async (file: File, options: SignToolOptions, name: string) => {
      try {
        const pdf = await loadPdf(file);
        const result = saveTemplate({
          name,
          pageCount: pdf.getPageCount(),
          signers: options.signers,
          fields: options.fields,
          textFields: options.textFields,
        });
        if (result === "limit") {
          setTemplateFeedback(strings.saveTemplateLimitError);
          return;
        }
        if (result === "unavailable") {
          setTemplateFeedback(strings.saveTemplateUnavailableError);
          return;
        }
        setTemplateFeedback(strings.saveTemplateSuccess);
      } catch {
        setTemplateFeedback(strings.saveTemplateUnavailableError);
      }
    },
    [strings],
  );

  /**
   * Aplica una plantilla al documento YA cargado (nunca lo reemplaza):
   * ids siempre nuevos (los acuñadores, nunca los guardados en la
   * plantilla), y `textFieldsDetectedFor` fijado al `documentKey` actual
   * -- sin esto, el efecto de deteccion de `MultiFlow` pisaria en
   * silencio los campos de texto recien aplicados (mismo riesgo que ya
   * evita `handleImportConfig`).
   */
  const performApplyTemplate = useCallback(
    async (
      template: SignTemplate,
      file: File,
      setOptions: (patch: Partial<SignToolOptions>) => void,
    ) => {
      try {
        const pdf = await loadPdf(file);
        const documentKey = await documentContentKey(file);
        const instantiated = instantiateTemplate(template, {
          pageCount: pdf.getPageCount(),
          mintSignerId: nextSignerId,
          mintFieldId: nextFieldId,
          mintTextFieldId: nextTextFieldId,
        });
        if (!instantiated) {
          setTemplateFeedback(strings.applyTemplateNothingFits);
          setPendingApplyTemplate(null);
          return;
        }
        setOptions({
          signers: instantiated.signers,
          fields: instantiated.fields,
          textFields: instantiated.textFields,
          captures: {},
          textValues: {},
          activeSignerId: instantiated.signers[0]?.id ?? null,
          selectedFieldId: null,
          selectedTextFieldId: null,
          editingTextFieldId: null,
          textFieldsDetectedFor: documentKey,
          step: "fields",
        });
        setTemplateFeedback(
          instantiated.dropped > 0
            ? strings.applyTemplateDropped(instantiated.dropped)
            : null,
        );
        setTemplatesOpen(false);
        setPendingApplyTemplate(null);
      } catch (caught) {
        setPendingApplyTemplate(null);
        setLoadError(toPdfError(caught).code);
      }
    },
    [strings],
  );

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
        {
          placements: buildPlacements(options, documentKey, language),
          certificate: completionCertificateEnabled
            ? {
                signerNames: options.signers.map((signer) => signer.name),
                labels: {
                  title: strings.certificateTitle,
                  hashLabel: strings.certificateHashLabel,
                  timestampLabel: strings.certificateTimestampLabel,
                  signersLabel: strings.certificateSignersLabel,
                  noSignerName: strings.certificateNoSignerName,
                  disclaimer: strings.certificateDisclaimer,
                },
              }
            : undefined,
        },
        onProgress,
      );
      // Solo se guarda tras un empotrado con exito: si `signPdfMulti`
      // lanza, la linea de arriba corta antes de llegar aqui.
      recordFilledValues(options.textFields, options.textValues);

      const prefix = signerPrefixRef.current
        ? buildSignerFilenamePrefix(options.signers.map((signer) => signer.name))
        : null;
      const filename = prefix ? `${prefix}_${baseFilename}` : baseFilename;
      return { blob, filename };
    },
    [strings, language, completionCertificateEnabled],
  );

  return (
    <Fragment>
    <div className="mx-auto mb-4 flex w-full max-w-[1200px] flex-wrap items-center gap-2 px-4 md:px-6">
      <Button variant="ghost" size="sm" onClick={() => setDraftsOpen(true)}>
        {strings.draftsButton}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => importInputRef.current?.click()}
      >
        {strings.importConfigButton}
      </Button>
      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        onChange={(event) => {
          const zipFile = event.target.files?.[0];
          event.target.value = "";
          if (zipFile) void handleImportConfig(zipFile);
        }}
      />
      {loadError ? (
        <p role="alert" className="text-xs text-destructive">
          {t.tool.errors[loadError]}
        </p>
      ) : null}
    </div>
    <DraftsSheet
      open={draftsOpen}
      onClose={() => setDraftsOpen(false)}
      onResume={(id) => void handleResumeDraft(id)}
      strings={strings}
    />
    <ToolShell<SignToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      progressMessage={strings.progressMessage}
      runRef={runRef}
      resetRef={resetRef}
      loadRef={loadRef}
      renderDone={({ options }) =>
        options.mode === "multi" && options.signers.length > 0 ? (
          <SignAgainPrompt
            onAccept={() =>
              resetRef.current?.({
                mode: "multi",
                signers: options.signers,
                step: "signers",
              })
            }
            strings={strings}
          />
        ) : null
      }
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
      renderOptions={({ files, options, setOptions }) =>
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
            {files[0] ? (
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                onClick={() => void handleExportConfig(files[0], options)}
              >
                {strings.exportConfigButton}
              </Button>
            ) : null}

            {reusableTemplatesEnabled ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth
                  onClick={() => {
                    setTemplateFeedback(null);
                    setTemplatesOpen(true);
                  }}
                >
                  {strings.templatesButton}
                </Button>
                {files[0] &&
                (options.signers.length > 0 ||
                  options.fields.length > 0 ||
                  options.textFields.length > 0) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onClick={() => {
                      setTemplateName("");
                      setTemplateFeedback(null);
                      setSaveTemplateOpen(true);
                    }}
                  >
                    {strings.saveAsTemplateButton}
                  </Button>
                ) : null}

                <TemplatesSheet
                  open={templatesOpen}
                  onClose={() => setTemplatesOpen(false)}
                  onApply={(template) => {
                    const hasExisting =
                      options.signers.length > 0 ||
                      options.fields.length > 0 ||
                      options.textFields.length > 0;
                    if (!files[0]) return;
                    if (hasExisting) {
                      setPendingApplyTemplate(template);
                    } else {
                      void performApplyTemplate(template, files[0], setOptions);
                    }
                  }}
                  strings={strings}
                />

                <ConfirmSheet
                  open={pendingApplyTemplate !== null}
                  onClose={() => setPendingApplyTemplate(null)}
                  onConfirm={() => {
                    if (pendingApplyTemplate && files[0]) {
                      void performApplyTemplate(
                        pendingApplyTemplate,
                        files[0],
                        setOptions,
                      );
                    }
                  }}
                  title={strings.applyTemplateConfirmTitle}
                  body={strings.applyTemplateConfirmBody}
                  confirmLabel={strings.applyTemplateConfirm}
                  cancelLabel={strings.confirmCancel}
                  closeLabel={strings.confirmClose}
                />

                <Sheet
                  open={saveTemplateOpen}
                  onClose={() => setSaveTemplateOpen(false)}
                  title={strings.saveTemplateTitle}
                  closeLabel={t.common.close}
                >
                  <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
                    {strings.saveTemplateBody}
                  </p>
                  <label
                    htmlFor="sign-pdf-template-name"
                    className="block pb-1 text-xs font-medium text-foreground"
                  >
                    {strings.saveTemplateNameLabel}
                  </label>
                  <input
                    id="sign-pdf-template-name"
                    type="text"
                    value={templateName}
                    maxLength={TEMPLATE_NAME_MAX}
                    placeholder={strings.saveTemplateNamePlaceholder}
                    onChange={(event) => setTemplateName(event.target.value)}
                    className="mb-3 h-10 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60"
                  />
                  {templateFeedback ? (
                    <p role="status" className="pb-2 text-xs text-muted-foreground">
                      {templateFeedback}
                    </p>
                  ) : null}
                  <Button
                    size="md"
                    fullWidth
                    disabled={templateName.trim().length === 0}
                    onClick={() => {
                      if (!files[0]) return;
                      void handleSaveTemplate(files[0], options, templateName);
                    }}
                  >
                    {strings.saveTemplateConfirm}
                  </Button>
                </Sheet>
              </>
            ) : null}

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

type SignAgainPromptProps = {
  onAccept: () => void;
  strings: SignStrings;
};

/**
 * Aparece tras descargar, solo en modo "varios firmantes" (el unico que
 * tiene un roster que valga la pena reutilizar). Un unico boton, sin
 * aceptar/declinar: a diferencia del prompt de prefijo (que decide algo
 * sobre el archivo que se acaba de escribir), aqui no aceptar es
 * simplemente no tocarlo -- la persona ya tiene "Empezar de nuevo" al
 * lado si quiere un documento en blanco.
 */
function SignAgainPrompt({ onAccept, strings }: SignAgainPromptProps) {
  return (
    <div className="glass rounded-ios mt-6 flex flex-col items-center gap-3 p-5 text-center">
      <h3 className="text-base font-black tracking-[-0.02em] text-foreground">
        {strings.signAgainTitle}
      </h3>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        {strings.signAgainBody}
      </p>
      <Button size="md" onClick={onAccept}>
        {strings.signAgainAccept}
      </Button>
    </div>
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
  const keyboardNavEnabled = useSignPdfFeatureFlag("keyboardNav");
  const fieldsCompleteNoticeEnabled = useSignPdfFeatureFlag(
    "fieldsCompleteNotice",
  );
  const undoDeleteEnabled = useSignPdfFeatureFlag("undoDelete");
  const richFieldTypesEnabled = useSignPdfFeatureFlag("richFieldTypes");
  const pinchZoomEnabled = useSignPdfFeatureFlag("pinchZoom");

  /**
   * "Deshacer" al borrar un firmante: unico y propio (nunca comparte
   * hueco con el de un campo de texto/hueco de imagen -- `SignerManager`
   * y `FieldPlacer`/`TextFieldPlacer` nunca estan montados a la vez, asi
   * que no hace falta coordinarlos). Restaura no solo al firmante sino
   * tambien sus huecos y su captura -- borrarlo hoy se los lleva a los
   * tres en silencio, sin ningun aviso.
   */
  const [pendingSignerUndo, setPendingSignerUndo] = useState<{
    signer: Signer;
    index: number;
    fields: SignatureField[];
    capture: CaptureMap[string] | undefined;
    wasActive: boolean;
    documentKey: string;
  } | null>(null);

  useEffect(() => {
    if (!pendingSignerUndo) return;
    const timer = window.setTimeout(() => setPendingSignerUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [pendingSignerUndo]);

  /**
   * Derivado en render, no limpiado con un `setState` dentro de un
   * efecto (eso encadena renders sin necesidad): deja de tener sentido
   * en cuanto cambia el documento, se sale del paso de firmantes, o ya
   * no cabe un firmante mas sin que dos compartan color al deshacer
   * (`signerColorAt` da la vuelta modulo el numero de colores). El
   * estado de abajo puede seguir "vivo" un rato de mas -- no importa,
   * nunca se lee ni se muestra fuera de esta variable derivada.
   */
  const visiblePendingSignerUndo =
    pendingSignerUndo &&
    pendingSignerUndo.documentKey === options.signature &&
    options.step === "signers" &&
    options.signers.length < SIGNER_COLORS.length
      ? pendingSignerUndo
      : null;

  const restorePendingSignerUndo = () => {
    if (!visiblePendingSignerUndo) return;
    const snap = visiblePendingSignerUndo;
    const next = [...options.signers];
    next.splice(Math.min(snap.index, next.length), 0, snap.signer);
    setOptions({
      signers: recolor(next),
      fields: [...options.fields, ...snap.fields],
      captures: snap.capture
        ? { ...options.captures, [snap.signer.id]: snap.capture }
        : options.captures,
      ...(snap.wasActive ? { activeSignerId: snap.signer.id } : {}),
    });
    setPendingSignerUndo(null);
  };

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
   *
   * Sembrado con `options.textFieldsDetectedFor` (solo el valor del
   * PRIMER render, `useRef` no lo vuelve a leer): un borrador restaurado
   * o una configuracion importada ya trae ese campo resuelto, y sin este
   * sembrado la deteccion real correria igual sobre el documento recien
   * cargado en cuanto `documentKey` confirme la huella, pisando en
   * silencio los campos ya restaurados.
   */
  const detectedForRef = useRef<string | null>(options.textFieldsDetectedFor);

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
        editingTextFieldId: null,
        textFieldsDetectedFor: null,
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
   *
   * `detectedForRef` arranca sembrado con `options.textFieldsDetectedFor`
   * (ver el comentario junto a su declaracion): un borrador restaurado o
   * una configuracion importada ya trae `textFields` resuelto, y sin ese
   * sembrado la deteccion real correria de todos modos sobre el documento
   * recien cargado y pisaria en silencio los campos restaurados,
   * incluidos los anadidos a mano que la deteccion nunca podria
   * reconstruir por si sola.
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
        setOptions({ textFields: detected, textFieldsDetectedFor: documentKey });
        if (documentKey && hasDeclinedReuse(documentKey)) return;
        const matches = matchingStoredValues(detected);
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

  /**
   * Cachea los bytes leidos del `File` actual: se necesitan en cada
   * autoguardado (por si hace falta escribirlos, la primera vez que se ve
   * este `documentKey`), pero releerlos en cada disparo del debounce
   * seria releer un PDF potencialmente grande una y otra vez sin
   * necesidad -- `signDrafts.ts` ya evita reescribirlos si ya estan.
   */
  const fileBytesCacheRef = useRef<{ file: File; bytes: Promise<Uint8Array> } | null>(
    null,
  );
  const getFileBytes = (target: File): Promise<Uint8Array> => {
    if (fileBytesCacheRef.current?.file !== target) {
      fileBytesCacheRef.current = {
        file: target,
        bytes: target.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
      };
    }
    return fileBytesCacheRef.current.bytes;
  };

  /**
   * Generacion del autoguardado: se incrementa en cada pasada de este
   * efecto. Un volcado tardio (ver mas abajo) que todavia esta leyendo
   * los bytes del PDF puede completarse DESPUES de que una transicion
   * mas nueva ya decidiera otra cosa (por ejemplo un borrado) --
   * resucitando en IndexedDB un estado que el usuario ya dejo atras. Se
   * detecto de verdad asi, escribiendo un test que reproduce borrar el
   * ultimo firmante y desmontar de inmediato (limitacion 4.3 del
   * backlog), no es hipotetico. Cada volcado comprueba, justo antes de
   * escribir de verdad (no al principio: el salto asincrono de por
   * medio es lo que importa), si sigue siendo la generacion vigente; si
   * no, calla -- la generacion que lo reemplazo ya se encarga de dejar
   * el estado correcto.
   */
  const autosaveGenerationRef = useRef(0);

  /**
   * Documentos para los que este componente ya escribio (o esta a punto
   * de escribir) un borrador real -- para saber si un borrado hace
   * falta. Sin esto, la primerisima vez que se carga un archivo (antes
   * de tocar nada, sin progreso) programaria un `deleteDraft` sobre un
   * `id` que nunca se guardo: inofensivo en si mismo, pero un viaje de
   * ida y vuelta a IndexedDB de mas en el caso, con mucha diferencia,
   * mas comun (abrir el documento y no hacer nada todavia).
   */
  const hasSavedDraftRef = useRef<Set<string>>(new Set());

  /**
   * Autoguardado del borrador con debounce: espera ~800ms de calma tras
   * el ultimo cambio antes de escribir. El `id`/estado que se guarda es
   * el vigente en el momento en que se AGENDA el guardado (capturado en
   * el cierre del efecto), no el que haya cuando el timer dispare: si el
   * documento cambia a medio camino, el guardado tardio del documento
   * anterior no debe escribirse bajo el `id` del nuevo. Si el efecto se
   * limpia antes de que el timer dispare (documento distinto, o el
   * componente se desmonta) se vuelca el guardado pendiente de
   * inmediato en vez de perderlo sin mas.
   *
   * Sin progreso (ni firmante, ni hueco, ni valor de texto) no hay nada
   * que guardar -- pero si YA existia un borrador de esta sesion porque
   * el usuario acaba de borrar el ultimo firmante/hueco/valor que
   * quedaba, hay que reflejarlo borrando ese borrador tambien, con el
   * mismo mecanismo de "volcar al limpiar" que el guardado. Saltarse
   * este caso (como hacia antes un `if (!hasProgress) return;` temprano,
   * sin dejar ningun volcado pendiente) deja el ultimo guardado CON
   * progreso como el estado persistido para siempre: lo borrado
   * "resucita" al reanudar, en vez de reflejar la lista vacia que el
   * usuario ve en pantalla.
   */
  useEffect(() => {
    if (!file || !documentKey) return;
    autosaveGenerationRef.current += 1;
    const myGeneration = autosaveGenerationRef.current;
    const hasProgress =
      options.signers.length > 0 ||
      options.fields.length > 0 ||
      options.textFields.length > 0 ||
      Object.keys(options.textValues).length > 0;

    const targetId = documentKey;
    if (!hasProgress && !hasSavedDraftRef.current.has(targetId)) return;

    // Marcado de inmediato (no cuando el guardado/borrado asincrono
    // termina): una transicion posterior, incluso muy rapida, tiene que
    // ver ya la intencion vigente, no la del ultimo guardado que aterrizo.
    if (hasProgress) {
      hasSavedDraftRef.current.add(targetId);
    } else {
      hasSavedDraftRef.current.delete(targetId);
    }

    const snapshot: Omit<SaveDraftParams, "fileBytes"> | null = hasProgress
      ? {
          id: targetId,
          fileName: file.name,
          manifest: {
            mode: options.mode,
            signers: options.signers,
            fields: options.fields,
            textFields: options.textFields,
            textValues: options.textValues,
          },
          step: options.step,
          captures: options.captures,
          textFieldsDetectedFor: options.textFieldsDetectedFor,
        }
      : null;
    const targetFile = file;

    let fired = false;
    const flush = () => {
      fired = true;
      if (snapshot) {
        void getFileBytes(targetFile).then((fileBytes) => {
          if (autosaveGenerationRef.current !== myGeneration) return;
          return saveDraft({ ...snapshot, fileBytes });
        });
      } else {
        void Promise.resolve().then(() => {
          if (autosaveGenerationRef.current !== myGeneration) return;
          return deleteDraft(targetId);
        });
      }
    };
    const timer = setTimeout(flush, 800);
    return () => {
      clearTimeout(timer);
      if (!fired) flush();
    };
  }, [
    file,
    documentKey,
    options.mode,
    options.signers,
    options.fields,
    options.textFields,
    options.textValues,
    options.step,
    options.captures,
    options.textFieldsDetectedFor,
  ]);

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

  const declineReuse = () => {
    if (documentKey) markDeclinedReuse(documentKey);
    setReuseMatches(null);
  };

  const position = MULTI_STEPS.indexOf(options.step);
  const nextStep = MULTI_STEPS[position + 1];
  const previousStep = MULTI_STEPS[position - 1];

  /**
   * Aviso NO bloqueante (Recomendacion #2): se calcula aqui, no solo en
   * `FieldFormPanel`, porque tiene que sobrevivir a salir del paso
   * "text" -- es el ultimo momento antes de firmar o descargar en que
   * el usuario puede verlo.
   */
  const textFieldsMissing = options.textFields.filter(
    (field) => !isFieldFilled(field, options.textValues[field.id]),
  ).length;
  const showPendingTextFieldsNotice =
    fieldsCompleteNoticeEnabled &&
    options.step === "text" &&
    textFieldsMissing > 0;

  const fieldCounts: Record<string, number> = {};
  for (const field of options.fields) {
    fieldCounts[field.signerId] = (fieldCounts[field.signerId] ?? 0) + 1;
  }

  /**
   * Al quitar a un firmante desaparecen tambien sus huecos y su trazo:
   * dejarlos sueltos convertiria el documento en algo imposible de
   * completar. `onSignersChange` tambien corre en un renombrado o un
   * alta (mismo callback para las tres cosas en `SignerManager`) -- se
   * detecta que hubo un BORRADO comparando los ids de antes contra los
   * de ahora; en un renombrado/alta esa resta siempre sale vacia.
   */
  const onSignersChange = (signers: Signer[]) => {
    const alive = new Set(signers.map((signer) => signer.id));
    const fields = options.fields.filter((field) => alive.has(field.signerId));
    const captures: CaptureMap = {};
    for (const [id, capture] of Object.entries(options.captures)) {
      if (alive.has(id)) captures[id] = capture;
    }

    if (undoDeleteEnabled) {
      const removedId = options.signers.find((s) => !alive.has(s.id))?.id;
      if (removedId) {
        const index = options.signers.findIndex((s) => s.id === removedId);
        setPendingSignerUndo({
          signer: options.signers[index],
          index,
          fields: options.fields.filter((field) => field.signerId === removedId),
          capture: options.captures[removedId],
          wasActive: options.activeSignerId === removedId,
          documentKey: options.signature,
        });
      }
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

      <PrivacyNotice strings={strings} />

      {options.step === "signers" ? (
        <>
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
          {visiblePendingSignerUndo ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
            >
              <span className="text-xs text-muted-foreground">
                {strings.signerDeletedNotice}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={restorePendingSignerUndo}
              >
                {strings.undoRemoveSigner}
              </Button>
            </div>
          ) : null}
        </>
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
          undoDeleteEnabled={undoDeleteEnabled}
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
            <div className="glass rounded-ios flex flex-col gap-3 p-4">
              <p className="text-sm text-foreground">{strings.reuseValuesPrompt}</p>
              {/*
               * El valor se muestra explicitamente antes de aceptar: el
               * historial ahora vive en localStorage (no se olvida al
               * cerrar la pestaña), asi que aceptar "a ciegas" arriesga
               * traer el dato de OTRO cliente si dos documentos usan la
               * misma etiqueta de campo (ej. "Nombre completo").
               */}
              <ul className="space-y-1">
                {Object.entries(reuseMatches).map(([fieldId, value]) => {
                  const field = options.textFields.find(
                    (candidate) => candidate.id === fieldId,
                  );
                  return (
                    <li
                      key={fieldId}
                      className="flex items-baseline gap-2 text-xs text-muted-foreground"
                    >
                      <span className="shrink-0">{field?.label ?? fieldId}:</span>
                      <span className="truncate text-foreground">{value}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={acceptReuse}>
                  {strings.reuseValuesAccept}
                </Button>
                <Button variant="ghost" size="sm" onClick={declineReuse}>
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
            editingId={options.editingTextFieldId}
            onEditingIdChange={(editingTextFieldId) =>
              setOptions({ editingTextFieldId })
            }
            strings={strings}
            keyboardNavEnabled={keyboardNavEnabled}
            undoDeleteEnabled={undoDeleteEnabled}
            richFieldTypesEnabled={richFieldTypesEnabled}
            pinchZoomEnabled={pinchZoomEnabled}
          />

          <FieldFormPanel
            fields={options.textFields}
            values={options.textValues}
            onJumpToField={(field) =>
              setOptions({
                selectedTextFieldId: field.id,
                textFieldPageIndex: field.pageIndex,
                editingTextFieldId: field.id,
              })
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
          {fieldsCompleteNoticeEnabled && textFieldsMissing > 0 ? (
            <p
              role="status"
              className="mt-2 text-xs leading-relaxed text-amber-400"
            >
              {strings.pendingTextFieldsWarning(textFieldsMissing)}
            </p>
          ) : null}
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

      {showPendingTextFieldsNotice ? (
        <p role="status" className="text-xs leading-relaxed text-amber-400">
          {strings.pendingTextFieldsWarning(textFieldsMissing)}
        </p>
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
