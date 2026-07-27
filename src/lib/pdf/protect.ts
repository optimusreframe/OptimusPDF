import type { SecurityOptions } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de proteccion con contrasena.
 *
 * `@cantoo/pdf-lib` (fork de pdf-lib) expone `PDFDocument.encrypt(options)`
 * con `userPassword`, `ownerPassword` y `permissions` — comprobado en
 * `node_modules/@cantoo/pdf-lib/cjs/api/PDFDocument.d.ts` (linea 772) y en
 * `core/security/PDFSecurity.d.ts`. El cifrado se aplica al serializar,
 * tanto con flujos de objetos como sin ellos, asi que `savePdfToBlob`
 * sirve tal cual.
 *
 * Decisiones explicitas:
 * - `ownerPassword` = `userPassword`. Quien conozca la contrasena
 *   conserva el control completo del documento; no se genera una
 *   contrasena de propietario oculta que nadie podria recuperar.
 * - Se conceden TODOS los permisos. Si no se pasa `permissions`, la
 *   libreria pone a cero todos los bits y el PDF saldria sin permiso de
 *   impresion ni de copia, algo que el usuario no ha pedido: esta
 *   herramienta solo anade contrasena de apertura.
 */

/** Longitud minima exigida para no ofrecer una falsa sensacion de seguridad. */
export const MIN_PASSWORD_LENGTH = 4;

/**
 * Permisos completos. Los indicadores de permisos del estandar PDF son
 * declarativos: los respeta el lector, no el archivo. Como esta
 * herramienta no promete restricciones, se conceden todos.
 */
const FULL_PERMISSIONS: SecurityOptions["permissions"] = {
  printing: "highResolution",
  modifying: true,
  copying: true,
  annotating: true,
  fillingForms: true,
  contentAccessibility: true,
  documentAssembly: true,
};

export type ProtectOptions = {
  password: string;
  confirm: string;
};

export const DEFAULT_PROTECT_OPTIONS: ProtectOptions = {
  password: "",
  confirm: "",
};

/** Motivos por los que el formulario no es valido todavia. */
export type ProtectFailure = "empty" | "tooShort" | "mismatch";

/**
 * Error de validacion del formulario. Hereda de `PdfError` con codigo
 * `unknown` para que `ToolShell` lo trate como cualquier otro fallo,
 * mientras la propia herramienta muestra el motivo exacto en linea.
 */
export class ProtectValidationError extends PdfError {
  readonly reason: ProtectFailure;

  constructor(reason: ProtectFailure) {
    super("unknown", `protect:${reason}`);
    this.name = "ProtectValidationError";
    this.reason = reason;
  }
}

export function validateProtectOptions(
  options: ProtectOptions,
): ProtectFailure | null {
  if (options.password.length === 0) return "empty";
  if (options.password.length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (options.password !== options.confirm) return "mismatch";
  return null;
}

/* ------------------------------------------------------------------ *
 * Medidor de fortaleza
 * ------------------------------------------------------------------ */

export type PasswordStrength = "weak" | "medium" | "strong";

export type PasswordStrengthResult = {
  /** Puntuacion 0..4, util para pintar el medidor. */
  score: number;
  level: PasswordStrength;
};

/**
 * Medidor deliberadamente simple y explicable: longitud + variedad de
 * familias de caracteres. No pretende estimar entropia real ni sustituir
 * a un gestor de contrasenas.
 */
export function passwordStrength(password: string): PasswordStrengthResult {
  if (password.length === 0) return { score: 0, level: "weak" };

  const families = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (families >= 2) score += 1;
  if (families >= 3) score += 1;

  const level: PasswordStrength =
    score >= 4 ? "strong" : score >= 2 ? "medium" : "weak";
  return { score, level };
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */

/**
 * Cifra el documento. Si el PDF de entrada ya venia protegido, `loadPdf`
 * lanza `PdfError("encrypted")` y la interfaz pide desbloquearlo antes.
 */
export async function protectPdf(
  file: File,
  options: ProtectOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const failure = validateProtectOptions(options);
  if (failure) throw new ProtectValidationError(failure);

  try {
    const document = await loadPdf(file);
    onProgress?.(0.35);

    document.encrypt({
      userPassword: options.password,
      ownerPassword: options.password,
      permissions: FULL_PERMISSIONS,
    });
    onProgress?.(0.6);

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
