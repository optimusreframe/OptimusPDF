import JSZip from "jszip";
import type { BatchReport } from "@/lib/pdf/batchReport";
import {
  PdfError,
  scaleProgress,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { MAX_ZIP_FILES, MAX_ZIP_TOTAL_BYTES } from "@/lib/pdf/pdfsToZip";
import {
  signedFilename,
  uniqueNames,
  zipFilename,
  type NameLang,
} from "@/lib/pdf/signOutputNames";

/**
 * Entrega de "Firmar PDF" con varios documentos: firma cada documento por
 * separado (secuencial, para no multiplicar la memoria) y devuelve UN
 * archivo: el PDF firmado si solo hay un documento, o un ZIP con un PDF por
 * documento si hay varios.
 *
 * El motor NO conoce firmantes, bloques ni capturas: recibe la funcion
 * `sign` ya conectada (en la app, a `signPdfMulti`) y solo orquesta
 * progreso, cancelacion, fallos parciales, nombres y empaquetado. Asi no se
 * acopla al estado de la herramienta ni a `sign.ts`.
 *
 * Contrato para quien conecte `sign` (certificado por documento): la MISMA
 * lista de nombres debe alimentar (a) `certificate.signerNames` de
 * `signPdfMulti` y (b) `signerNames` de la respuesta, de modo que el
 * certificado impreso en cada PDF y el prefijo de su nombre de archivo
 * coincidan. Esa lista contiene SOLO a los firmantes que aplican a ESE
 * documento (los de los bloques cuyo `appliesTo` lo incluye), no a todos los
 * firmantes de la sesion. `signPdfMulti` ya lo permite sin cambios: imprime
 * exactamente lo que recibe en `certificate.signerNames`.
 */

/** Lo minimo que el motor necesita de cada documento; quien llama puede anadir mas campos. */
export type SignBatchDocument = {
  /** Identificador estable (no la huella): une el informe con la interfaz. */
  id: string;
  file: File;
  /** Nombre que ve el usuario (normalmente `file.name`). */
  name: string;
};

export type SignBatchSigned = {
  bytes: Uint8Array;
  /** Firmantes que aplican a ESE documento, en orden de aparicion. */
  signerNames: readonly string[];
};

export type SignBatchContext = {
  /** Progreso 0..1 del documento en curso (el motor lo reparte en su tramo). */
  onProgress: ProgressCallback;
  signal?: AbortSignal;
};

export type SignBatchLimits = {
  /** Por defecto `MAX_ZIP_FILES` (100). La herramienta pasa su tope (10). */
  maxDocuments?: number;
  /** Suma de `file.size` de entrada. Por defecto `MAX_ZIP_TOTAL_BYTES` (500 MB). */
  maxTotalBytes?: number;
};

export type SignBatchParams<D extends SignBatchDocument = SignBatchDocument> = {
  documents: readonly D[];
  sign: (document: D, context: SignBatchContext) => Promise<SignBatchSigned>;
  lang: NameLang;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  limits?: SignBatchLimits;
};

/** Compatible con `ProcessResult` de `ToolShell` (que ignora `mimeType`). */
export type SignBatchResult = {
  blob: Blob;
  filename: string;
  mimeType: "application/pdf" | "application/zip";
  report: BatchReport;
};

/** Los documentos ocupan 0..95 %; el 5 % final es empaquetar el ZIP. */
const DOCUMENTS_SHARE = 0.95;

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof PdfError && error.code === "cancelled")
  );
}

export async function signBatch<D extends SignBatchDocument>(
  params: SignBatchParams<D>,
): Promise<SignBatchResult> {
  const { documents, sign, lang, signal } = params;
  const maxDocuments = params.limits?.maxDocuments ?? MAX_ZIP_FILES;
  const maxTotalBytes = params.limits?.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;

  if (documents.length === 0) throw new PdfError("empty");
  if (documents.length > maxDocuments) throw new PdfError("tooLarge");
  const inputBytes = documents.reduce((sum, doc) => sum + doc.file.size, 0);
  if (inputBytes > maxTotalBytes) throw new PdfError("tooLarge");

  // El progreso nunca retrocede aunque `sign` emita valores desordenados.
  let lastProgress = 0;
  const emit = (value: number) => {
    const next = Math.min(1, Math.max(lastProgress, value));
    lastProgress = next;
    params.onProgress?.(next);
  };

  throwIfAborted(signal);
  emit(0);

  type Signed = { document: D; bytes: Uint8Array; filename: string };
  const signed: Signed[] = [];
  const failed: BatchReport["failed"] = [];
  let firstError: PdfError | null = null;
  let outputBytes = 0;

  const total = documents.length;
  for (let index = 0; index < total; index += 1) {
    // Entre documentos: aqui se corta sin dejar nada a medias.
    throwIfAborted(signal);
    const document = documents[index];
    const from = (index / total) * DOCUMENTS_SHARE;
    const to = ((index + 1) / total) * DOCUMENTS_SHARE;

    try {
      const output = await sign(document, {
        onProgress: (value) => emit(scaleProgress(value, from, to)),
        signal,
      });
      if (!(output.bytes instanceof Uint8Array) || output.bytes.length === 0) {
        throw new PdfError("unknown");
      }
      outputBytes += output.bytes.length;
      signed.push({
        document,
        bytes: output.bytes,
        filename: signedFilename({
          signerNames: output.signerNames,
          documentName: document.name,
          lang,
        }),
      });
    } catch (caught) {
      // Cancelar no es un fallo del documento: aborta todo el lote.
      if (isCancellation(caught, signal)) throw new PdfError("cancelled");
      const error = toPdfError(caught);
      firstError ??= error;
      failed.push({ id: document.id, name: document.name, code: error.code });
    }
    emit(to);
  }

  throwIfAborted(signal);

  // Todos fallaron: no hay nada que entregar, se muestra el primer error.
  if (signed.length === 0) throw firstError ?? new PdfError("unknown");
  if (outputBytes > MAX_ZIP_TOTAL_BYTES) throw new PdfError("tooLarge");

  // Un solo documento de entrada: PDF suelto, sin ZIP (como hoy).
  if (total === 1) {
    const only = signed[0];
    const report: BatchReport = {
      ok: [{ id: only.document.id, name: only.document.name, filename: only.filename }],
      failed,
    };
    emit(1);
    return {
      blob: new Blob([only.bytes as unknown as BlobPart], {
        type: "application/pdf",
      }),
      filename: only.filename,
      mimeType: "application/pdf",
      report,
    };
  }

  // Varios documentos: ZIP con los buenos (aunque haya fallado alguno).
  const entryNames = uniqueNames(signed.map((item) => item.filename));
  try {
    const zip = new JSZip();
    signed.forEach((item, position) => {
      zip.file(entryNames[position], item.bytes, { createFolders: false });
    });
    // `generateAsync` no se puede cortar a medias: se comprueba la senal
    // justo antes (mejor esfuerzo), igual que `pdfsToZip.ts`.
    throwIfAborted(signal);
    const blob = await zip.generateAsync({ type: "blob" }, (meta) =>
      emit(scaleProgress(meta.percent / 100, DOCUMENTS_SHARE, 0.99)),
    );
    emit(1);
    return {
      blob,
      filename: zipFilename(signed.length, lang),
      mimeType: "application/zip",
      report: {
        ok: signed.map((item, position) => ({
          id: item.document.id,
          name: item.document.name,
          filename: entryNames[position],
        })),
        failed,
      },
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
