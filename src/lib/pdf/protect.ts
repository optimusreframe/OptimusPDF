import { PDFDocument } from "@cantoo/pdf-lib";
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
 * - `ownerPassword` SIEMPRE es `options.password`, exista o no
 *   contrasena de apertura. Sin un owner password real, cualquiera
 *   autentica como propietario y los permisos no significan nada.
 * - Por defecto se conceden TODOS los permisos (undefined en cada
 *   `allow*` se lee como `true`). Si no se pasara `permissions`, la
 *   libreria pone a cero todos los bits y el PDF saldria sin permiso de
 *   impresion ni de copia, algo que el usuario no ha pedido.
 */

/** Longitud minima exigida para no ofrecer una falsa sensacion de seguridad. */
export const MIN_PASSWORD_LENGTH = 4;

export type ProtectOptions = {
  password: string;
  confirm: string;
  /**
   * Opcional: `undefined` se lee como `true` (comportamiento actual, no
   * rompe callers existentes). En `false`, el PDF resultante se abre
   * sin pedir contrasena, pero sigue cifrado con `ownerPassword` para
   * que los permisos restringidos tengan sentido.
   */
  requirePasswordToOpen?: boolean;
  /**
   * Todos los `allow*` son opcionales: `undefined` se lee como `true`
   * (permiso concedido, igual que el comportamiento actual). Campos
   * PLANOS a proposito -- ver comentario de `buildPermissions` para el
   * porque de no usar un objeto `permissions` anidado.
   */
  allowPrinting?: boolean;
  allowCopying?: boolean;
  allowModifying?: boolean;
  allowAnnotating?: boolean;
  allowFillingForms?: boolean;
  allowDocumentAssembly?: boolean;
  // No hay campo para contentAccessibility: se fija siempre en `true`
  // dentro del motor (bit de accesibilidad para lectores de pantalla),
  // nunca se expone a la UI.
};

export const DEFAULT_PROTECT_OPTIONS: ProtectOptions = {
  password: "",
  confirm: "",
};

/** Motivos por los que el formulario no es valido todavia. */
export type ProtectFailure =
  | "empty"
  | "tooShort"
  | "unsupportedChars"
  | "mismatch"
  | "nothingToDo";

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

/**
 * `true` cuando la combinacion pedida no cifra nada de verdad: no exige
 * contrasena de apertura Y no restringe ningun permiso. Ese PDF sale
 * cifrado (la libreria exige `ownerPassword`) sin pedir nada al abrirlo
 * y sin limitar nada dentro -- puro costo, cero beneficio.
 */
function isNothingToDo(options: ProtectOptions): boolean {
  if ((options.requirePasswordToOpen ?? true) !== false) return false;
  return (
    (options.allowPrinting ?? true) &&
    (options.allowCopying ?? true) &&
    (options.allowModifying ?? true) &&
    (options.allowAnnotating ?? true) &&
    (options.allowFillingForms ?? true) &&
    (options.allowDocumentAssembly ?? true)
  );
}

/**
 * Caracteres de la contrasena que el cifrado del PDF no admite, sin repetir y en el orden en que
 * aparecen. El cifrado que aplica la libreria (RC4/AES-128, revisiones R2-R4 del estandar) solo
 * guarda la contrasena como bytes Latin-1: `PDFSecurity.processPasswordR2R3R4` lanza «Password
 * contains one or more invalid characters» con cualquier unidad UTF-16 > U+00FF (euro, chino, emoji).
 * La variante AES-256 de la libreria tampoco codifica UTF-8 (la normalizacion SASLprep esta
 * desactivada), asi que no es una salida: se avisa ANTES de procesar.
 */
export function unsupportedPasswordChars(password: string): string[] {
  const found: string[] = [];
  for (const char of password) {
    // `for...of` recorre por code points: un emoji es UN caracter, no dos mitades sueltas.
    if ((char.codePointAt(0) ?? 0) > 0xff && !found.includes(char)) found.push(char);
  }
  return found;
}

export function validateProtectOptions(
  options: ProtectOptions,
): ProtectFailure | null {
  if (options.password.length === 0) return "empty";
  if (options.password.length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (unsupportedPasswordChars(options.password).length > 0) return "unsupportedChars";
  if (options.password !== options.confirm) return "mismatch";
  if (isNothingToDo(options)) return "nothingToDo";
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
 * Construye el objeto de permisos campo a campo (nunca con spread de un
 * `Partial`): con `exactOptionalPropertyTypes` apagado, `{...FULL,
 * ...partial}` deja que un campo `undefined` explicito sobrescriba un
 * `true` por defecto y termine denegando el permiso por accidente.
 *
 * `printing` es TRI-ESTADO en `SecurityOptions["permissions"]`
 * (`boolean | "lowResolution" | "highResolution"`), no un booleano
 * simple: `{...FULL, printing: true}` no seria equivalente al permiso
 * completo de siempre (perderia el bit de alta resolucion). El mapeo de
 * abajo preserva el comportamiento actual cuando no se toca nada.
 *
 * `contentAccessibility` se fija siempre en `true`: es el bit de
 * accesibilidad para lectores de pantalla, no configurable desde la UI.
 */
function buildPermissions(options: ProtectOptions): SecurityOptions["permissions"] {
  return {
    printing: (options.allowPrinting ?? true) ? "highResolution" : false,
    modifying: options.allowModifying ?? true,
    copying: options.allowCopying ?? true,
    annotating: options.allowAnnotating ?? true,
    fillingForms: options.allowFillingForms ?? true,
    contentAccessibility: true,
    documentAssembly: options.allowDocumentAssembly ?? true,
  };
}

/**
 * Blob devuelto por `protectPdf`, con informacion adicional sobre la
 * revision de cifrado aplicada -- estructuralmente sigue siendo un
 * `Blob` (misma forma que antes, `blob.arrayBuffer()` funciona igual),
 * asi que ningun caller existente que trate el resultado como `Blob`
 * se rompe.
 */
export type ProtectedPdfBlob = Blob & {
  /**
   * Revision (`R`) del cifrado `/Encrypt` que se aplico, predicha desde
   * la version del PDF de entrada. Ver `predictEncryptionRevision`.
   */
  appliedEncryptionRevision: number;
  /**
   * `true` cuando la revision aplicada es antigua (`R < 3`) y el
   * usuario pidio restringir `fillingForms` o `documentAssembly`: esos
   * bits no existen en esa revision (solo existen desde R>=3), asi que
   * la restriccion pedida no tuvo ningun efecto real sobre el PDF
   * resultante.
   */
  legacyRevisionIgnoredRestrictions: boolean;
};

/**
 * Revision (`R`) de cifrado que `@cantoo/pdf-lib` va a aplicar,
 * PREDICHA desde la version del PDF de ENTRADA antes de cifrar (no
 * releyendo el archivo ya cifrado despues: es mas barato y llega a
 * tiempo para poder avisar antes de comprometerse a cifrar, no
 * despues).
 *
 * Verificado contra `PDFSecurity.initialize`
 * (`node_modules/@cantoo/pdf-lib/cjs/core/security/PDFSecurity.js`,
 * lineas 16-34 y 46-67): la revision depende UNICAMENTE de
 * `document.context.header.getVersionString()`, nunca de las opciones
 * de cifrado que pida el usuario. Mapeo exacto replicado aqui:
 * "1.4"/"1.5" -> R3 (128 bits), "1.6"/"1.7" -> R4 (128 bits, AES),
 * "1.7ext3" -> R5, CUALQUIER OTRA cadena -- incluida "1.3" y tambien
 * "2.0" (el switch de la libreria no la contempla y cae al default) --
 * -> R2 (40 bits RC4). En R2 (`getPermissionsR2`) los bits
 * `fillingForms`, `contentAccessibility` y `documentAssembly` no
 * existen en el formato: no se leen en absoluto al calcular `/P`, asi
 * que restringirlos no tiene ningun efecto real sobre un PDF asi -- y
 * ademas el cifrado que se aplica es RC4 de 40 bits, mucho mas debil.
 *
 * A diferencia de una relectura post-cifrado, esta prediccion no tiene
 * un camino de fallo real (la cadena de version siempre esta presente
 * en un documento ya cargado) -- no hace falta un `null` que pueda
 * confundirse con "se verifico y no hay problema".
 */
function predictEncryptionRevision(document: PDFDocument): number {
  switch (document.context.header.getVersionString()) {
    case "1.4":
    case "1.5":
      return 3;
    case "1.6":
    case "1.7":
      return 4;
    case "1.7ext3":
      return 5;
    default:
      return 2;
  }
}

/**
 * Cifra el documento. Si el PDF de entrada ya venia protegido, `loadPdf`
 * lanza `PdfError("encrypted")` y la interfaz pide desbloquearlo antes.
 */
export async function protectPdf(
  file: File,
  options: ProtectOptions,
  onProgress?: ProgressCallback,
): Promise<ProtectedPdfBlob> {
  const failure = validateProtectOptions(options);
  if (failure) throw new ProtectValidationError(failure);

  try {
    const document = await loadPdf(file);
    onProgress?.(0.3);

    // Se predice ANTES de cifrar (barato, sin releer nada) para poder
    // devolver el aviso junto con el resultado sin pagar un segundo
    // parseo completo del documento ya cifrado.
    const appliedEncryptionRevision = predictEncryptionRevision(document);
    const legacyRevisionIgnoredRestrictions =
      appliedEncryptionRevision < 3 &&
      (options.allowFillingForms === false || options.allowDocumentAssembly === false);

    document.encrypt({
      userPassword: (options.requirePasswordToOpen ?? true) ? options.password : "",
      ownerPassword: options.password,
      permissions: buildPermissions(options),
    });
    onProgress?.(0.6);

    const blob = await savePdfToBlob(document);
    onProgress?.(1);

    return Object.assign(blob, {
      appliedEncryptionRevision,
      legacyRevisionIgnoredRestrictions,
    });
  } catch (error) {
    throw toPdfError(error);
  }
}
