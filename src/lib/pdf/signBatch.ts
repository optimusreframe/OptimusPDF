import { loadJSZip } from "@/lib/pdf/lazyZip";
import type { BatchReport } from "@/lib/pdf/batchReport";
import {
  PdfError,
  scaleProgress,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { MAX_ZIP_FILES, MAX_ZIP_TOTAL_BYTES } from "@/lib/pdf/zipLimits";
import {
  buildSigningRecord,
  buildSigningRecordEntry,
  serializeSigningRecord,
  signingRecordFilename,
  type SigningRecord,
  type SigningRecordEntry,
} from "@/lib/pdf/signRecord";
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
 *
 * Registro aparte (opcional, `params.record`): con varios documentos el ZIP
 * lleva ademas `registro-firmas.json` (hash SHA-256 de cada PDF tal como va
 * en el ZIP, fecha, firmantes y paginas); con uno solo el PDF sigue suelto y
 * el registro se devuelve en `result.record` para que la interfaz ofrezca
 * descargarlo. Nunca va dentro del PDF.
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
  /** Solo se edito el texto, sin ninguna firma estampada: el nombre acaba en `-editado`. */
  edited?: boolean;
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
  /**
   * Ausente = sin registro aparte (lo de siempre). Presente: se genera el
   * registro; `noSignerName` es el texto de un firmante sin nombre.
   */
  record?: { noSignerName: string };
};

/** Compatible con `ProcessResult` de `ToolShell` (que ignora `mimeType`). */
export type SignBatchResult = {
  blob: Blob;
  filename: string;
  mimeType: "application/pdf" | "application/zip";
  report: BatchReport;
  /** Solo si se pidio `params.record`. Con varios documentos ya va dentro del ZIP. */
  record?: SigningRecord;
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

  type Signed = {
    document: D;
    bytes: Uint8Array;
    filename: string;
    entry?: SigningRecordEntry;
  };
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
      const filename = signedFilename({
        signerNames: output.signerNames,
        documentName: document.name,
        lang,
        edited: output.edited,
      });
      signed.push({
        document,
        bytes: output.bytes,
        filename,
        // Hash y paginas del archivo EXACTO que se entrega. Un documento solo editado (sin firma) no es «firmado».
        entry:
          params.record && !output.edited
            ? await buildSigningRecordEntry({
                file: filename,
                bytes: output.bytes,
                signerNames: output.signerNames,
                noSignerName: params.record.noSignerName,
              })
            : undefined,
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
      ...(params.record && only.entry
        ? { record: buildSigningRecord([only.entry], lang) }
        : {}),
    };
  }

  // Varios documentos: ZIP con los buenos (aunque haya fallado alguno).
  const entryNames = uniqueNames(signed.map((item) => item.filename));
  // El registro cita cada PDF con el nombre que de verdad tiene dentro del ZIP.
  const record = params.record
    ? buildSigningRecord(
        signed.flatMap((item, position) =>
          item.entry ? [{ ...item.entry, file: entryNames[position] }] : [],
        ),
        lang,
      )
    : undefined;
  try {
    const Zip = await loadJSZip();
    const zip = new Zip();
    signed.forEach((item, position) => {
      zip.file(entryNames[position], item.bytes, { createFolders: false });
    });
    if (record && record.documents.length > 0) {
      zip.file(signingRecordFilename(lang), serializeSigningRecord(record), {
        createFolders: false,
      });
    }
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
      ...(record && record.documents.length > 0 ? { record } : {}),
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
