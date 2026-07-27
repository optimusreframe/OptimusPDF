import { PDFDocument, PDFInvalidObject, PDFRef } from "@cantoo/pdf-lib";
import type { PDFObject } from "@cantoo/pdf-lib";
import {
  PdfError,
  readFileBytes,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de desbloqueo: abre el PDF con la contrasena que aporta el
 * usuario y lo vuelve a guardar sin cifrado.
 *
 * Detalle del formato que costo encontrar (verificado en Node contra
 * `@cantoo/pdf-lib` 2.7.4): al descifrar, la libreria si limpia la
 * entrada `/Encrypt` del trailer, pero las tablas de referencias
 * cruzadas del archivo original —que en un PDF moderno son objetos
 * indirectos de tipo `/XRef`— no se pueden reinterpretar tras el
 * descifrado y quedan guardadas como objetos "invalidos" que se vuelven
 * a escribir tal cual. Ese bloque arrastra el `/Encrypt` viejo, asi que
 * el archivo resultante seguia anunciandose como cifrado y no se
 * reabria. Por eso se retiran tambien esos restos y el diccionario de
 * cifrado, que ademas contiene los hashes de la contrasena.
 *
 * Esta herramienta NO rompe contrasenas: exige conocerla.
 */

export type UnlockOptions = {
  /**
   * Contrasena actual. La cadena vacia es un valor legitimo: hay PDF
   * cifrados solo para restringir permisos cuya contrasena de usuario
   * esta vacia.
   */
  password: string;
};

export const DEFAULT_UNLOCK_OPTIONS: UnlockOptions = { password: "" };

export type UnlockFailure = "notEncrypted" | "wrongPassword";

/**
 * Error de desbloqueo. Hereda de `PdfError` usando el propio `reason`
 * como codigo (`wrongPassword` / `notEncrypted`), asi que `ToolShell`
 * muestra el mensaje especifico en el banner generico mientras la
 * herramienta ademas resalta el motivo exacto junto al campo de
 * contrasena.
 */
export class UnlockError extends PdfError {
  readonly reason: UnlockFailure;

  constructor(reason: UnlockFailure) {
    super(reason, `unlock:${reason}`);
    this.name = "UnlockError";
    this.reason = reason;
  }
}

/**
 * Reconoce los restos de una tabla de referencias cruzadas que quedaron
 * como objeto invalido tras descifrar. Se inspecciona la cabecera del
 * objeto: un `/XRef` ahi solo puede venir de ese resto.
 */
function looksLikeXrefStream(object: PDFObject): boolean {
  const size = object.sizeInBytes();
  if (size === 0 || size > 1024 * 1024) return false;

  const buffer = new Uint8Array(size);
  object.copyBytesInto(buffer, 0);
  const limit = Math.min(size, 2048);
  let head = "";
  for (let index = 0; index < limit; index += 1) {
    head += String.fromCharCode(buffer[index]);
  }
  return head.includes("/XRef");
}

/**
 * Deja el documento descifrado listo para guardarse como PDF normal.
 * `encryptRef` es la referencia al diccionario de cifrado leida del
 * archivo original (antes de descifrar).
 */
function stripEncryption(
  document: PDFDocument,
  encryptRef: PDFObject | undefined,
): void {
  const context = document.context;
  const doomed: PDFRef[] = [];

  const trailerEncrypt = context.trailerInfo.Encrypt;
  context.trailerInfo.Encrypt = undefined;
  if (trailerEncrypt instanceof PDFRef) doomed.push(trailerEncrypt);
  if (encryptRef instanceof PDFRef) doomed.push(encryptRef);

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject && looksLikeXrefStream(object)) {
      doomed.push(ref);
    }
  }

  for (const ref of doomed) context.delete(ref);
  context.security = undefined;
}

export async function unlockPdf(
  file: File,
  options: UnlockOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");

  // 1) Sondeo sin descifrar: sirve para distinguir "el archivo no estaba
  //    protegido" de "la contrasena no es correcta".
  let probe: PDFDocument;
  try {
    probe = await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch (error) {
    throw toPdfError(error);
  }
  onProgress?.(0.2);

  if (!probe.isEncrypted) throw new UnlockError("notEncrypted");
  // Se anota antes de descifrar: al descifrar, la entrada desaparece del
  // trailer y ya no habria forma de localizar ese objeto para borrarlo.
  const encryptRef = probe.context.trailerInfo.Encrypt;

  // 2) Carga real con contrasena. `pdf-lib` copia los bytes al parsear,
  //    pero se pasa una copia propia para no depender de ese detalle.
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(new Uint8Array(bytes), {
      password: options.password,
      updateMetadata: false,
    });
  } catch {
    // Cualquier fallo aqui, con un documento que ya sabemos cifrado y
    // estructuralmente legible, significa contrasena incorrecta.
    throw new UnlockError("wrongPassword");
  }
  onProgress?.(0.6);

  try {
    // 3) Se retiran el cifrado y sus restos para que la salida sea un PDF
    //    normal y corriente.
    stripEncryption(document, encryptRef);

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
