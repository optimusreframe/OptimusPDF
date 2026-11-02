import JSZip from "jszip";
import type { ImageProblem } from "@/lib/image/imageIntegrity";
import { checkImageBytes } from "@/lib/image/imageIntegrity";
import { readImageHeader } from "@/lib/image/prepareForPdf";
import { OUTPUT_FORMAT_INFO, needsBackground, qualityToUnit, type OutputFormat } from "@/lib/media/image/formats";
import { outputFileName, uniqueNames } from "@/lib/media/image/names";
import {
  canvasPixelsFor,
  computeOutputSize,
  type ConvertLimits,
  type OutputSize,
  type ResizeSpec,
} from "@/lib/media/image/sizing";
import { PdfError, throwIfAborted, type PdfErrorCode } from "@/lib/pdf/core";

/**
 * Motor del convertidor de imagenes: decide QUE se hace con cada archivo (comprobar, planificar el tamano, convertir, poner
 * nombre, empaquetar) y deja lo que toca pixeles detras de `ImageBackend` (`browserBackend.ts` en el navegador; las pruebas
 * ponen uno de mentira). Una imagen que falla no detiene a las demas: queda en `failures` con su motivo.
 *
 * Nada sale del dispositivo: se leen bytes del archivo, se decodifican en local y se codifican en local.
 */

/** Por que una imagen no se pudo convertir. Los cuatro primeros y `heic`/`unreadable` vienen de `imageIntegrity`/la decodificacion. */
export type ConvertProblem =
  | ImageProblem
  /** Pesa mas de lo que se atreve a abrir este dispositivo (`maxFileBytes`). */
  | "tooBig"
  /** Mide mas pixeles de los que se atreve a abrir este dispositivo (`maxInputPixels`). */
  | "tooManyPixels"
  /** Se decodifico pero el navegador no pudo crear el formato pedido (o devolvio otro). */
  | "encodeFailed"
  /** El resto de la tanda ya llena la memoria prevista para el ZIP: esta imagen se queda fuera. */
  | "batchFull";

export class ImageConvertError extends Error {
  readonly problem: ConvertProblem;
  constructor(problem: ConvertProblem) {
    super(problem);
    this.name = "ImageConvertError";
    this.problem = problem;
  }
}

export type ConvertOptions = {
  format: OutputFormat;
  /** 1-100. Solo cuenta con JPG, WebP y AVIF. */
  quality: number;
  resize: ResizeSpec;
  /** Color (`#rrggbb`) sobre el que se aplana la transparencia al crear JPG o BMP. */
  background: string;
  /** Palabra que se anade al nombre («foto-convertida.jpg»). */
  suffix: string;
};

/** Lo que el backend necesita para dibujar y codificar UNA imagen. */
export type RenderJob = {
  format: OutputFormat;
  /** 0-1. */
  quality: number;
  /** Color de fondo si el formato no guarda transparencia; `null` si la guarda (se conserva). */
  flatten: string | null;
  /** Tamano de salida para una imagen YA orientada de este tamano. Lanza `ImageConvertError("tooManyPixels")` si no cabe. */
  planSize(source: { width: number; height: number }): OutputSize;
};

export type RenderResult = {
  blob: Blob;
  /** Tamano de la imagen decodificada (con la orientacion EXIF ya aplicada). */
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  capped: boolean;
};

export interface ImageBackend {
  /**
   * Decodifica `file` (primer fotograma si es animado, orientacion EXIF aplicada), lo dibuja al tamano de `job.planSize` y lo
   * codifica. Libera todo lo que reserva. Lanza `ImageConvertError` (`unreadable`, `encodeFailed`, `tooManyPixels`) o rechaza
   * con el motivo de la cancelacion si `signal` se aborta.
   */
  render(file: Blob, job: RenderJob, signal?: AbortSignal): Promise<RenderResult>;
}

export type ConvertItem = {
  sourceName: string;
  sourceBytes: number;
  /** Nombre en el ZIP / de la descarga (ya sin repetidos). */
  outputName: string;
  blob: Blob;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  /** Cambio de tamano pedido por la persona (o por el limite del dispositivo). */
  resized: boolean;
  /** Se redujo mas de lo pedido para caber en el lienzo de este dispositivo. */
  capped: boolean;
};

export type ConvertFailure = {
  sourceName: string;
  /** Posicion del archivo en la lista que se convirtio (dos archivos pueden llamarse igual). */
  index: number;
  problem: ConvertProblem;
};

export type ConvertOutcome = {
  items: ConvertItem[];
  failures: ConvertFailure[];
  /** Peso de los originales que SI se convirtieron. */
  sourceBytes: number;
  outputBytes: number;
};

export type ConvertDeps = {
  backend: ImageBackend;
  limits: ConvertLimits;
  signal?: AbortSignal;
  /** Fraccion 0-1 de la tanda ya tratada. */
  onProgress?: (fraction: number) => void;
  /** Se llama al EMPEZAR cada archivo (n de total, 1-based): para narrar «Convirtiendo 3 de 10». */
  onFileStart?: (n: number, total: number) => void;
  /** Cede el hilo al navegador entre archivos (dejar pintar el progreso y atender toques). */
  yieldToMain?: () => Promise<void>;
};

/** Un archivo ilegible por completo (permisos, borrado mientras tanto). */
async function readBytes(file: Blob): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof PdfError ? error.code === "cancelled" : error instanceof DOMException && error.name === "AbortError";
}

/**
 * Comprobaciones SIN decodificar (la misma logica que muestra el aviso previo): vacia, no es imagen, incompleta, demasiado
 * pesada o con demasiados pixeles. `null` = a priori se puede intentar.
 */
export async function precheckImage(file: Blob, limits: ConvertLimits): Promise<ConvertProblem | null> {
  if (file.size === 0) return "empty";
  if (file.size > limits.maxFileBytes) return "tooBig";
  const bytes = await readBytes(file);
  if (!bytes) return "unreadable";
  const verdict = checkImageBytes(bytes);
  if (!verdict.ok) return verdict.problem;
  const header = readImageHeader(bytes);
  if (header.displayWidth && header.displayHeight && header.displayWidth * header.displayHeight > limits.maxInputPixels) {
    return "tooManyPixels";
  }
  return null;
}

/** Convierte las imagenes de una en una (la memoria no admite varias decodificadas a la vez). */
export async function convertImages(files: readonly File[], options: ConvertOptions, deps: ConvertDeps): Promise<ConvertOutcome> {
  const { backend, limits, signal } = deps;
  const info = OUTPUT_FORMAT_INFO[options.format];
  const flatten = needsBackground(options.format) ? options.background : null;
  const caps = { maxPixels: canvasPixelsFor(options.format, limits), maxSide: limits.maxCanvasSide };
  const items: ConvertItem[] = [];
  const failures: ConvertFailure[] = [];
  let outputBytes = 0;
  let sourceBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal);
    const file = files[index];
    deps.onFileStart?.(index + 1, files.length);
    await deps.yieldToMain?.();
    const fail = (problem: ConvertProblem): void => {
      failures.push({ sourceName: file.name, index, problem });
    };

    if (outputBytes >= limits.maxBatchOutputBytes) {
      fail("batchFull");
    } else {
      const problem = await precheckImage(file, limits);
      throwIfAborted(signal);
      if (problem) {
        fail(problem);
      } else {
        try {
          const rendered = await backend.render(
            file,
            {
              format: options.format,
              quality: qualityToUnit(options.quality),
              flatten,
              planSize: (source) => computeOutputSize(source.width, source.height, options.resize, caps),
            },
            signal,
          );
          throwIfAborted(signal);
          outputBytes += rendered.blob.size;
          sourceBytes += file.size;
          items.push({
            sourceName: file.name,
            sourceBytes: file.size,
            outputName: outputFileName(file.name, options.suffix, info.extension),
            blob: rendered.blob,
            sourceWidth: rendered.sourceWidth,
            sourceHeight: rendered.sourceHeight,
            width: rendered.width,
            height: rendered.height,
            resized: rendered.width !== rendered.sourceWidth || rendered.height !== rendered.sourceHeight,
            capped: rendered.capped,
          });
        } catch (error) {
          if (isAbort(error) || signal?.aborted) throw new PdfError("cancelled");
          if (error instanceof ImageConvertError) {
            // Un navegador que no abre HEIC lo dice como «ilegible»: aqui se sabe que era HEIC y se le da su mensaje.
            const bytes = error.problem === "unreadable" ? await readBytes(file.slice(0, 4096)) : null;
            fail(bytes && readImageHeader(bytes).kind === "heic" ? "heic" : error.problem);
          } else {
            fail("unreadable");
          }
        }
      }
    }
    deps.onProgress?.((index + 1) / files.length);
  }

  // Los nombres se resuelven al final: solo cuentan las imagenes que salieron bien.
  const names = uniqueNames(items.map((item) => item.outputName));
  items.forEach((item, position) => {
    item.outputName = names[position];
  });
  return { items, failures, sourceBytes, outputBytes };
}

export type PackedResult = { blob: Blob; filename: string; kind: "file" | "zip" };

/**
 * Una sola imagen -> el archivo directo. Varias -> un ZIP (los JPG/WebP/AVIF/PNG ya estan comprimidos, asi que se guardan sin
 * recomprimir; el BMP, que no lo esta, si se comprime).
 */
export async function packConvertedImages(items: readonly ConvertItem[], zipName: string, format: OutputFormat): Promise<PackedResult> {
  if (items.length === 0) throw new PdfError("empty");
  if (items.length === 1) return { blob: items[0].blob, filename: items[0].outputName, kind: "file" };
  const zip = new JSZip();
  const readsBlobs = JSZip.support.blob && typeof FileReader !== "undefined";
  // En el navegador JSZip lee los Blob por su cuenta, uno a uno al generar (sin duplicar todo en memoria); donde no puede (Node, sin
  // `FileReader`, en las pruebas) se le dan los bytes.
  for (const item of items) zip.file(item.outputName, readsBlobs ? item.blob : new Uint8Array(await item.blob.arrayBuffer()));
  const blob = await zip.generateAsync({
    type: "blob",
    compression: format === "bmp" ? "DEFLATE" : "STORE",
    compressionOptions: { level: 6 },
  });
  return { blob, filename: zipName.toLowerCase().endsWith(".zip") ? zipName : `${zipName}.zip`, kind: "zip" };
}

/**
 * Cuando NO se convirtio ninguna imagen, el error del shell: el codigo general mas cercano al motivo (el detalle por archivo lo
 * ensena la interfaz aparte).
 */
export function errorCodeForFailures(failures: readonly ConvertFailure[]): PdfErrorCode {
  const problems = new Set(failures.map((failure) => failure.problem));
  if (problems.size === 1) {
    const [only] = [...problems];
    if (only === "notImage" || only === "heic") return "invalidType";
    if (only === "empty") return "corrupt";
  }
  if (failures.length > 0 && failures.every((failure) => failure.problem === "truncated" || failure.problem === "corrupt" || failure.problem === "empty")) return "corrupt";
  return "unknown";
}
