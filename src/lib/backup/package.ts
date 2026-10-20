import type JSZip from "jszip";
import {
  PasswordBoxError,
  assertPasswordBoxShape,
  decryptWithPassword,
  encryptWithPassword,
  passwordBoxAvailable,
} from "@/lib/crypto/passwordBox";
import { sha256Hex } from "@/lib/crypto/sha256";
import { loadJSZip } from "@/lib/pdf/lazyZip";
import { DEFAULT_MODULE_REGISTRY } from "@/lib/backup/registry";
import { parseStrictJson } from "@/lib/backup/strictJson";
import {
  NEWER_VERSION_MESSAGE,
  PACKAGE_LIMITS,
  PackageError,
  type ModuleRegistry,
  type PackageFileInput,
  type PackageFileRead,
  type PackageFileStatus,
  type PackageMetaValue,
  type PackageModuleData,
  type PackageModuleInput,
  type PackageModuleSpec,
  type PackageReadResult,
  type PackageWarning,
} from "@/lib/backup/types";
import { readZipDirectory, type ZipDirectoryEntry } from "@/lib/backup/zipDirectory";

export { PackageError } from "@/lib/backup/types";
export type { PackageErrorCode, PackageReadResult } from "@/lib/backup/types";

/**
 * Contenedor de respaldo («OptimusPDF Package», `docs/PLAN-FIRMA-AGIL.md`
 * §9.3): UN formato para todo; un paquete «de modulo» es el mismo formato con
 * un unico modulo.
 *
 * ```
 * <nombre>.optimuspdf.zip
 * ├─ manifest.json   { format, formatVersion, createdAt, app, modules, files[] }
 * └─ <carpeta>/...   los archivos de cada modulo (signatures/, templates/...)
 *
 * cifrado opcional: zip EXTERIOR con solo
 * ├─ envelope.json   cabecera de `passwordBox` (kind "optimuspdf.package-encrypted")
 * └─ payload.bin     el zip interior cifrado
 * ```
 *
 * `readPackage` NO escribe nada ni ejecuta nada: devuelve lo que trae el
 * paquete ya validado. Que se hace con ello (vista previa, fusion, escritura
 * en los almacenes) es de cada modulo (`modules/*.ts`).
 */

export const PACKAGE_FORMAT = "optimuspdf.package";
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_ENCRYPTED_KIND = "optimuspdf.package-encrypted";
const MANIFEST_NAME = "manifest.json";
const ENVELOPE_NAME = "envelope.json";
const PAYLOAD_NAME = "payload.bin";

/** `<carpeta>/<archivo>`: la unica forma de ruta de un archivo de modulo. */
const FILE_PATH = /^([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const MODULE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const META_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,80}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_META_KEYS = 8;
const MAX_META_STRING = 100;
const MAX_SCHEMA_VERSION = 1_000_000;

/**
 * Spec de un modulo SOLO si el registro lo tiene como propiedad PROPIA. Un nombre
 * que viene del archivo (`constructor`, `toString`, `hasOwnProperty`...) cumple
 * `MODULE_NAME` y, con `registry[name]`, devolveria algo heredado de
 * `Object.prototype` (una funcion sin `folders`) y haria saltar un `TypeError`.
 */
function specOf(registry: ModuleRegistry, name: string): PackageModuleSpec | undefined {
  return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).arrayBuffer === "function"
  );
}

function isScalar(value: unknown): value is PackageMetaValue {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  );
}

// ---------------------------------------------------------------------------
// Escribir
// ---------------------------------------------------------------------------

export type BuildPackageOptions = {
  modules: PackageModuleInput[];
  /** Si viene (no vacia), el paquete entero se cifra con ella. */
  password?: string;
  app?: { version?: string; build?: string };
  registry?: ModuleRegistry;
  /** Solo para pruebas: fecha de creacion. */
  now?: Date;
};

function validateModuleInput(
  input: PackageModuleInput,
  registry: ModuleRegistry,
  seenPaths: Set<string>,
): void {
  if (!isRecord(input) || typeof input.name !== "string" || !MODULE_NAME.test(input.name)) {
    throw new PackageError("invalidModule");
  }
  const spec = specOf(registry, input.name);
  if (
    !spec ||
    !Number.isInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    input.schemaVersion > spec.schemaVersion ||
    !Array.isArray(input.files)
  ) {
    throw new PackageError("invalidModule");
  }
  if (input.meta !== undefined) {
    if (!isRecord(input.meta)) throw new PackageError("invalidModule");
    const keys = Object.keys(input.meta);
    if (keys.length > MAX_META_KEYS) throw new PackageError("invalidModule");
    for (const key of keys) {
      const value = input.meta[key];
      if (
        !META_KEY.test(key) ||
        key === "schemaVersion" ||
        !isScalar(value) ||
        (typeof value === "string" && value.length > MAX_META_STRING)
      ) {
        throw new PackageError("invalidModule");
      }
    }
  }
  for (const file of input.files) {
    const match = isRecord(file) && typeof file.path === "string" ? FILE_PATH.exec(file.path) : null;
    if (
      !match ||
      !spec.folders.includes(match[1]) ||
      !isBytes(file.data) ||
      typeof file.type !== "string" ||
      !MIME_TYPE.test(file.type) ||
      seenPaths.has(file.path.toLowerCase())
    ) {
      throw new PackageError("invalidModule");
    }
    // Nunca se escribe lo que luego esta misma app rechazaria al leer.
    const cap = file.path.endsWith(".json") ? spec.maxJsonBytes : spec.maxFileBytes;
    if (file.data.byteLength > cap) throw new PackageError("tooLarge");
    seenPaths.add(file.path.toLowerCase());
  }
}

/**
 * Empaqueta uno o varios modulos en un zip (cifrado si hay `password`).
 * Lanza `PackageError` (`invalidModule`, `tooLarge`, `unavailable`).
 */
export async function buildPackage(opts: BuildPackageOptions): Promise<Blob> {
  const registry = opts.registry ?? DEFAULT_MODULE_REGISTRY;
  const modules = opts.modules;
  if (
    !Array.isArray(modules) ||
    modules.length === 0 ||
    modules.length > PACKAGE_LIMITS.maxModules
  ) {
    throw new PackageError("invalidModule");
  }
  const wantsPassword = opts.password !== undefined;
  if (wantsPassword && (typeof opts.password !== "string" || opts.password === "")) {
    throw new PackageError("invalidModule");
  }
  if (wantsPassword && !passwordBoxAvailable()) throw new PackageError("unavailable");

  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();
  for (const input of modules) {
    validateModuleInput(input, registry, seenPaths);
    if (seenNames.has(input.name)) throw new PackageError("invalidModule");
    seenNames.add(input.name);
  }

  const allFiles: PackageFileInput[] = modules.flatMap((m) => m.files);
  // +1 por manifest.json.
  if (allFiles.length + 1 > PACKAGE_LIMITS.maxEntries) throw new PackageError("tooManyEntries");
  const totalBytes = allFiles.reduce((sum, f) => sum + f.data.byteLength, 0);
  if (totalBytes > PACKAGE_LIMITS.maxUncompressedBytes) throw new PackageError("tooLarge");

  const files: { path: string; sha256: string; bytes: number; type: string }[] = [];
  for (const file of allFiles) {
    files.push({
      path: file.path,
      sha256: await sha256Hex(file.data),
      bytes: file.data.byteLength,
      type: file.type,
    });
  }
  const manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    app: { version: opts.app?.version ?? "unknown", build: opts.app?.build ?? "unknown" },
    modules: Object.fromEntries(
      modules.map((m) => [m.name, { ...(m.meta ?? {}), schemaVersion: m.schemaVersion }]),
    ),
    files,
  };

  // El tope de 250 MiB de la importacion suma TAMBIEN `manifest.json` (directorio central): lo que aqui no cupiera alli,
  // no se genera (un respaldo que luego no se puede abrir es peor que ninguno).
  const manifestText = JSON.stringify(manifest);
  if (totalBytes + new TextEncoder().encode(manifestText).byteLength > PACKAGE_LIMITS.maxUncompressedBytes) {
    throw new PackageError("tooLarge");
  }

  const Zip = await loadJSZip();
  const inner = new Zip();
  const jsonOptions = { createFolders: false, compression: "DEFLATE" as const };
  inner.file(MANIFEST_NAME, manifestText, jsonOptions);
  for (const file of allFiles) {
    // Un Uint8Array de otro dominio (jsdom, datos clonados de IndexedDB) no lo
    // reconoce JSZip: se copia al del dominio actual solo en ese caso.
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    inner.file(file.path, data, {
      createFolders: false,
      // Los PNG ya vienen comprimidos: STORE evita ratios raros y es mas rapido.
      compression: file.path.endsWith(".json") ? "DEFLATE" : "STORE",
    });
  }

  if (!wantsPassword) {
    return assertImportable(await inner.generateAsync({ type: "blob", mimeType: "application/zip" }));
  }
  const innerBytes = await inner.generateAsync({ type: "uint8array" });
  // El archivo recibido y lo descifrado tienen el mismo tope al importar (250 MiB).
  if (innerBytes.byteLength > PACKAGE_LIMITS.maxFileBytes) throw new PackageError("tooLarge");
  let box;
  try {
    box = await encryptWithPassword(innerBytes, opts.password as string, {
      kind: PACKAGE_ENCRYPTED_KIND,
      version: PACKAGE_FORMAT_VERSION,
    });
  } catch (error) {
    throw error instanceof PasswordBoxError && error.code === "unavailable"
      ? new PackageError("unavailable")
      : new PackageError("invalidModule");
  }
  const outer = new Zip();
  outer.file(ENVELOPE_NAME, box.header, { createFolders: false, compression: "STORE" });
  outer.file(PAYLOAD_NAME, box.payload, { createFolders: false, compression: "STORE" });
  return assertImportable(await outer.generateAsync({ type: "blob", mimeType: "application/zip" }));
}

/** Lo que sale de `buildPackage` tiene que caber en lo que `readPackage` acepta recibir. */
function assertImportable(blob: Blob): Blob {
  if (blob.size > PACKAGE_LIMITS.maxFileBytes) throw new PackageError("tooLarge");
  return blob;
}

// ---------------------------------------------------------------------------
// Leer: abrir el zip
// ---------------------------------------------------------------------------

type StreamLike = {
  on(event: "data", cb: (chunk: Uint8Array) => void): StreamLike;
  on(event: "error" | "end", cb: () => void): StreamLike;
  pause(): StreamLike;
  resume(): StreamLike;
};

type OpenedZip = {
  zip: JSZip;
  entries: ZipDirectoryEntry[];
  byName: Map<string, ZipDirectoryEntry>;
};

/**
 * Directorio central propio (ANTES de inflar) + JSZip (SIN `checkCRC32`: esa
 * opcion infla TODAS las entradas al cargar, y aqui la integridad la da el
 * SHA-256 del manifiesto), y las dos vistas
 * tienen que coincidir en nombres y tamaños: una discrepancia (campos extra
 * «Unicode path», directorios solapados...) es un zip hostil.
 */
async function openZip(bytes: Uint8Array): Promise<OpenedZip> {
  const entries = readZipDirectory(bytes);
  let zip: JSZip;
  try {
    const Zip = await loadJSZip();
    zip = await Zip.loadAsync(bytes);
  } catch {
    throw new PackageError("badZip");
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const jszipNames = Object.keys(zip.files);
  for (const name of jszipNames) {
    const mine = byName.get(name);
    if (!mine) {
      // JSZip puede crear carpetas implicitas de las rutas con `/`: solo se
      // admiten si son carpetas; cualquier otra cosa es una discrepancia.
      if (name.endsWith("/") && zip.files[name].dir) continue;
      throw new PackageError("badZip");
    }
    const data = (zip.files[name] as unknown as { _data?: Record<string, unknown> })._data;
    if (
      data &&
      ((typeof data.uncompressedSize === "number" &&
        data.uncompressedSize !== mine.uncompressedSize) ||
        (typeof data.compressedSize === "number" && data.compressedSize !== mine.compressedSize))
    ) {
      throw new PackageError("badZip");
    }
  }
  for (const name of byName.keys()) {
    if (!hasOwn(zip.files, name)) throw new PackageError("badZip");
  }
  return { zip, entries, byName };
}

type Capped =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: "tooLarge" | "sizeMismatch" | "unreadable" | "budget" };

/**
 * Presupuesto GLOBAL de bytes inflados de una lectura (lo que realmente se
 * emite, no lo que se declara). Un paquete legitimo nunca pasa de la suma de
 * tamaños declarados (<= 250 MB); uno hostil con miles de entradas que mienten
 * (cada una inflaria ~16 MB antes de cortarse) agota el presupuesto y se rechaza.
 */
type InflateBudget = { remaining: number };

/**
 * Lee UNA entrada con tope duro. Defensas, en orden: (1) el tamaño declarado
 * en el directorio central contra el tope, sin inflar; (2) el flujo real se
 * corta en cuanto pasa del tamaño DECLARADO (una cabecera que miente no
 * infla mas de lo que dijo); (3) al terminar, los bytes leidos tienen que
 * ser exactamente los declarados.
 */
async function readCapped(
  zip: JSZip,
  entry: ZipDirectoryEntry,
  cap: number,
  budget: InflateBudget,
): Promise<Capped> {
  if (entry.uncompressedSize > cap) return { ok: false, status: "tooLarge" };
  const object = hasOwn(zip.files, entry.name) ? zip.files[entry.name] : undefined;
  const internalStream = (object as unknown as { internalStream?: (t: string) => StreamLike })
    ?.internalStream;
  if (!object || typeof internalStream !== "function") {
    return { ok: false, status: "unreadable" };
  }
  const declared = entry.uncompressedSize;
  return new Promise<Capped>((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Capped) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const stream = internalStream.call(object, "uint8array");
    stream
      .on("data", (chunk) => {
        // Se contabiliza TAMBIEN lo que JSZip siga emitiendo tras cortar (un
        // trozo de entrada puede inflar ~16 MB de golpe): es trabajo real.
        budget.remaining -= chunk.length;
        if (settled) {
          if (budget.remaining < 0) budget.remaining = -1;
          return;
        }
        total += chunk.length;
        if (budget.remaining < 0) {
          stream.pause();
          finish({ ok: false, status: "budget" });
          return;
        }
        if (total > declared) {
          stream.pause();
          finish({ ok: false, status: "sizeMismatch" });
          return;
        }
        chunks.push(chunk);
      })
      .on("error", () => finish({ ok: false, status: "unreadable" }))
      .on("end", () => {
        if (total !== declared) {
          finish({ ok: false, status: "sizeMismatch" });
          return;
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        finish({ ok: true, bytes });
      })
      .resume();
  });
}

async function mustRead(
  opened: OpenedZip,
  name: string,
  cap: number,
  budget: InflateBudget,
): Promise<Uint8Array> {
  const entry = opened.byName.get(name);
  if (!entry || entry.isDir) throw new PackageError("badZip");
  const result = await readCapped(opened.zip, entry, cap, budget);
  if (!result.ok) {
    throw new PackageError(
      result.status === "tooLarge"
        ? "tooLarge"
        : result.status === "budget"
          ? "bomb"
          : "badZip",
    );
  }
  return result.bytes;
}

// ---------------------------------------------------------------------------
// Leer: manifiesto
// ---------------------------------------------------------------------------

type ManifestFile = { path: string; sha256: string; bytes: number; type: string };
type ManifestModule = { schemaVersion: number; meta: Record<string, PackageMetaValue> };
type ParsedManifest = {
  formatVersion: number;
  createdAt: string;
  app: { version?: string; build?: string };
  modules: Map<string, ManifestModule>;
  skippedModules: string[];
  files: ManifestFile[];
};

function shortString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function parseManifest(raw: unknown): ParsedManifest {
  if (!isRecord(raw)) throw new PackageError("invalidManifest");
  if (raw.format !== PACKAGE_FORMAT) throw new PackageError("invalidManifest");
  const formatVersion = raw.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new PackageError("invalidManifest");
  }
  // El contenedor MAS NUEVO no se lee a medias.
  if (formatVersion > PACKAGE_FORMAT_VERSION) throw new PackageError("newerFormat");

  const createdAt = raw.createdAt;
  if (typeof createdAt !== "string" || createdAt.length > 64 || Number.isNaN(Date.parse(createdAt))) {
    throw new PackageError("invalidManifest");
  }
  const app: { version?: string; build?: string } = {};
  if (isRecord(raw.app)) {
    app.version = shortString(raw.app.version, 64);
    app.build = shortString(raw.app.build, 64);
  }

  if (!isRecord(raw.modules)) throw new PackageError("invalidManifest");
  // `Object.entries` (no `raw.modules[clave]`): las claves vienen del archivo.
  const moduleEntries = Object.entries(raw.modules);
  if (moduleEntries.length > PACKAGE_LIMITS.maxModules) throw new PackageError("invalidManifest");
  const modules = new Map<string, ManifestModule>();
  const skippedModules: string[] = [];
  for (const [key, value] of moduleEntries) {
    if (!MODULE_NAME.test(key)) {
      skippedModules.push(key.slice(0, 40));
      continue;
    }
    if (!isRecord(value)) throw new PackageError("invalidManifest");
    const schemaVersion = value.schemaVersion;
    if (
      typeof schemaVersion !== "number" ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion < 1 ||
      schemaVersion > MAX_SCHEMA_VERSION
    ) {
      throw new PackageError("invalidManifest");
    }
    const meta: Record<string, PackageMetaValue> = {};
    let metaCount = 0;
    for (const [metaKey, metaValue] of Object.entries(value)) {
      if (metaKey === "schemaVersion" || !META_KEY.test(metaKey) || !isScalar(metaValue)) continue;
      if (typeof metaValue === "string" && metaValue.length > MAX_META_STRING) continue;
      if (metaCount >= MAX_META_KEYS) break;
      meta[metaKey] = metaValue;
      metaCount += 1;
    }
    modules.set(key, { schemaVersion, meta });
  }

  if (!Array.isArray(raw.files) || raw.files.length > PACKAGE_LIMITS.maxEntries) {
    throw new PackageError("invalidManifest");
  }
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const item of raw.files) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.sha256 !== "string" ||
      typeof item.bytes !== "number" ||
      typeof item.type !== "string"
    ) {
      throw new PackageError("invalidManifest");
    }
    // Una ruta con forma de ataque rechaza el paquete; una ruta limpia pero
    // de otra forma (no `<carpeta>/<archivo>`) se descarta mas adelante.
    if (!FILE_PATH.test(item.path)) throw new PackageError("unsafePath");
    if (
      !SHA256_HEX.test(item.sha256) ||
      !Number.isInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > PACKAGE_LIMITS.maxUncompressedBytes ||
      item.type.length > 100 ||
      !MIME_TYPE.test(item.type)
    ) {
      throw new PackageError("invalidManifest");
    }
    const lower = item.path.toLowerCase();
    if (seen.has(lower)) throw new PackageError("duplicateEntry");
    seen.add(lower);
    files.push({ path: item.path, sha256: item.sha256, bytes: item.bytes, type: item.type });
  }
  return { formatVersion, createdAt, app, modules, skippedModules, files };
}

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

export type ReadPackageOptions = { registry?: ModuleRegistry };

function envelopeVersion(header: Uint8Array): unknown {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
    return isRecord(parsed) ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Zip exterior de un paquete cifrado -> bytes del zip interior. */
async function decryptOuter(opened: OpenedZip, password: string | undefined): Promise<Uint8Array> {
  // La capa EXTERNA tiene su propio presupuesto de inflado (envelope.json + payload.bin): lo que gasta aqui no es lo que
  // despues infla el zip INTERIOR. Con un unico presupuesto de 250 MiB, un paquete cifrado de mas de ~125 MiB gastaba la
  // mitad en `payload.bin` y la otra mitad en sus PDF, y la app no podia reabrir lo que ella misma exportaba.
  const budget: InflateBudget = { remaining: PACKAGE_LIMITS.maxUncompressedBytes };
  const names = opened.entries.map((entry) => entry.name).sort();
  if (names.length !== 2 || names[0] !== ENVELOPE_NAME || names[1] !== PAYLOAD_NAME) {
    throw new PackageError("badZip");
  }
  const header = await mustRead(opened, ENVELOPE_NAME, PACKAGE_LIMITS.maxEnvelopeBytes, budget);
  const payload = await mustRead(opened, PAYLOAD_NAME, PACKAGE_LIMITS.maxFileBytes, budget);
  const version = envelopeVersion(header);
  if (typeof version === "number" && Number.isInteger(version) && version > PACKAGE_FORMAT_VERSION) {
    throw new PackageError("newerFormat");
  }
  const expect = { kind: PACKAGE_ENCRYPTED_KIND, version: PACKAGE_FORMAT_VERSION };
  try {
    assertPasswordBoxShape({ header, payload }, expect);
    return await decryptWithPassword({ header, payload }, password, expect);
  } catch (error) {
    if (error instanceof PasswordBoxError) {
      throw new PackageError(
        error.code === "invalidPassword" ? "needsPassword" : error.code,
      );
    }
    throw new PackageError("corrupt");
  }
}

/**
 * Lee y valida un paquete SIN escribir nada. Devuelve la vista previa
 * (modulos, archivos con su estado, avisos). Lanza `PackageError` solo para
 * lo que invalida el paquete ENTERO (zip/manifiesto/rutas/limites/cifrado);
 * un archivo suelto que no cuadra (SHA, tamaño, ausente) se aisla en su
 * `PackageFileRead.status` y el resto sigue siendo importable.
 */
/**
 * Abre el archivo recibido y, si esta cifrado, la caja. Va aparte para que los bytes del zip exterior y del `payload.bin`
 * queden fuera de alcance (y se puedan liberar) antes de inflar el zip interior.
 */
async function openLayers(file: Blob, password: string | undefined): Promise<{ opened: OpenedZip; encrypted: boolean }> {
  if (file.size > PACKAGE_LIMITS.maxFileBytes) throw new PackageError("tooLarge");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > PACKAGE_LIMITS.maxFileBytes) throw new PackageError("tooLarge");

  const outer = await openZip(bytes);
  if (!outer.byName.has(ENVELOPE_NAME)) return { opened: outer, encrypted: false };
  const innerBytes = await decryptOuter(outer, password);
  if (innerBytes.byteLength > PACKAGE_LIMITS.maxFileBytes) throw new PackageError("tooLarge");
  // Sin cajas dentro de cajas: un zip interior que fuera otro paquete
  // cifrado no trae `manifest.json` y se rechaza abajo como `badZip`.
  return { opened: await openZip(innerBytes), encrypted: true };
}

export async function readPackage(
  file: Blob,
  password?: string,
  opts: ReadPackageOptions = {},
): Promise<PackageReadResult> {
  const registry = opts.registry ?? DEFAULT_MODULE_REGISTRY;
  if (!isBlobLike(file)) throw new PackageError("badZip");
  const { opened, encrypted } = await openLayers(file, password);
  // Presupuesto de la capa INTERIOR (el contenido del paquete): <= 250 MiB realmente inflados, como siempre.
  const budget: InflateBudget = { remaining: PACKAGE_LIMITS.maxUncompressedBytes };

  const manifestRaw = parseStrictJson(
    await mustRead(opened, MANIFEST_NAME, PACKAGE_LIMITS.maxManifestBytes, budget),
    PACKAGE_LIMITS.maxManifestBytes,
  );
  const manifest = parseManifest(manifestRaw);

  const warnings: PackageWarning[] = [];
  for (const name of manifest.skippedModules) warnings.push({ code: "unknownModule", module: name });

  // Modulos conocidos y su carpeta -> modulo.
  const folderOwner = new Map<string, string>();
  const moduleData = new Map<string, PackageModuleData>();
  for (const [name, declared] of manifest.modules) {
    const spec = specOf(registry, name);
    if (!spec) {
      warnings.push({ code: "unknownModule", module: name });
      continue;
    }
    for (const folder of spec.folders) folderOwner.set(folder, name);
    const newer = declared.schemaVersion > spec.schemaVersion;
    moduleData.set(name, {
      name,
      declaredSchemaVersion: declared.schemaVersion,
      status: newer ? "newerVersion" : "ok",
      ...(newer ? { message: NEWER_VERSION_MESSAGE } : {}),
      meta: declared.meta,
      files: new Map(),
    });
  }

  const listed = new Set<string>();
  for (const item of manifest.files) {
    listed.add(item.path);
    const folder = item.path.slice(0, item.path.indexOf("/"));
    const owner = folderOwner.get(folder);
    const data = owner ? moduleData.get(owner) : undefined;
    if (!owner || !data) {
      warnings.push({ code: "ignoredFile", path: item.path });
      continue;
    }
    // Modulo mas nuevo: no se lee nada de el (ni se infla).
    if (data.status === "newerVersion") continue;
    const spec = specOf(registry, owner) as PackageModuleSpec;
    const entry = opened.byName.get(item.path);
    const record = (status: PackageFileStatus, fileBytes: Uint8Array | null) => {
      const read: PackageFileRead = {
        path: item.path,
        type: item.type,
        bytes: status === "ok" ? fileBytes : null,
        sha256: item.sha256,
        status,
      };
      data.files.set(item.path, read);
    };
    if (!entry || entry.isDir) {
      record("missing", null);
      continue;
    }
    const cap = item.path.endsWith(".json") ? spec.maxJsonBytes : spec.maxFileBytes;
    // El manifiesto y el zip tienen que decir lo mismo de su tamaño.
    if (entry.uncompressedSize !== item.bytes) {
      record(entry.uncompressedSize > cap ? "tooLarge" : "sizeMismatch", null);
      continue;
    }
    const read = await readCapped(opened.zip, entry, cap, budget);
    if (!read.ok) {
      if (read.status === "budget") throw new PackageError("bomb");
      record(read.status, null);
      continue;
    }
    record((await sha256Hex(read.bytes)) === item.sha256 ? "ok" : "sha256Mismatch", read.bytes);
  }

  for (const entry of opened.entries) {
    if (entry.isDir || entry.name === MANIFEST_NAME || listed.has(entry.name)) continue;
    warnings.push({ code: "unlistedFile", path: entry.name });
  }

  return {
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    app: manifest.app,
    encrypted,
    modules: [...moduleData.values()],
    warnings,
  };
}
