import JSZip from "jszip";
import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  toPdfError,
  withSuffix,
  type NormalizedRect,
} from "@/lib/pdf/core";
import type { DetectedField, FieldConfidence, FieldSource } from "@/lib/pdf/detectFields";
import type { Signer, SignatureField, SignatureFieldType } from "@/lib/pdf/sign";
import type { SignMode } from "@/app/sign-pdf/SignToolClient";

/**
 * Configuracion de firma exportable/importable: la disposicion de
 * firmantes y huecos sobre un documento, sin firmar todavia. Comparte
 * forma con el manifiesto de los borradores locales (`signDrafts.ts`),
 * que ademas le suma lo que solo tiene sentido guardar en ESTE
 * dispositivo (capturas de firma, paso actual).
 */
export type SignConfigManifest = {
  version: 1;
  mode: SignMode;
  signers: Signer[];
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
};

const MANIFEST_FILENAME = "manifest.json";
const CONFIG_VERSION = 1;

/** Nombre del PDF dentro del zip: fijo, no depende del nombre real del archivo. */
const PDF_ENTRY_NAME = "documento.pdf";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Tolerante a un margen pequeño (coordenadas ya clampeadas pueden caer
 * justo en el borde por redondeo de punto flotante), pero rechaza
 * cualquier cosa que no sea, con margen, una fraccion de pagina 0..1.
 */
function isPlausibleUnit(value: number): boolean {
  return value >= -0.01 && value <= 1.01;
}

function isValidRect(value: unknown): value is NormalizedRect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    isPlausibleUnit(rect.x) &&
    isPlausibleUnit(rect.y) &&
    rect.width > 0 &&
    rect.height > 0 &&
    isPlausibleUnit(rect.x + rect.width) &&
    isPlausibleUnit(rect.y + rect.height)
  );
}

const SIGNATURE_FIELD_TYPE_VALUES: readonly SignatureFieldType[] = [
  "signature",
  "initials",
];

function isValidSigner(value: unknown): value is Signer {
  if (typeof value !== "object" || value === null) return false;
  const signer = value as Record<string, unknown>;
  return (
    typeof signer.id === "string" &&
    typeof signer.name === "string" &&
    typeof signer.color === "string"
  );
}

function isValidSignatureField(value: unknown): value is SignatureField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  return (
    typeof field.id === "string" &&
    typeof field.signerId === "string" &&
    Number.isInteger(field.pageIndex) &&
    (field.pageIndex as number) >= 0 &&
    typeof field.type === "string" &&
    SIGNATURE_FIELD_TYPE_VALUES.includes(field.type as SignatureFieldType) &&
    isValidRect(field.rect)
  );
}

const FIELD_SOURCE_VALUES: readonly FieldSource[] = [
  "acroform",
  "heuristic-vector",
  "heuristic-raster",
  "manual",
];
const FIELD_CONFIDENCE_VALUES: readonly FieldConfidence[] = [
  "high",
  "medium",
  "low",
];

function isValidDetectedField(value: unknown): value is DetectedField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  if (
    typeof field.id !== "string" ||
    !Number.isInteger(field.pageIndex) ||
    (field.pageIndex as number) < 0 ||
    !isValidRect(field.rect) ||
    typeof field.source !== "string" ||
    !FIELD_SOURCE_VALUES.includes(field.source as FieldSource) ||
    typeof field.confidence !== "string" ||
    !FIELD_CONFIDENCE_VALUES.includes(field.confidence as FieldConfidence)
  ) {
    return false;
  }
  return field.label === undefined || typeof field.label === "string";
}

function isValidTextValues(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string",
  );
}

/**
 * Type guard escrito a mano (mismo criterio que `recent.ts`/`core.ts`:
 * sin libreria de validacion de esquemas nueva). `version` decide primero:
 * un formato futuro se rechaza con honestidad en vez de leerlo a medias.
 */
export function isSignConfigManifest(
  value: unknown,
): value is SignConfigManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== CONFIG_VERSION) return false;
  if (manifest.mode !== "single" && manifest.mode !== "multi") return false;
  if (!Array.isArray(manifest.signers) || !manifest.signers.every(isValidSigner)) {
    return false;
  }
  if (!Array.isArray(manifest.fields) || !manifest.fields.every(isValidSignatureField)) {
    return false;
  }
  if (
    !Array.isArray(manifest.textFields) ||
    !manifest.textFields.every(isValidDetectedField)
  ) {
    return false;
  }
  return isValidTextValues(manifest.textValues);
}

/**
 * Empaqueta el PDF original (bytes explicitos, mismo criterio que
 * `pdfsToZip.ts`) + el manifiesto. Nunca incluye capturas de firma: el
 * documento todavia no esta firmado en este punto del flujo.
 */
export async function exportSignConfig(
  file: File,
  manifest: Omit<SignConfigManifest, "version">,
): Promise<Blob> {
  try {
    const zip = new JSZip();
    zip.file(PDF_ENTRY_NAME, new Uint8Array(await file.arrayBuffer()));
    zip.file(
      MANIFEST_FILENAME,
      JSON.stringify({ ...manifest, version: CONFIG_VERSION }),
    );
    return await zip.generateAsync({ type: "blob" });
  } catch (error) {
    throw toPdfError(error);
  }
}

/** Nombre de archivo sugerido para la configuracion exportada. */
export function signConfigFilename(originalName: string): string {
  return withSuffix(originalName, "config", "zip");
}

export type ImportedSignConfig = {
  file: File;
  manifest: SignConfigManifest;
};

/**
 * Lee un zip de configuracion. Antes de confiar en nada, comprueba que
 * el propio zip no sea desproporcionado (pocas entradas, PDF dentro del
 * limite habitual) -- un zip ajeno descargado de cualquier lado puede
 * venir manipulado, no solo generado por esta misma herramienta.
 */
export async function importSignConfig(
  zipFile: File,
): Promise<ImportedSignConfig> {
  try {
    // Bytes explicitos, no el `File` tal cual: `JSZip.loadAsync` resuelve
    // un Blob/File real via `FileReader`, que solo existe en el navegador
    // (mismo limite ya documentado en `pdfsToZip.ts`).
    const zip = await JSZip.loadAsync(await zipFile.arrayBuffer()).catch(
      () => {
        throw new PdfError("invalidConfig");
      },
    );
    const entries = Object.keys(zip.files);
    if (entries.length === 0 || entries.length > 5) {
      throw new PdfError("invalidConfig");
    }

    const manifestEntry = zip.file(MANIFEST_FILENAME);
    const pdfEntry = zip.file(PDF_ENTRY_NAME);
    if (!manifestEntry || !pdfEntry) {
      throw new PdfError("invalidConfig");
    }

    const manifestText = await manifestEntry.async("text");
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      throw new PdfError("invalidConfig");
    }
    if (!isSignConfigManifest(parsed)) {
      throw new PdfError("invalidConfig");
    }

    const pdfBytes = await pdfEntry.async("uint8array");
    if (pdfBytes.byteLength === 0 || pdfBytes.byteLength > MAX_SAFE_FILE_SIZE) {
      throw new PdfError("invalidConfig");
    }
    // Cabecera real, no la extension del nombre de entrada (fija, no la
    // controla quien importa): un zip manipulado podria meter cualquier
    // cosa bajo el nombre `documento.pdf`.
    const header = new TextDecoder("ascii").decode(pdfBytes.slice(0, 5));
    if (header !== "%PDF-") {
      throw new PdfError("invalidConfig");
    }

    const file = new File([pdfBytes as BlobPart], PDF_ENTRY_NAME, {
      type: "application/pdf",
    });
    return { file, manifest: parsed };
  } catch (error) {
    throw toPdfError(error);
  }
}
