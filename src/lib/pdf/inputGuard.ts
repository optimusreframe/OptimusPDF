import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  closePdfDocument,
  isPdfFile,
  openPdfDocument,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";

/**
 * Comprobacion de la entrada (Wave 6 · U1/U3).
 *
 * Mira un archivo recien elegido SIN procesarlo y dice, con un codigo que la
 * interfaz traduce, si se puede usar: vacio (0 B), no es un PDF (texto, una
 * imagen renombrada), PDF danado o truncado, cifrado (con o sin contrasena de
 * apertura) o demasiado grande. Es lo que permite que el MISMO archivo malo
 * muestre el MISMO mensaje al subirlo y al pulsar «Procesar»: el shell llama a
 * esta funcion en las dos ocasiones (al ejecutar solo si el motor falla, para
 * afinar el codigo generico que haya lanzado la libreria).
 *
 * Puro (sin React) y asincrono. Nada sale del dispositivo: lee unos bytes del
 * principio y del final y, para PDF de hasta `DEEP_OPEN_LIMIT`, abre el
 * documento con el mismo motor de lectura que las miniaturas.
 */

/** Problemas que dejan el archivo inservible: «Procesar» queda desactivado. */
export type BlockingProblem = "emptyFile" | "notPdf" | "corrupt";

export type InputCheck =
  | { status: "ok" }
  /** `tooLarge` avisa pero no bloquea (el navegador puede tener memoria de sobra). */
  | { status: "problem"; code: BlockingProblem | "tooLarge" }
  /**
   * Cifrado estandar. `needsPassword: false` = solo restringe permisos (se abre
   * con la contrasena vacia): se trabaja con una copia sin proteccion y no hace
   * falta pedir nada.
   */
  | { status: "encrypted"; needsPassword: boolean }
  /** Cifrado que no se puede abrir en el navegador (certificado digital...). */
  | { status: "unsupported"; code: PdfErrorCode };

export type InputGuard = (file: File) => Promise<InputCheck>;

/** Por encima de este peso no se abre el documento completo (memoria): solo cabecera y cola. */
export const DEEP_OPEN_LIMIT = 50 * 1024 * 1024;

const HEAD_BYTES = 1024;
const TAIL_BYTES = 64 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ENCRYPT_KEY = Array.from("/Encrypt", (char) => char.charCodeAt(0));

function indexOfBytes(haystack: Uint8Array, needle: readonly number[]): number {
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i += 1) {
    if (haystack[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function readSlice(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** El PDF declara `/Encrypt` en su trailer (cabecera de un linealizado o cola). */
async function declaresEncryption(file: File): Promise<boolean> {
  const head = await readSlice(file, 0, Math.min(file.size, 8 * 1024));
  if (indexOfBytes(head, ENCRYPT_KEY) >= 0) return true;
  if (file.size <= head.length) return false;
  const tail = await readSlice(file, Math.max(0, file.size - TAIL_BYTES), file.size);
  return indexOfBytes(tail, ENCRYPT_KEY) >= 0;
}

export type InputGuardDeps = {
  /** Abre el documento y lo suelta: lanza si no se puede (pdf.js en el navegador). */
  open?: (file: File) => Promise<void>;
  /**
   * Distingue cifrado «solo permisos», «pide contrasena» y «no soportado».
   * Por defecto, `inspectProtection` del motor de Desbloquear (carga perezosa).
   */
  inspect?: (file: File) => Promise<InputCheck>;
};

async function defaultOpen(file: File): Promise<void> {
  const document = await openPdfDocument(file);
  await closePdfDocument(document);
}

async function defaultInspect(file: File): Promise<InputCheck> {
  const { inspectProtection } = await import("@/lib/pdf/unlock");
  const inspection = await inspectProtection(file);
  if (inspection.kind === "unsupported") {
    const certificate = inspection.encryption.securityHandler === "/Adobe.PubSec";
    return {
      status: "unsupported",
      code: certificate ? "certificateEncryption" : "unsupportedSecurityHandler",
    };
  }
  if (inspection.kind === "passwordRequired") return { status: "encrypted", needsPassword: true };
  return inspection.profile.encrypted
    ? { status: "encrypted", needsPassword: false }
    : { status: "ok" };
}

/**
 * Crea la comprobacion. `pdf` indica si hay que tratar el archivo como PDF
 * (herramientas que aceptan PDF); con `false` solo se mira lo basico (vacio,
 * peso), porque un .docx o una foto no tienen cabecera `%PDF-`.
 */
export function createInputGuard(deps: InputGuardDeps = {}): InputGuard {
  const open = deps.open ?? defaultOpen;
  const inspect = deps.inspect ?? defaultInspect;

  return async (file) => {
    if (file.size === 0) return { status: "problem", code: "emptyFile" };
    if (!isPdfFile(file)) {
      return file.size > MAX_SAFE_FILE_SIZE
        ? { status: "problem", code: "tooLarge" }
        : { status: "ok" };
    }

    const head = await readSlice(file, 0, Math.min(file.size, HEAD_BYTES));
    if (indexOfBytes(head, PDF_MAGIC) < 0) return { status: "problem", code: "notPdf" };
    if (file.size > MAX_SAFE_FILE_SIZE) return { status: "problem", code: "tooLarge" };

    const declares = await declaresEncryption(file);

    if (file.size <= DEEP_OPEN_LIMIT) {
      try {
        await open(file);
      } catch (error) {
        const code = error instanceof PdfError ? error.code : toPdfError(error).code;
        if (code === "encrypted") {
          try {
            return await inspect(file);
          } catch {
            return { status: "encrypted", needsPassword: true };
          }
        }
        // Un componente que no se pudo descargar (sin conexion) NO es un archivo danado: se dice como es.
        if (code === "offline") return { status: "unsupported", code };
        return { status: "problem", code: "corrupt" };
      }
    }

    if (!declares) return { status: "ok" };
    // Abre sin contrasena pero declara cifrado: solo restringe permisos, o es
    // un falso positivo (el texto «/Encrypt» dentro del contenido). Se comprueba.
    try {
      return await inspect(file);
    } catch {
      return { status: "ok" };
    }
  };
}

/** La comprobacion de produccion: abre con pdf.js y descifra con el motor de Desbloquear. */
export const browserInputGuard: InputGuard = createInputGuard();

/* ------------------------------------------------------------------ *
 * Copia sin contrasena
 * ------------------------------------------------------------------ */

export type DecryptAttempt =
  | { status: "ok"; file: File }
  | { status: "wrongPassword" }
  /** Cifrado que este navegador no abre (certificado, manejador desconocido). */
  | { status: "unsupported"; code: PdfErrorCode }
  | { status: "failed"; code: PdfErrorCode };

/**
 * Descifra EN MEMORIA una copia del PDF con `password` (vacia = solo permisos).
 * Nunca toca el archivo original ni guarda la contrasena.
 */
export async function decryptInputCopy(file: File, password: string): Promise<DecryptAttempt> {
  try {
    const { decryptPdfCopy } = await import("@/lib/pdf/unlock");
    const blob = await decryptPdfCopy(file, password);
    const copy = new File([blob], file.name, {
      type: "application/pdf",
      lastModified: file.lastModified,
    });
    markDecryptedCopy(copy);
    // Contrasena vacia = el PDF solo restringia edicion/impresion: no hubo contrasena que quitar.
    if (password === "") restrictionOnlyCopies.add(copy);
    return { status: "ok", file: copy };
  } catch (error) {
    const code = error instanceof PdfError ? error.code : toPdfError(error).code;
    if (code === "wrongPassword") return { status: "wrongPassword" };
    if (code === "certificateEncryption" || code === "unsupportedSecurityHandler") {
      return { status: "unsupported", code };
    }
    return { status: "failed", code };
  }
}

/*
 * Las copias descifradas se marcan en un WeakSet para que cualquier consumidor
 * (borradores de Firmar, historial...) pueda negarse a guardarlas: un borrador
 * de un PDF protegido dejaria su contenido sin el cifrado en el navegador.
 */
const decryptedCopies = new WeakSet<File>();
const restrictionOnlyCopies = new WeakSet<File>();
/** La copia salio de un PDF «solo-propietario» (restricciones, sin contrasena de apertura). */
export function isRestrictionOnlyCopy(file: File): boolean {
  return restrictionOnlyCopies.has(file);
}
export function markDecryptedCopy(file: File): void {
  decryptedCopies.add(file);
}
export function isDecryptedCopy(file: File): boolean {
  return decryptedCopies.has(file);
}
