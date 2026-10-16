import type JSZip from "jszip";
import { loadJSZip } from "@/lib/pdf/lazyZip";
import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  toPdfError,
  withSuffix,
  type NormalizedRect,
} from "@/lib/pdf/core";
import {
  DETECTED_FIELD_TYPES,
  type DetectedField,
  type DetectedFieldType,
  type FieldConfidence,
  type FieldSource,
} from "@/lib/pdf/detectFields";
import type { Signer, SignatureField, SignatureFieldType } from "@/lib/pdf/sign";
import type { SignMode } from "@/app/sign-pdf/SignToolClient";
import type { SignMode as BlockSignMode, SignerBlock } from "@/app/sign-pdf/docSet";
import {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_TOTAL_BYTES,
} from "@/app/sign-pdf/signLimits";
import { blockGroups } from "@/app/sign-pdf/assignment";
import { DEFAULT_COPIES, isValidCopies, normalizeCopies } from "@/lib/pdf/signCopies";

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
/** Version de la configuracion con VARIOS documentos (`documents[]`). */
export const CONFIG_VERSION_MULTI = 2;
/**
 * Version 3 (Firma agil, U1.1): la v2 mas las COPIAS de cada documento (`documents[].copies`, siempre presente) y el
 * grupo de cada bloque (`blocks[].group`, y `groupName` si tiene nombre propio). Se ESCRIBE solo cuando hay algo que la
 * v1/v2 no sabe decir (alguna copia o algun nombre de grupo); si no, se escribe el formato de siempre, que cualquier
 * version anterior de la herramienta sigue abriendo. Se LEE siempre, igual que la v1 y la v2.
 */
export const CONFIG_VERSION_GROUPS = 3;

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

/** Exportado: `signTemplates.ts` valida rects con el mismo criterio, sin duplicarlo. */
export function isValidRect(value: unknown): value is NormalizedRect {
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
  // `type` es opcional (ausente = "text", ver `fieldTypeOf`): un export
  // de antes de que este campo existiera sigue siendo valido sin tocar
  // `CONFIG_VERSION`. Si esta presente, tiene que ser uno de los 4
  // tipos conocidos -- un zip manipulado no debe poder colar un string
  // cualquiera hasta el switch de render.
  if (
    field.type !== undefined &&
    (typeof field.type !== "string" ||
      !DETECTED_FIELD_TYPES.includes(field.type as DetectedFieldType))
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
    const Zip = await loadJSZip();
    const zip = new Zip();
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
    const Zip = await loadJSZip();
    const zip = await Zip.loadAsync(await zipFile.arrayBuffer()).catch(
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

/* ------------------------------------------------------------------ *
 * Configuracion v2: varios documentos (Wave 4 · U5)
 * ------------------------------------------------------------------ */

/** Alcance de un bloque en la configuracion: SIN trazos ni sellos, nunca llevan firmas. */
export type SignConfigBlock = {
  id: string;
  signerId: string;
  /** Ids de documento del propio manifiesto (`documents[].id`). */
  appliesTo: string[];
  auto: boolean;
  /** v3: letra del grupo de firma del firmante («A», «B»...), la que da `blockGroups`. Informativa: se vuelve a derivar. */
  group?: string;
  /** v3: nombre visible del grupo si el usuario le puso uno propio. */
  groupName?: string;
};

export type SignConfigDocument = {
  /** Id dentro del manifiesto (`doc-1`...), no el `DocId` vivo. */
  id: string;
  /** Ruta de la entrada del zip: siempre `documentos/NN.pdf`. */
  entry: string;
  /** Nombre original del archivo. */
  name: string;
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  /** v3: copias que se entregan (1..5). Ausente en la v2 (= 1). */
  copies?: number;
};

export type SignConfigManifestV2 = {
  version: 2;
  mode: SignMode;
  signMode: BlockSignMode;
  signers: Signer[];
  blocks: SignConfigBlock[];
  documents: SignConfigDocument[];
};

/** v3: igual que la v2, con `copies` en cada documento y `group` en los bloques. */
export type SignConfigManifestV3 = Omit<SignConfigManifestV2, "version"> & {
  version: 3;
};

/** Entrada del zip del documento `index` (0-based): `documentos/01.pdf`. */
export function configDocumentEntry(index: number): string {
  return `documentos/${String(index + 1).padStart(2, "0")}.pdf`;
}

const MANIFEST_TEXT_LIMIT = 8 * 1024 * 1024;
const DOCUMENT_NAME_MAX = 255;
/** Nombre visible de un grupo: corto, como el de un firmante. */
const GROUP_NAME_MAX = 60;
/** Letra del grupo: `A`..`Z`, y `AA`... si alguna vez hiciera falta. */
const GROUP_ID_PATTERN = /^[A-Z]{1,3}$/;

function isValidConfigBlock(value: unknown, withGroups = false): value is SignConfigBlock {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Record<string, unknown>;
  if (
    !(
      typeof block.id === "string" &&
      typeof block.signerId === "string" &&
      typeof block.auto === "boolean" &&
      Array.isArray(block.appliesTo) &&
      block.appliesTo.length > 0 &&
      block.appliesTo.every((id) => typeof id === "string")
    )
  ) {
    return false;
  }
  // Los campos de grupo solo se leen en la v3; en la v2 no existen y, como siempre, lo desconocido se ignora.
  if (!withGroups) return true;
  if (block.group !== undefined && !(typeof block.group === "string" && GROUP_ID_PATTERN.test(block.group))) {
    return false;
  }
  return (
    block.groupName === undefined ||
    (typeof block.groupName === "string" && block.groupName.length <= GROUP_NAME_MAX)
  );
}

function isValidConfigDocument(
  value: unknown,
  index: number,
  withCopies = false,
): value is SignConfigDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  // `copies` es obligatoria en la v3 (es lo que distingue una v3 de una v2 con la version cambiada); en la v2 no existe.
  if (withCopies && !isValidCopies(doc.copies)) return false;
  return (
    typeof doc.id === "string" &&
    doc.entry === configDocumentEntry(index) &&
    typeof doc.name === "string" &&
    doc.name.length <= DOCUMENT_NAME_MAX &&
    Array.isArray(doc.fields) &&
    doc.fields.every(isValidSignatureField) &&
    Array.isArray(doc.textFields) &&
    doc.textFields.every(isValidDetectedField) &&
    isValidTextValues(doc.textValues)
  );
}

/**
 * Type guard de la configuracion v2. Estricto: las rutas de entrada son
 * EXACTAMENTE `documentos/NN.pdf` en orden (ni `..`, ni rutas absolutas, ni
 * nombres repetidos), los ids de documento no se repiten y todo bloque apunta
 * a firmantes y documentos que existen. NO limita cuantos firmantes trae
 * (datos heredados con mas de 2 se importan intactos: solo el alta esta
 * limitada).
 */
export function isSignConfigManifestV2(
  value: unknown,
): value is SignConfigManifestV2 {
  return isMultiManifest(value, CONFIG_VERSION_MULTI, false);
}

/**
 * Type guard de la configuracion v3: lo mismo que la v2 y ademas `copies` valida (1..5) en TODOS los documentos y, si un
 * bloque trae `group`, una letra de grupo (`groupName`: texto corto). Una v2 con la version cambiada a 3 NO pasa (le falta
 * `copies`): una version que esta herramienta no entiende se rechaza, no se lee a medias.
 */
export function isSignConfigManifestV3(
  value: unknown,
): value is SignConfigManifestV3 {
  return isMultiManifest(value, CONFIG_VERSION_GROUPS, true);
}

function isMultiManifest(value: unknown, version: number, v3: boolean): boolean {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== version) return false;
  if (manifest.mode !== "single" && manifest.mode !== "multi") return false;
  if (manifest.signMode !== "same" && manifest.signMode !== "independent") {
    return false;
  }
  if (!Array.isArray(manifest.signers) || !manifest.signers.every(isValidSigner)) {
    return false;
  }
  if (
    !Array.isArray(manifest.documents) ||
    manifest.documents.length === 0 ||
    manifest.documents.length > MAX_DOCUMENTS ||
    !manifest.documents.every((doc, index) => isValidConfigDocument(doc, index, v3))
  ) {
    return false;
  }
  const documents = manifest.documents as SignConfigDocument[];
  const docIds = new Set(documents.map((doc) => doc.id));
  if (docIds.size !== documents.length) return false;
  if (
    !Array.isArray(manifest.blocks) ||
    !manifest.blocks.every((block) => isValidConfigBlock(block, v3))
  ) {
    return false;
  }
  const signerIds = new Set((manifest.signers as Signer[]).map((signer) => signer.id));
  return (manifest.blocks as SignConfigBlock[]).every(
    (block) =>
      signerIds.has(block.signerId) && block.appliesTo.every((id) => docIds.has(id)),
  );
}

/** Un documento a exportar: el archivo y su estado. */
export type ExportConfigDocument = {
  /** `DocId` vivo (para traducir el alcance de los bloques). */
  id: string;
  file: File;
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  /** Copias que se entregan (1..5); ausente = 1. Con alguna mayor que 1 se escribe la v3. */
  copies?: number;
};

export type ExportConfigSetManifest = {
  mode: SignMode;
  signMode: BlockSignMode;
  signers: Signer[];
  /** Los bloques de la sesion: se exportan SIN trazos ni sellos. */
  blocks: readonly SignerBlock[];
  /**
   * Nombre propio de un grupo de firma, por id de BLOQUE vivo. Con alguno se escribe la v3 (la v2 no tiene donde
   * guardarlo). Los vacios o con solo espacios se descartan y los largos se recortan.
   */
  groupNames?: Readonly<Record<string, string>>;
};

/**
 * Exporta la configuracion de una ronda. Con UN documento escribe la v1 de
 * siempre (byte a byte el mismo formato); con varios, la v2: un PDF por
 * documento bajo `documentos/NN.pdf` + `manifest.json`, con el alcance de los
 * bloques pero nunca los trazos (la configuracion describe la disposicion, no
 * las firmas). El zip contiene los documentos: quien lo reciba los tiene.
 *
 * Firma agil (U1.1): si algun documento tiene mas de una copia o algun grupo tiene
 * nombre propio (`groupNames`), escribe la v3 (con UN documento tambien: la v1 no
 * guarda copias). La v3 anade `copies` a cada documento y `group` a cada bloque. Sin
 * nada de eso se sigue escribiendo la v1/v2, que versiones anteriores abren.
 */
export async function exportSignConfigSet(
  documents: readonly ExportConfigDocument[],
  manifest: ExportConfigSetManifest,
): Promise<Blob> {
  try {
    if (documents.length === 0) throw new PdfError("empty");
    const groupNames = cleanGroupNames(manifest.groupNames);
    const needsV3 =
      documents.some((doc) => normalizeCopies(doc.copies) > DEFAULT_COPIES) ||
      Object.keys(groupNames).length > 0;
    if (documents.length === 1 && !needsV3) {
      const only = documents[0];
      return await exportSignConfig(only.file, {
        mode: manifest.mode,
        signers: manifest.signers,
        fields: only.fields,
        textFields: only.textFields,
        textValues: only.textValues,
      });
    }
    if (documents.length > MAX_DOCUMENTS) throw new PdfError("tooLarge");
    const total = documents.reduce((sum, doc) => sum + doc.file.size, 0);
    if (total > MAX_TOTAL_BYTES) throw new PdfError("tooLarge");

    const manifestIds = new Map(
      documents.map((doc, index) => [doc.id, `doc-${index + 1}`] as const),
    );
    const Zip = await loadJSZip();
    const zip = new Zip();
    for (const [index, doc] of documents.entries()) {
      zip.file(
        configDocumentEntry(index),
        new Uint8Array(await doc.file.arrayBuffer()),
        // Sin entrada de carpeta aparte: el zip trae exactamente N + 1 entradas.
        { createFolders: false },
      );
    }
    // La letra de cada grupo se deriva de los bloques VIVOS y de la cola (como la ve la tabla de asignacion).
    const groups = needsV3
      ? blockGroups(
          manifest.blocks,
          documents.map((doc) => doc.id),
          manifest.signers,
        )
      : {};
    const body: SignConfigManifestV2 | SignConfigManifestV3 = {
      version: needsV3 ? CONFIG_VERSION_GROUPS : CONFIG_VERSION_MULTI,
      mode: manifest.mode,
      signMode: manifest.signMode,
      signers: manifest.signers,
      blocks: manifest.blocks.flatMap((block): SignConfigBlock[] => {
        const appliesTo = block.appliesTo.flatMap((id) => {
          const mapped = manifestIds.get(id);
          return mapped ? [mapped] : [];
        });
        if (appliesTo.length === 0) return [];
        const base: SignConfigBlock = {
          id: block.id,
          signerId: block.signerId,
          appliesTo,
          auto: block.auto,
        };
        if (!needsV3) return [base];
        const group = groups[block.id];
        const groupName = groupNames[block.id];
        return [{ ...base, ...(group ? { group } : {}), ...(groupName ? { groupName } : {}) }];
      }),
      documents: documents.map((doc, index) => ({
        id: `doc-${index + 1}`,
        entry: configDocumentEntry(index),
        name: doc.file.name.slice(0, DOCUMENT_NAME_MAX),
        fields: doc.fields,
        textFields: doc.textFields,
        textValues: doc.textValues,
        ...(needsV3 ? { copies: normalizeCopies(doc.copies) } : {}),
      })),
    } as SignConfigManifestV2 | SignConfigManifestV3;
    zip.file(MANIFEST_FILENAME, JSON.stringify(body));
    return await zip.generateAsync({ type: "blob" });
  } catch (error) {
    throw toPdfError(error);
  }
}

/** Nombres de grupo listos para escribir: sin vacios, sin espacios de mas y no mas largos que `GROUP_NAME_MAX`. */
function cleanGroupNames(
  names: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [blockId, raw] of Object.entries(names ?? {})) {
    const name = typeof raw === "string" ? raw.trim().slice(0, GROUP_NAME_MAX).trim() : "";
    if (name !== "") clean[blockId] = name;
  }
  return clean;
}

/** Nombre de archivo sugerido para la configuracion de varios documentos. */
export function signConfigSetFilename(documentCount: number): string {
  return `Configuracion - ${documentCount} documentos.zip`;
}

export type ImportedConfigDocument = {
  /** Id del documento dentro del manifiesto (para los bloques). */
  id: string;
  file: File;
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  /** Solo si vale mas de 1 (v3). Ausente = 1, igual que `DocState.copies`: la v1/v2 se importan EXACTAMENTE como antes. */
  copies?: number;
};

/** El resultado de importar, con la misma forma venga de v1, v2 o v3. */
export type ImportedSignConfigSet = {
  version: 1 | 2 | 3;
  mode: SignMode;
  signMode: BlockSignMode;
  signers: Signer[];
  /** v1: vacio (los bloques los crea la sesion). */
  blocks: SignConfigBlock[];
  documents: ImportedConfigDocument[];
};

/**
 * Nombre de archivo seguro tomado del manifiesto: solo el nombre final (nada
 * de rutas), sin controles, acabado en `.pdf`. Un nombre vacio o inservible
 * cae a `documento-NN.pdf`.
 */
export function sanitizeConfigDocumentName(name: string, index: number): string {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const base = cleaned.replace(/^\.+/, "").trim();
  const fallback = `documento-${String(index + 1).padStart(2, "0")}.pdf`;
  if (!base) return fallback;
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** Tamano descomprimido DECLARADO por la cabecera del zip (si JSZip lo expone), para rechazar antes de inflar. */
function declaredSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

/**
 * Descomprime una entrada por TROZOS y corta en cuanto pasa de `limit` bytes.
 * La cabecera del zip puede mentir sobre el tamano (declara poco y descomprime
 * mucho): leer la entrada entera con `async()` inflaria cientos de MB antes de
 * poder compararla. Cualquier fallo de jszip (CRC, tamano que no cuadra, datos
 * corruptos) es una configuracion no valida, no un error desconocido.
 */
function readEntryLimited(entry: JSZip.JSZipObject, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    type Stream = {
      on(event: string, callback: (...args: never[]) => void): Stream;
      pause(): Stream;
      resume(): Stream;
    };
    const internal = (
      entry as unknown as { internalStream?: (type: "uint8array") => Stream }
    ).internalStream;
    if (typeof internal !== "function") {
      // Sin la API de trozos (version distinta de jszip): lectura entera, ya validada despues.
      entry.async("uint8array").then(resolve, () => reject(new PdfError("invalidConfig")));
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = internal.call(entry, "uint8array");
    const fail = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      chunks.length = 0;
      reject(new PdfError("invalidConfig"));
    };
    stream
      .on("data", ((chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > limit) {
          fail();
          return;
        }
        chunks.push(chunk);
      }) as never)
      .on("error", fail as never)
      .on("end", (() => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(bytes);
      }) as never)
      .resume();
  });
}

async function readPdfBytes(
  entry: JSZip.JSZipObject,
  limit: number,
  budget: { remaining: number },
): Promise<Uint8Array> {
  const declared = declaredSize(entry);
  if (declared !== null && (declared > limit || declared > budget.remaining)) {
    throw new PdfError("invalidConfig");
  }
  // El tope real es el menor de ambos, medido sobre lo que de verdad se descomprime.
  const bytes = await readEntryLimited(entry, Math.min(limit, budget.remaining));
  if (bytes.byteLength === 0) throw new PdfError("invalidConfig");
  budget.remaining -= bytes.byteLength;
  const header = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (header !== "%PDF-") throw new PdfError("invalidConfig");
  return bytes;
}

/**
 * Lee una configuracion de CUALQUIER version conocida (v1: un documento; v2:
 * varios) con la misma validacion estricta. Antes de confiar en nada comprueba
 * que el zip no sea desproporcionado: pocas entradas, solo las que el manifiesto
 * declara, cada PDF dentro de su tope y la suma dentro del tope de la ronda
 * (comprobado sobre el tamano declarado Y sobre lo realmente descomprimido). Un
 * zip descargado de cualquier lado puede venir manipulado.
 */
export async function importSignConfigSet(
  zipFile: File,
): Promise<ImportedSignConfigSet> {
  try {
    if (zipFile.size > MAX_TOTAL_BYTES + 1024 * 1024) {
      throw new PdfError("invalidConfig");
    }
    const Zip = await loadJSZip();
    const zip = await Zip.loadAsync(await zipFile.arrayBuffer()).catch(() => {
      throw new PdfError("invalidConfig");
    });
    const entries = Object.values(zip.files);
    // Tope barato antes de leer nada: N documentos + manifiesto (+ carpeta).
    if (entries.length === 0 || entries.length > MAX_DOCUMENTS + 2) {
      throw new PdfError("invalidConfig");
    }
    const manifestEntry = zip.file(MANIFEST_FILENAME);
    if (!manifestEntry) throw new PdfError("invalidConfig");

    const manifestText = new TextDecoder().decode(
      await readEntryLimited(manifestEntry, MANIFEST_TEXT_LIMIT),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      throw new PdfError("invalidConfig");
    }

    if (isSignConfigManifest(parsed)) {
      // v1: la rama de siempre, un unico PDF fijo y como mucho 5 entradas.
      if (entries.length > 5) throw new PdfError("invalidConfig");
      const pdfEntry = zip.file(PDF_ENTRY_NAME);
      if (!pdfEntry) throw new PdfError("invalidConfig");
      const pdfBytes = await readPdfBytes(pdfEntry, MAX_SAFE_FILE_SIZE, {
        remaining: MAX_SAFE_FILE_SIZE,
      });
      return {
        version: 1,
        mode: parsed.mode,
        signMode: "same",
        signers: parsed.signers,
        blocks: [],
        documents: [
          {
            id: "doc-1",
            file: new File([pdfBytes as BlobPart], PDF_ENTRY_NAME, {
              type: "application/pdf",
            }),
            fields: parsed.fields,
            textFields: parsed.textFields,
            textValues: parsed.textValues,
          },
        ],
      };
    }
    const isV3 = isSignConfigManifestV3(parsed);
    if (!isV3 && !isSignConfigManifestV2(parsed)) throw new PdfError("invalidConfig");
    const multi = parsed as SignConfigManifestV2 | SignConfigManifestV3;

    // Solo las entradas que el manifiesto declara (+ el manifiesto, + la carpeta).
    const declared = new Set<string>([
      MANIFEST_FILENAME,
      ...multi.documents.map((doc) => doc.entry),
    ]);
    const files = entries.filter((entry) => !entry.dir);
    if (files.length !== declared.size) throw new PdfError("invalidConfig");
    for (const entry of entries) {
      const allowed = entry.dir
        ? entry.name === "documentos/"
        : declared.has(entry.name);
      if (!allowed) throw new PdfError("invalidConfig");
    }

    const budget = { remaining: MAX_TOTAL_BYTES };
    const documents: ImportedConfigDocument[] = [];
    for (const [index, doc] of multi.documents.entries()) {
      const entry = zip.file(doc.entry);
      if (!entry) throw new PdfError("invalidConfig");
      const bytes = await readPdfBytes(entry, MAX_DOCUMENT_BYTES, budget);
      documents.push({
        id: doc.id,
        file: new File([bytes as BlobPart], sanitizeConfigDocumentName(doc.name, index), {
          type: "application/pdf",
        }),
        fields: doc.fields,
        textFields: doc.textFields,
        textValues: doc.textValues,
        ...(isV3 && normalizeCopies(doc.copies) > DEFAULT_COPIES
          ? { copies: normalizeCopies(doc.copies) }
          : {}),
      });
    }
    return {
      version: isV3 ? CONFIG_VERSION_GROUPS : CONFIG_VERSION_MULTI,
      mode: multi.mode,
      signMode: multi.signMode,
      signers: multi.signers,
      blocks: multi.blocks,
      documents,
    };
  } catch (error) {
    // Todo fallo al leer el zip (cabeceras mentirosas, CRC, datos corruptos) es una
    // configuracion no valida, no un error desconocido.
    throw error instanceof PdfError ? error : new PdfError("invalidConfig");
  }
}
