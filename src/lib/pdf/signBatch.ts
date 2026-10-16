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
  copyFilename,
  signedFilename,
  uniqueNames,
  zipFilename,
  type NameLang,
} from "@/lib/pdf/signOutputNames";
import { MAX_COPIES, isValidCopies } from "@/lib/pdf/signCopies";

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
 * Copias (Firma agil, U1.1): `document.copies` (1..5, ausente = 1) escribe el MISMO PDF firmado N veces en el ZIP con
 * nombres distintos (`<nombre>-firmado.pdf`, `<nombre>-firmado (copia 2).pdf`...). Se firma UNA vez por documento (`sign`
 * se llama una vez), el orden es estable (por documento, y dentro de cada uno la copia 1 antes que las demas) y los
 * limites se comprueban ANTES de firmar nada. Con copias el resultado es siempre un ZIP, aunque haya un solo documento.
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
  /** Copias que se entregan, 1..`MAX_COPIES` (la primera cuenta). Ausente = 1. */
  copies?: number;
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
  /** Archivos que se entregan contando las copias. Por defecto `MAX_ZIP_FILES` (100). La herramienta pasa su tope (50). */
  maxFiles?: number;
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

/** Un archivo de la entrega: de que documento es y que copia (1 = el original). */
export type SignBatchFile = {
  documentId: string;
  /** Nombre dentro del ZIP (o del PDF unico). */
  filename: string;
  copy: number;
};

/** Compatible con `ProcessResult` de `ToolShell` (que ignora `mimeType`). */
export type SignBatchResult = {
  blob: Blob;
  filename: string;
  mimeType: "application/pdf" | "application/zip";
  /** Un elemento por DOCUMENTO (con el nombre de su primer archivo), con o sin copias. */
  report: BatchReport;
  /** Todos los archivos entregados, en el orden del ZIP (con las copias). */
  files: SignBatchFile[];
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
  // Copias: antes de firmar nada. Un valor fuera de 1..MAX_COPIES es un error de quien llama, no algo que se «arregle».
  const copiesByDocument = documents.map((doc) => doc.copies ?? 1);
  for (const copies of copiesByDocument) {
    if (!isValidCopies(copies)) {
      throw new PdfError(
        typeof copies === "number" && copies > MAX_COPIES ? "tooLarge" : "unknown",
        `sign:invalidCopies ${String(copies)}`,
      );
    }
  }
  const maxFiles = params.limits?.maxFiles ?? MAX_ZIP_FILES;
  const fileTotal = copiesByDocument.reduce((sum, copies) => sum + copies, 0);
  if (fileTotal > maxFiles) {
    throw new PdfError("tooLarge", `sign:tooManyFiles ${fileTotal} > ${maxFiles}`);
  }
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
    /** Archivos que se escriben de este documento (1 = solo el original). */
    copies: number;
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
      // Cada copia pesa lo que el original: el tope de salida cuenta los N archivos.
      outputBytes += output.bytes.length * copiesByDocument[index];
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
        copies: copiesByDocument[index],
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

  // Un solo documento de entrada y sin copias: PDF suelto, sin ZIP (como hoy).
  if (total === 1 && signed[0].copies === 1) {
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
      files: [{ documentId: only.document.id, filename: only.filename, copy: 1 }],
      ...(params.record && only.entry
        ? { record: buildSigningRecord([only.entry], lang) }
        : {}),
    };
  }

  // Varios archivos: ZIP con los buenos (aunque haya fallado alguno). Cada documento escribe su original y sus copias,
  // una detras de otra, SIN volver a firmar: son los mismos bytes con otro nombre.
  const planned = signed.flatMap((item) =>
    Array.from({ length: item.copies }, (_, offset) => ({
      item,
      copy: offset + 1,
      wanted: copyFilename(item.filename, offset + 1, lang),
    })),
  );
  const entryNames = uniqueNames(planned.map((file) => file.wanted));
  // Nombre real (dentro del ZIP) del original de cada documento: las copias del registro lo citan.
  const originalName = new Map<Signed, string>();
  planned.forEach((file, position) => {
    if (file.copy === 1) originalName.set(file.item, entryNames[position]);
  });
  // El registro cita cada PDF con el nombre que de verdad tiene dentro del ZIP.
  const record = params.record
    ? buildSigningRecord(
        planned.flatMap((file, position) =>
          file.item.entry
            ? [
                {
                  ...file.item.entry,
                  file: entryNames[position],
                  ...(file.copy > 1 ? { copyOf: originalName.get(file.item) } : {}),
                },
              ]
            : [],
        ),
        lang,
      )
    : undefined;
  try {
    const Zip = await loadJSZip();
    const zip = new Zip();
    planned.forEach((file, position) => {
      zip.file(entryNames[position], file.item.bytes, { createFolders: false });
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
        ok: signed.map((item) => ({
          id: item.document.id,
          name: item.document.name,
          filename: originalName.get(item) as string,
        })),
        failed,
      },
      files: planned.map((file, position) => ({
        documentId: file.item.document.id,
        filename: entryNames[position],
        copy: file.copy,
      })),
      ...(record && record.documents.length > 0 ? { record } : {}),
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
