import type JSZip from "jszip";
import { loadJSZip } from "@/lib/pdf/lazyZip";
import { slugify, stripExtension } from "@/lib/pdf/core";
import {
  BIDI_CONTROLS,
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_IMAGE_DIMENSION,
  MAX_VAULT_TEXT_LENGTH,
  isValidVaultImage,
  pngIhdrCrcValid,
  readPngSize,
  type VaultEntry,
  type VaultEntryInput,
  type VaultImage,
} from "@/app/sign-pdf/signVault";

/**
 * Archivo exportable/importable de UNA entrada del baul de firmas
 * (`signVault.ts`): un zip con la firma y/o las iniciales como PNG mas un
 * `manifest.json`, opcionalmente cifrado con contraseña. Cada usuario
 * descarga/lee el archivo en su navegador; nada pasa por un servidor.
 *
 * El nombre del archivo identifica al firmante y al documento
 * (`vaultFilename`), pero los nombres DENTRO del zip son fijos y jamas se
 * derivan de datos: lo que viene de fuera nunca decide una ruta.
 *
 * Como `signConfig.ts`, un zip ajeno puede venir manipulado: la
 * importacion es estricta (tamaño antes de abrir, lista blanca de nombres,
 * limites de bytes y de dimensiones, type-guard escrito a mano) y NUNCA
 * lanza -- devuelve `{ ok: false, reason }`.
 *
 * Cifrado: PBKDF2-SHA256 (600 000 iteraciones) -> AES-GCM-256 sobre el zip
 * interior, con el `manifest.json` exterior serializado como dato asociado
 * (AAD): tocar sal, IV o parametros invalida el descifrado.
 */

const MANIFEST_NAME = "manifest.json";
const SIGNATURE_NAME = "firma.png";
const INITIALS_NAME = "iniciales.png";
const ENCRYPTED_NAME = "vault.enc";
const PLAIN_ENTRY_NAMES: readonly string[] = [
  MANIFEST_NAME,
  SIGNATURE_NAME,
  INITIALS_NAME,
];
const ENCRYPTED_ENTRY_NAMES: readonly string[] = [MANIFEST_NAME, ENCRYPTED_NAME];

const FORMAT_VERSION = 1;
const KIND_PLAIN = "signature-vault";
const KIND_ENCRYPTED = "signature-vault-encrypted";

/** Tamaño maximo del archivo importado, comprobado ANTES de abrir el zip. */
export const MAX_VAULT_FILE_BYTES = 4 * 1024 * 1024;
/** Un `manifest.json` real pesa unos cientos de bytes. */
const MAX_MANIFEST_BYTES = 16 * 1024;
/** Entradas maximas del zip (3 en plano, 2 cifrado; 4 de margen). */
const MAX_ZIP_ENTRIES = 4;

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Motivos de fallo de `importVaultFile`. */
export type ImportVaultReason =
  | "invalid"
  | "tooLarge"
  | "needsPassword"
  | "wrongPassword"
  | "unsupportedVersion"
  | "encryptionUnavailable";

export type ImportVaultResult =
  | { ok: true; entry: VaultEntryInput }
  | { ok: false; reason: ImportVaultReason };

export type ExportVaultOptions = {
  /** Si viene (no vacia), el archivo se cifra con ella. */
  password?: string;
  /** `false` omite el nombre del documento del manifiesto y del nombre de archivo. */
  includeDocumentName?: boolean;
};

export type ExportVaultResult =
  | { ok: true; blob: Blob; filename: string; encrypted: boolean }
  | {
      ok: false;
      reason: "encryptionUnavailable" | "invalid" | "failed";
    };

/** `true` si este navegador expone WebCrypto (`crypto.subtle` falta en http no seguro). */
export function encryptionAvailable(): boolean {
  try {
    return Boolean(globalThis.crypto?.subtle);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Nombre de archivo
// ---------------------------------------------------------------------------

/** "Firma-" + ".zip" no cuentan para el presupuesto de los componentes. */
const FILENAME_BODY_BUDGET = 70;
const SIGNER_SLUG_BUDGET_WITH_DOCUMENT = 35;

function trimDashes(text: string): string {
  return text.replace(/^-+|-+$/g, "");
}

/**
 * `Firma-<Firmante>-<Documento>.zip`. Cada componente pasa por `slugify`
 * (solo `a-z0-9-`): `/ \ .. :` y los caracteres de control no pueden
 * sobrevivir, asi que el resultado nunca es una ruta. Recortado a ~80
 * caracteres en total y siempre `.zip`. Sin nombre de documento:
 * `Firma-<Firmante>.zip`. Si un slug queda vacio ("李雷", "///") se usa
 * "firmante" / "documento".
 */
export function vaultFilename(
  signerName: string,
  sourceDocument?: string,
): string {
  const rawDocument =
    typeof sourceDocument === "string" ? sourceDocument.trim() : "";
  const hasDocument = rawDocument.length > 0;

  let signer = slugify(typeof signerName === "string" ? signerName : "");
  signer = trimDashes(
    signer.slice(
      0,
      hasDocument ? SIGNER_SLUG_BUDGET_WITH_DOCUMENT : FILENAME_BODY_BUDGET,
    ),
  );
  if (!signer) signer = "firmante";

  if (!hasDocument) return `Firma-${signer}.zip`;

  const remaining = Math.max(1, FILENAME_BODY_BUDGET - signer.length - 1);
  let document = trimDashes(slugify(stripExtension(rawDocument)).slice(0, remaining));
  if (!document) document = "documento".slice(0, remaining);
  return `Firma-${signer}-${document}.zip`;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** `null` si no es base64 canonico. */
function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

// ---------------------------------------------------------------------------
// Cifrado
// ---------------------------------------------------------------------------

async function deriveKey(
  password: string,
  salt: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  // NFKC: la misma contraseña escrita con otra composicion Unicode (macOS
  // vs Windows, teclado movil) tiene que derivar la misma clave.
  const base = await subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFKC")) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

type EncryptedParams = { salt: Uint8Array; iv: Uint8Array };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type-guard a mano del manifiesto exterior (mismo criterio que
 * `isSignConfigManifest`). Los parametros del KDF son EXACTOS: aceptar
 * `iterations` ajenas permitiria a un archivo hostil clavar el navegador.
 */
function readEncryptedParams(manifest: Record<string, unknown>): EncryptedParams | null {
  const kdf = manifest.kdf;
  if (!isRecord(kdf)) return null;
  if (
    kdf.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    kdf.iterations !== PBKDF2_ITERATIONS ||
    typeof kdf.salt !== "string" ||
    typeof manifest.iv !== "string"
  ) {
    return null;
  }
  const salt = fromBase64(kdf.salt);
  const iv = fromBase64(manifest.iv);
  if (!salt || salt.length !== SALT_BYTES || !iv || iv.length !== IV_BYTES) {
    return null;
  }
  return { salt, iv };
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

function clampText(value: string | undefined): string {
  return (value ?? "").trim().slice(0, MAX_VAULT_TEXT_LENGTH);
}

/**
 * Empaqueta una entrada del baul. Con `password` cifra el zip entero (el
 * manifiesto con nombre/cargo/documento va DENTRO, no en claro); solo el
 * nombre del archivo, que elige quien exporta, queda visible. Sin
 * `crypto.subtle` el export con contraseña falla con
 * `encryptionUnavailable` y el plano sigue funcionando.
 */
export async function exportVaultEntry(
  entry: Pick<
    VaultEntry,
    "signerName" | "role" | "sourceDocument" | "signature" | "initials"
  >,
  opts: ExportVaultOptions = {},
): Promise<ExportVaultResult> {
  try {
    const signerName = clampText(entry?.signerName);
    const signature = entry?.signature ?? null;
    const initials = entry?.initials ?? null;
    if (
      !signerName ||
      (signature === null && initials === null) ||
      (signature !== null && !isValidVaultImage(signature)) ||
      (initials !== null && !isValidVaultImage(initials))
    ) {
      return { ok: false, reason: "invalid" };
    }

    const wantsPassword = opts.password !== undefined;
    if (wantsPassword && (typeof opts.password !== "string" || opts.password === "")) {
      return { ok: false, reason: "invalid" };
    }
    if (wantsPassword && !encryptionAvailable()) {
      return { ok: false, reason: "encryptionUnavailable" };
    }

    const includeDocument = opts.includeDocumentName !== false;
    const role = clampText(entry.role);
    const sourceDocument = includeDocument ? clampText(entry.sourceDocument) : "";
    const filename = vaultFilename(signerName, sourceDocument);

    const Zip = await loadJSZip();
    const inner = new Zip();
    inner.file(
      MANIFEST_NAME,
      JSON.stringify({
        version: FORMAT_VERSION,
        kind: KIND_PLAIN,
        signerName,
        ...(role ? { role } : {}),
        ...(sourceDocument ? { sourceDocument } : {}),
        exportedAt: new Date().toISOString(),
      }),
    );
    if (signature) inner.file(SIGNATURE_NAME, signature.png);
    if (initials) inner.file(INITIALS_NAME, initials.png);

    if (!wantsPassword) {
      const blob = await inner.generateAsync({ type: "blob" });
      return { ok: true, blob, filename, encrypted: false };
    }

    const innerBytes = await inner.generateAsync({ type: "uint8array" });
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const outerManifest = JSON.stringify({
      version: FORMAT_VERSION,
      kind: KIND_ENCRYPTED,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
        salt: toBase64(salt),
      },
      iv: toBase64(iv),
    });
    const key = await deriveKey(opts.password as string, salt, "encrypt");
    const cipher = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          additionalData: encoder.encode(outerManifest) as BufferSource,
        },
        key,
        innerBytes as BufferSource,
      ),
    );

    const outer = new Zip();
    outer.file(MANIFEST_NAME, outerManifest);
    outer.file(ENCRYPTED_NAME, cipher);
    const blob = await outer.generateAsync({ type: "blob" });
    return { ok: true, blob, filename, encrypted: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------

class ImportFailure extends Error {
  constructor(readonly reason: ImportVaultReason) {
    super(reason);
  }
}

type StreamLike = {
  on(event: "data", cb: (chunk: Uint8Array) => void): StreamLike;
  on(event: "error" | "end", cb: () => void): StreamLike;
  pause(): StreamLike;
  resume(): StreamLike;
};

/**
 * Lee una entrada del zip con tope DURO de bytes. Dos defensas contra una
 * bomba de descompresion: (1) el tamaño declarado en la cabecera, antes de
 * descomprimir nada; (2) el flujo real, que se corta al pasar del tope --
 * la cabecera podria mentir. `null` = pasa del tope o no se pudo leer.
 */
async function readEntryBytes(
  entry: JSZip.JSZipObject,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })
    ._data?.uncompressedSize;
  if (typeof declared === "number" && declared > limit) return null;

  const internalStream = (
    entry as unknown as { internalStream?: (type: string) => StreamLike }
  ).internalStream;
  if (typeof internalStream !== "function") {
    try {
      const bytes = await entry.async("uint8array");
      return bytes.byteLength > limit ? null : bytes;
    } catch {
      return null;
    }
  }

  return new Promise<Uint8Array | null>((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const stream = internalStream.call(entry, "uint8array");
    stream
      .on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > limit) {
          stream.pause();
          finish(null);
          return;
        }
        chunks.push(chunk);
      })
      .on("error", () => finish(null))
      .on("end", () => {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        finish(bytes);
      })
      .resume();
  });
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).arrayBuffer === "function"
  );
}

async function loadZip(bytes: Uint8Array): Promise<JSZip> {
  try {
    const Zip = await loadJSZip();
    return await Zip.loadAsync(bytes);
  } catch {
    throw new ImportFailure("invalid");
  }
}

/** Ninguna ruta con `/`, `\` o `..`, y tope de entradas, ANTES de leer nada. */
function listEntryNames(zip: JSZip): string[] {
  const names = Object.keys(zip.files);
  if (names.length === 0 || names.length > MAX_ZIP_ENTRIES) {
    throw new ImportFailure("invalid");
  }
  for (const name of names) {
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new ImportFailure("invalid");
    }
  }
  return names;
}

/** Lista blanca de nombres exactos, sin carpetas. */
function assertEntryNames(
  zip: JSZip,
  names: readonly string[],
  allowed: readonly string[],
): void {
  for (const name of names) {
    if (!allowed.includes(name)) {
      throw new ImportFailure("invalid");
    }
    if (zip.files[name].dir) throw new ImportFailure("invalid");
  }
}

async function readManifest(
  zip: JSZip,
): Promise<{ manifest: Record<string, unknown>; raw: Uint8Array }> {
  const entry = zip.file(MANIFEST_NAME);
  if (!entry) throw new ImportFailure("invalid");
  const raw = await readEntryBytes(entry, MAX_MANIFEST_BYTES);
  if (!raw) throw new ImportFailure("invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new ImportFailure("invalid");
  }
  if (!isRecord(parsed)) throw new ImportFailure("invalid");
  // Version ANTES que cualquier otro campo: un formato futuro se rechaza
  // con honestidad en vez de leerlo a medias.
  if (parsed.version !== FORMAT_VERSION) {
    throw new ImportFailure(
      typeof parsed.version === "number" &&
        Number.isInteger(parsed.version) &&
        parsed.version > FORMAT_VERSION
        ? "unsupportedVersion"
        : "invalid",
    );
  }
  return { manifest: parsed, raw };
}

/** Quita caracteres de control; `null` si no es string o pasa del tope. */
function readText(value: unknown, required: boolean): string | null | undefined {
  if (value === undefined) return required ? null : undefined;
  if (typeof value !== "string" || value.length > MAX_VAULT_TEXT_LENGTH) {
    return null;
  }
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(BIDI_CONTROLS, "")
    .trim();
  if (required && !clean) return null;
  return clean || undefined;
}

const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function hasPngEnd(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_IEND.length) return false;
  const start = bytes.length - PNG_IEND.length;
  return PNG_IEND.every((byte, i) => bytes[start + i] === byte);
}

async function readImage(
  zip: JSZip,
  name: string,
): Promise<VaultImage | null | undefined> {
  const entry = zip.file(name);
  if (!entry) return undefined;
  const png = await readEntryBytes(entry, MAX_VAULT_IMAGE_BYTES);
  if (!png) throw new ImportFailure("invalid");
  const size = readPngSize(png);
  if (
    !size ||
    !hasPngEnd(png) ||
    !pngIhdrCrcValid(png) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_VAULT_IMAGE_DIMENSION ||
    size.height > MAX_VAULT_IMAGE_DIMENSION
  ) {
    throw new ImportFailure("invalid");
  }
  // El manifiesto no guarda el ratio: se deriva de las dimensiones reales,
  // asi nunca puede contradecirlas.
  const image: VaultImage = {
    png,
    ratio: size.height / size.width,
    width: size.width,
    height: size.height,
  };
  if (!isValidVaultImage(image)) throw new ImportFailure("invalid");
  return image;
}

/** Zip "en claro" (o ya descifrado) -> entrada validada. */
async function readPlainVault(zip: JSZip): Promise<VaultEntryInput> {
  const names = listEntryNames(zip);
  const { manifest } = await readManifest(zip);
  assertEntryNames(zip, names, PLAIN_ENTRY_NAMES);
  if (manifest.kind !== KIND_PLAIN) throw new ImportFailure("invalid");

  const signerName = readText(manifest.signerName, true);
  const role = readText(manifest.role, false);
  const sourceDocument = readText(manifest.sourceDocument, false);
  const exportedAt = readText(manifest.exportedAt, true);
  if (
    signerName === null ||
    role === null ||
    sourceDocument === null ||
    exportedAt === null ||
    signerName === undefined
  ) {
    throw new ImportFailure("invalid");
  }

  const signature = (await readImage(zip, SIGNATURE_NAME)) ?? null;
  const initials = (await readImage(zip, INITIALS_NAME)) ?? null;
  if (!signature && !initials) throw new ImportFailure("invalid");

  return {
    signerName,
    ...(role ? { role } : {}),
    sourceDocument: sourceDocument ?? "",
    signature,
    initials,
  };
}

async function readEncryptedVault(
  zip: JSZip,
  manifest: Record<string, unknown>,
  rawManifest: Uint8Array,
  password: string | undefined,
): Promise<VaultEntryInput> {
  const params = readEncryptedParams(manifest);
  const entry = zip.file(ENCRYPTED_NAME);
  if (!params || !entry) throw new ImportFailure("invalid");
  const cipher = await readEntryBytes(entry, MAX_VAULT_FILE_BYTES);
  if (!cipher || cipher.length < GCM_TAG_BYTES) throw new ImportFailure("invalid");

  if (!encryptionAvailable()) throw new ImportFailure("encryptionUnavailable");
  if (!password) throw new ImportFailure("needsPassword");

  let plain: Uint8Array;
  try {
    const key = await deriveKey(password, params.salt, "decrypt");
    plain = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: params.iv as BufferSource,
          // Los bytes EXACTOS del manifiesto del archivo, no una
          // re-serializacion: cualquier cambio rompe el descifrado.
          additionalData: rawManifest as BufferSource,
        },
        key,
        cipher as BufferSource,
      ),
    );
  } catch {
    // Contraseña incorrecta y archivo manipulado son indistinguibles a
    // proposito: no se le dice a quien ataca cual de las dos fallo.
    throw new ImportFailure("wrongPassword");
  }

  return readPlainVault(await loadZip(plain));
}

/**
 * Lee un archivo de baul. Valida el tamaño ANTES de abrir el zip. Un
 * archivo cifrado sin `password` devuelve `needsPassword` (la UI pide la
 * contraseña y reintenta). Nunca lanza.
 */
export async function importVaultFile(
  file: File | Blob,
  opts: { password?: string } = {},
): Promise<ImportVaultResult> {
  try {
    if (!isBlobLike(file)) return { ok: false, reason: "invalid" };
    if (file.size > MAX_VAULT_FILE_BYTES) return { ok: false, reason: "tooLarge" };

    // Bytes explicitos, no el `File` tal cual (ver `importSignConfig`).
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_VAULT_FILE_BYTES) {
      return { ok: false, reason: "tooLarge" };
    }
    const zip = await loadZip(bytes);
    const names = listEntryNames(zip);
    const { manifest, raw } = await readManifest(zip);

    if (manifest.kind === KIND_ENCRYPTED) {
      assertEntryNames(zip, names, ENCRYPTED_ENTRY_NAMES);
      if (names.length !== ENCRYPTED_ENTRY_NAMES.length) {
        throw new ImportFailure("invalid");
      }
      const entry = await readEncryptedVault(zip, manifest, raw, opts.password);
      return { ok: true, entry };
    }
    return { ok: true, entry: await readPlainVault(zip) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ImportFailure ? error.reason : "invalid",
    };
  }
}
