import { createBrowserBackend } from "@/lib/image/prepareBackend";
import { CANVAS_SAFE_MAX_PIXELS, ESTIMATE_HEAD_BYTES, readImageHeader, type PrepareBackend } from "@/lib/image/prepareForPdf";
import type { Rgba } from "@/lib/scan/pixels";

/**
 * Entrada/salida de pixeles del Escaner en el navegador (hilo principal Y Web Worker): decodificar una foto YA derecha y
 * reducida (`createImageBitmap` con `imageOrientation: "from-image"`, via el backend de `src/lib/image/prepareBackend.ts`) y
 * codificar un buffer RGBA a JPEG/PNG. Libera todo en cuanto lo usa (los lienzos sin liberar pesan en WebKit).
 */

let backend: PrepareBackend | null = null;
function getBackend(): PrepareBackend {
  backend ??= createBrowserBackend();
  return backend;
}

export class ScanDecodeError extends Error {
  constructor() {
    super("undecodable");
    this.name = "ScanDecodeError";
  }
}

/**
 * Cuanto pesa un JPEG al RECODIFICARLO a cada calidad con EL MISMO codificador que `prepareForPdf` (calibrado por navegador: en
 * WebKit la misma calidad pesa distinto que en Chromium, y la calibracion lo compensa). Devuelve los bytes de cada calidad en el
 * mismo orden. `null` si no se pudo decodificar.
 */
export async function reencodedSizes(source: Blob, qualities: readonly number[], signal?: AbortSignal): Promise<number[] | null> {
  const raster = await getBackend().decode(source, { maxSide: 4096, maxPixels: CANVAS_SAFE_MAX_PIXELS, hint: null, orientation: 1, willRead: true }, signal);
  if (!raster) return null;
  try {
    const sizes: number[] = [];
    for (const quality of qualities) sizes.push((await raster.encode("jpeg", quality, false)).byteLength);
    return sizes;
  } finally {
    raster.release();
  }
}

/** Dimensiones (con la orientacion EXIF aplicada) leidas de la cabecera, sin decodificar. */
export async function readDisplaySize(source: Blob): Promise<{ width: number; height: number; orientation: number } | null> {
  try {
    const header = readImageHeader(new Uint8Array(await source.slice(0, ESTIMATE_HEAD_BYTES).arrayBuffer()));
    if (!header.displayWidth || !header.displayHeight) return null;
    return { width: header.displayWidth, height: header.displayHeight, orientation: header.orientation };
  } catch {
    return null;
  }
}

/** Decodifica la foto ya derecha, con el lado largo <= `maxSide` (nunca amplia). Lanza `ScanDecodeError` si no se puede. */
export async function decodeToRgba(source: Blob, maxSide: number, signal?: AbortSignal): Promise<Rgba> {
  const header = await readDisplaySize(source);
  const raster = await getBackend().decode(
    source,
    {
      maxSide,
      maxPixels: CANVAS_SAFE_MAX_PIXELS,
      hint: header ? { width: header.width, height: header.height } : null,
      orientation: (header?.orientation ?? 1) as 1,
      willRead: true,
    },
    signal,
  );
  if (!raster) throw new ScanDecodeError();
  try {
    const data = raster.rows(0, raster.height) as Uint8ClampedArray<ArrayBuffer>;
    return { data: new Uint8ClampedArray(data), width: raster.width, height: raster.height };
  } finally {
    raster.release();
  }
}

type Surface = { canvas: HTMLCanvasElement | OffscreenCanvas; context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };

function createSurface(width: number, height: number): Surface {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) return { canvas, context };
  }
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context) return { canvas, context };
  }
  throw new Error("Canvas 2D unavailable");
}

/** RGBA -> Blob (JPEG por defecto). */
export async function encodeRgba(image: Rgba, type: "image/jpeg" | "image/png" = "image/jpeg", quality = 0.9): Promise<Blob> {
  const surface = createSurface(image.width, image.height);
  try {
    surface.context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    const canvas = surface.canvas;
    const blob =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({ type, quality })
        : await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, type, quality));
    if (!blob || blob.size === 0) throw new Error("canvas encode returned an empty blob");
    return blob;
  } finally {
    try {
      surface.canvas.width = 0;
      surface.canvas.height = 0;
    } catch {
      // Ya liberado.
    }
  }
}
