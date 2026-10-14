import type { Language } from "@/lib/i18n";
import { pdfBytesToBlob, withSuffix } from "@/lib/pdf/core";
import { ProtectValidationError, protectPdfToBytes, validateProtectOptions, type ProtectOptions } from "@/lib/pdf/protect";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { asEngineFile } from "@/app/pdf-pro/ops/opUtils";

/**
 * «Guardar con contraseña…» de PDF Pro (Wave 7 · U5): cifrar es una OPCION DE EXPORTACION, no un paso del
 * historial, porque el resultado cifrado no se puede seguir editando. Esta funcion es PURA respecto al
 * documento de trabajo: recibe bytes, devuelve bytes cifrados y no toca ningun snapshot ni borrador. La
 * unidad de exportacion (U8) la llama desde su panel «Exportar».
 */

export type ProtectedExport = {
  /** El PDF cifrado (nunca se guarda en el historial ni en los borradores). */
  bytes: Uint8Array;
  blob: Blob;
  /** Revision (`R`) del cifrado que se aplico. */
  appliedEncryptionRevision: number;
  /** Se pidio restringir algo que ese cifrado antiguo no puede (formularios / ensamblado). */
  legacyRevisionIgnoredRestrictions: boolean;
};

/**
 * Valida (misma regla que la herramienta suelta, incluida la comprobacion Latin-1 de la contraseña) y
 * cifra. Lanza `ProtectValidationError` si las opciones no valen y `PdfError` si el motor falla.
 */
export async function buildProtectedExport(
  bytes: Uint8Array,
  options: ProtectOptions,
  onProgress?: (progress: number) => void,
): Promise<ProtectedExport> {
  const invalid = validateProtectOptions(options);
  if (invalid) throw new ProtectValidationError(invalid);
  // Wave 10: el motor devuelve los BYTES (sin ir a `Blob` y volver a leerlo) y el `Blob` de la descarga se crea una vez;
  // el motor solo lee el archivo con `loadPdf`, asi que se le da un `File` que sirve los bytes sin copiarlos.
  const { bytes: protectedBytes, appliedEncryptionRevision, legacyRevisionIgnoredRestrictions } = await protectPdfToBytes(
    asEngineFile(bytes),
    options,
    onProgress,
  );
  return {
    bytes: protectedBytes,
    blob: pdfBytesToBlob(protectedBytes),
    appliedEncryptionRevision,
    legacyRevisionIgnoredRestrictions,
  };
}

/** Nombre del archivo protegido: `informe.pdf` → `informe-protegido.pdf` (sufijo de la herramienta suelta). */
export function protectedFileName(name: string, language: Language): string {
  return withSuffix(name, PROTECT_STRINGS[language].filenameSuffix);
}
