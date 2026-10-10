import { PDFDocument, PDFName, PDFSignature } from "@cantoo/pdf-lib";
import { PdfError, readFileBytes, type PdfErrorCode } from "@/lib/pdf/core";
import { inspectFlattenLoss } from "@/lib/pdf/editTextExport";
import { UnlockError, decryptPdfCopy, inspectProtection } from "@/lib/pdf/unlock";

/**
 * Preparacion del documento antes de abrir el editor (Wave 5 · U5).
 *
 * Averigua, SIN modificar el archivo del usuario, lo que hay que decirle:
 *  - si esta cifrado (pide contrasena, o se abre con la vacia: PDF que solo
 *    bloquean permisos) y, en ambos casos, produce una copia de TRABAJO sin
 *    cifrar con la que funcionan pdf.js (vista previa) y pdf-lib (exportacion);
 *  - si tiene firmas digitales activas (`active`), o no se pudo comprobar
 *    (`unknown`: nunca se interpreta como «sin firmas»);
 *  - cuantos campos de formulario (AcroForm, sin contar los de firma) trae.
 *
 * Es un modulo asincrono puro (sin React) para poder probarlo con PDFs reales.
 */

/*
 * El estado de preparacion y la pagina visible sobreviven a que el area de trabajo se
 * desmonte (el shell la retira mientras exporta): al volver de una cancelacion o de
 * un error NO se vuelve a pedir la contrasena ni se pierde la pagina. Se cuelgan del
 * objeto `File` (se olvidan solos con el).
 */
const preparedByFile = new WeakMap<File, PreparedDocument>();
const pageByFile = new WeakMap<File, number>();
export const getPreparedFor = (file: File): PreparedDocument | undefined => preparedByFile.get(file);
export const setPreparedFor = (file: File, document: PreparedDocument): void => {
  preparedByFile.set(file, document);
};
export const getRememberedPage = (file: File): number => pageByFile.get(file) ?? 0;
export const setRememberedPage = (file: File, page: number): void => {
  pageByFile.set(file, page);
};

export type SignatureState = "none" | "active" | "unknown";

export type PreparedDocument = {
  /** Archivo con el que trabajan el lienzo y la exportacion (sin cifrado). */
  file: File;
  /** El original estaba cifrado: la copia editada ira sin contrasena. */
  wasEncrypted: boolean;
  signatures: SignatureState;
  /** Campos de formulario que no son de firma. */
  formFields: number;
  /**
   * (W5-U5) Lo que aplanar una pagina descartaria de TODO el documento (se reconstruye):
   * campos de formulario y/o marcadores. `null` si no hay nada de eso.
   */
  flattenLoss: FlattenLoss | null;
};

export type PrepareResult =
  | { status: "ready"; document: PreparedDocument }
  /** Hace falta una contrasena (la vacia no abre el documento). */
  | { status: "password" }
  /** Se aporto una contrasena y no abre el documento. */
  | { status: "wrongPassword" }
  /** Cifrado que no se puede abrir en el navegador (p. ej. por certificado). */
  | { status: "unsupported"; code: PdfErrorCode }
  | { status: "error"; code: PdfErrorCode };

export type FlattenLoss = { forms: boolean; outlines: boolean };

function formFieldsOf(document: PDFDocument): number {
  try {
    // Sin /AcroForm no hay nada que contar: `getForm()` lo crearia en memoria.
    if (!document.catalog.has(PDFName.of("AcroForm"))) return 0;
    const fields = document.getForm().getFields();
    return fields.filter((field) => !(field instanceof PDFSignature)).length;
  } catch {
    return 0;
  }
}

/** Campos de formulario del documento que no son firmas. Nunca lanza: ante la duda, 0. */
export async function countFormFields(bytes: Uint8Array): Promise<number> {
  try {
    return formFieldsOf(await PDFDocument.load(bytes, { updateMetadata: false }));
  } catch {
    return 0;
  }
}

/** Campos de formulario y lo que aplanar descartaria (una sola carga del documento). Nunca lanza. */
export async function inspectStructure(
  bytes: Uint8Array,
): Promise<{ formFields: number; flattenLoss: FlattenLoss | null }> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const formFields = formFieldsOf(document);
    const loss = inspectFlattenLoss(document);
    return {
      formFields,
      flattenLoss: loss && loss.kind === "flatten-drops-forms" ? { forms: loss.forms, outlines: loss.outlines } : null,
    };
  } catch {
    return { formFields: 0, flattenLoss: null };
  }
}

const PUBSEC_FILTER = "Adobe.PubSec";

/**
 * Inspecciona y prepara `file`. `password` solo se aporta cuando la persona la
 * escribio; sin ella se prueba la vacia automaticamente (como hace Desbloquear).
 */
export async function prepareEditDocument(
  file: File,
  password?: string,
): Promise<PrepareResult> {
  let signatures: SignatureState = "unknown";
  let wasEncrypted = false;
  let work = file;

  try {
    const inspection = await inspectProtection(
      file,
      password !== undefined ? { password } : undefined,
    );
    if (inspection.kind === "passwordRequired") return { status: "password" };
    if (inspection.kind === "unsupported") {
      const certificate = inspection.encryption.securityHandler === PUBSEC_FILTER;
      return {
        status: "unsupported",
        code: certificate ? "certificateEncryption" : "unsupportedSecurityHandler",
      };
    }
    signatures = inspection.profile.hasActiveSignatures ? "active" : "none";
    wasEncrypted = inspection.profile.encrypted;
  } catch (error) {
    if (error instanceof UnlockError) {
      if (error.reason === "wrongPassword") return { status: "wrongPassword" };
      // Estructura que no se pudo comprobar con seguridad: se sigue, pero NO se afirma que no haya firmas.
      if (error.reason !== "inspectionIncomplete") {
        return { status: "error", code: error.code };
      }
    } else if (error instanceof PdfError) {
      return { status: "error", code: error.code };
    } else {
      return { status: "error", code: "unknown" };
    }
  }

  try {
    if (wasEncrypted) {
      const blob = await decryptPdfCopy(file, password ?? "");
      work = new File([blob], file.name, {
        type: "application/pdf",
        lastModified: file.lastModified,
      });
    }
    const { formFields, flattenLoss } = await inspectStructure(await readFileBytes(work));
    return { status: "ready", document: { file: work, wasEncrypted, signatures, formFields, flattenLoss } };
  } catch (error) {
    if (error instanceof UnlockError) {
      if (error.reason === "wrongPassword") return { status: "wrongPassword" };
      return { status: "error", code: error.code };
    }
    if (error instanceof PdfError) return { status: "error", code: error.code };
    return { status: "error", code: "unknown" };
  }
}
