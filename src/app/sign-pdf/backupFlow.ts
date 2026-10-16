import { listVault } from "@/app/sign-pdf/signVault";
import { passwordBoxAvailable } from "@/lib/crypto/passwordBox";
import {
  PackageError,
  buildPackage,
  readPackage,
  type PackageErrorCode,
} from "@/lib/backup/package";
import {
  applySignaturesImport,
  exportSignatures,
  planSignaturesImport,
  type ImportPlan,
} from "@/lib/backup/modules/signatures";

/**
 * Logica de «Exportar todas mis firmas» / «Importar firmas» (U4.4-UI), sin interfaz: contrasena (minimo y medidor),
 * nombre de archivo, exportar con o sin cifrado, compartir en iPad, leer un paquete y traducir cada fallo a una clave
 * de mensaje. La interfaz (`SignatureBackupSheet.tsx`) solo pinta lo que esto decide. Nada de aqui sale del dispositivo:
 * `navigator.share` abre la hoja de compartir del sistema con el archivo (el usuario elige el destino).
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Contrasena                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** Minimo razonable para un archivo que puede acabar en el correo o en la nube. */
export const MIN_PASSWORD_LENGTH = 8;

const COMMON_PASSWORDS = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "password",
  "password1",
  "contrasena",
  "contraseña",
  "qwertyui",
  "qwertyuiop",
  "abcdefgh",
  "abcd1234",
  "11111111",
  "00000000",
  "firmas123",
  "optimuspdf",
]);

function codePoints(text: string): number {
  return Array.from(text).length;
}

function characterClasses(text: string): number {
  let classes = 0;
  if (/\p{Ll}/u.test(text)) classes += 1;
  if (/\p{Lu}/u.test(text)) classes += 1;
  if (/\p{Nd}/u.test(text)) classes += 1;
  if (/[^\p{L}\p{Nd}]/u.test(text)) classes += 1;
  return classes;
}

/**
 * 0 = no vale (vacia o por debajo del minimo), 1 = floja (cumple el minimo pero es corta/simple/comun),
 * 2 = buena, 3 = fuerte. Es una guia para el medidor, no una garantia: lo que BLOQUEA es solo el minimo.
 */
export type PasswordLevel = 0 | 1 | 2 | 3;

export function passwordStrength(password: string): PasswordLevel {
  const length = codePoints(password);
  if (password.trim() === "" || length < MIN_PASSWORD_LENGTH) return 0;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 1;
  const distinct = new Set(Array.from(password)).size;
  if (distinct <= 2) return 1;
  const classes = characterClasses(password);
  if (length >= 16 || (length >= 12 && classes >= 3)) return 3;
  if (length >= 12 || (length >= 10 && classes >= 2)) return 2;
  return classes >= 3 ? 2 : 1;
}

export type PasswordCheck = "ok" | "empty" | "tooShort" | "mismatch";

/** Validacion al ELEGIR una contrasena para cifrar (la de importar solo exige que no este vacia). */
export function checkNewPassword(password: string, repeat: string): PasswordCheck {
  if (password.trim() === "") return "empty";
  if (codePoints(password) < MIN_PASSWORD_LENGTH) return "tooShort";
  if (password !== repeat) return "mismatch";
  return "ok";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Exportar                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `firmas-optimuspdf-AAAA-MM-DD.optimuspdf.zip` con la fecha LOCAL (la que el usuario ve en su calendario). */
export function backupFilename(date: Date = new Date()): string {
  return `firmas-optimuspdf-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}.optimuspdf.zip`;
}

export type ExportFailure = "empty" | "unavailable" | "encryptionUnavailable" | "tooLarge" | "failed";

export type ExportBuildResult =
  | { ok: true; blob: Blob; filename: string; count: number; encrypted: boolean }
  | { ok: false; reason: ExportFailure };

export type ExportBuildOptions = {
  /** Con valor, el paquete entero se cifra con ella. Sin valor, queda en claro. */
  password?: string;
  now?: Date;
};

/** Empaqueta TODO el baul actual (nunca un subconjunto); no escribe ni descarga nada. */
export async function buildSignaturesExport(
  options: ExportBuildOptions = {},
): Promise<ExportBuildResult> {
  const password = options.password === "" ? undefined : options.password;
  if (password !== undefined && !passwordBoxAvailable()) {
    return { ok: false, reason: "encryptionUnavailable" };
  }
  try {
    const signaturesModule = await exportSignatures();
    const count = typeof signaturesModule.meta?.count === "number" ? signaturesModule.meta.count : 0;
    if (count === 0) return { ok: false, reason: "empty" };
    const blob = await buildPackage({ modules: [signaturesModule], password });
    return {
      ok: true,
      blob,
      filename: backupFilename(options.now),
      count,
      encrypted: password !== undefined,
    };
  } catch (error) {
    if (error instanceof PackageError) {
      if (error.code === "tooLarge") return { ok: false, reason: "tooLarge" };
      if (error.code === "unavailable") {
        return { ok: false, reason: password !== undefined ? "encryptionUnavailable" : "unavailable" };
      }
    }
    return { ok: false, reason: "failed" };
  }
}

type ShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/** `true` si el navegador puede compartir ESTE archivo con la hoja de compartir del sistema (iPad, movil). */
export function canShareFile(file: File): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as ShareNavigator;
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Abre la hoja de compartir del sistema. Debe llamarse DENTRO del manejador del toque (Safari exige un gesto reciente:
 * por eso la interfaz construye el archivo antes y comparte en un segundo toque). Cerrar la hoja sin elegir destino
 * (`AbortError`) es `cancelled` y NO cuenta como exportado.
 */
export async function shareFile(file: File): Promise<ShareOutcome> {
  try {
    await (navigator as ShareNavigator).share?.({ files: [file], title: file.name });
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
  }
}

/** `Blob` -> `File` con su nombre (lo que pide `navigator.share`). */
export function toFile(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: "application/zip" });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Importar                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** Clave del mensaje (ES/EN) de cada fallo al leer un paquete. Nunca lleva datos del archivo. */
export type ReadFailure =
  | "badFile"
  | "tooLarge"
  | "unsafe"
  | "damaged"
  | "newer"
  | "needsPassword"
  | "wrongPassword"
  | "unavailable"
  | "noSignatures"
  | "generic";

export function readFailureFor(code: PackageErrorCode): ReadFailure {
  switch (code) {
    case "badZip":
      return "badFile";
    case "tooLarge":
    case "tooManyEntries":
      return "tooLarge";
    case "bomb":
    case "unsafePath":
    case "duplicateEntry":
      return "unsafe";
    case "invalidManifest":
    case "invalidJson":
    case "corrupt":
      return "damaged";
    case "newerFormat":
      return "newer";
    case "needsPassword":
      return "needsPassword";
    case "wrongPassword":
      return "wrongPassword";
    case "unavailable":
      return "unavailable";
    default:
      return "generic";
  }
}

export type ReadBackupResult =
  | { ok: true; plan: ImportPlan; encrypted: boolean }
  | { ok: false; reason: ReadFailure; code?: PackageErrorCode };

/**
 * Lee el paquete SIN escribir nada y planifica la fusion con el baul actual. `needsPassword` / `wrongPassword` los
 * resuelve la interfaz pidiendo (o repitiendo) la contrasena; un paquete valido sin firmas o con el modulo de una
 * version mas nueva se dice con claridad en vez de abrir una vista previa vacia.
 */
export async function readSignaturesBackup(
  file: Blob,
  password?: string,
): Promise<ReadBackupResult> {
  try {
    const read = await readPackage(file, password === "" ? undefined : password);
    const vault = await listVault();
    const plan = await planSignaturesImport(read, vault.entries);
    if (plan.state === "newerVersion") return { ok: false, reason: "newer" };
    if (plan.state === "damaged") return { ok: false, reason: "damaged" };
    if (plan.state === "absent") return { ok: false, reason: "noSignatures" };
    return { ok: true, plan, encrypted: read.encrypted };
  } catch (error) {
    if (error instanceof PackageError) {
      return { ok: false, reason: readFailureFor(error.code), code: error.code };
    }
    return { ok: false, reason: "generic" };
  }
}

export type ImportSummary = {
  imported: number;
  skipped: number;
  replaced: number;
};

export type ApplyBackupResult =
  | { ok: true; summary: ImportSummary }
  | { ok: false; reason: "limit" | "unavailable" | "invalid" | "blocked"; fits?: number; wanted?: number };

/** Aplica lo aprobado (atomico: todo o nada) y resume «N importadas, M omitidas». */
export async function applyBackupImport(
  plan: ImportPlan,
  decisions: Parameters<typeof applySignaturesImport>[1],
): Promise<ApplyBackupResult> {
  const result = await applySignaturesImport(plan, decisions);
  if (!result.ok) {
    return { ok: false, reason: result.reason, fits: result.fits, wanted: result.wanted };
  }
  return {
    ok: true,
    summary: { imported: result.written, skipped: result.skipped, replaced: result.replaced },
  };
}
