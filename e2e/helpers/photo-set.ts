/**
 * Fotos SINTETICAS para los E2E de optimizacion de imagenes (ninguna foto real): lotes de JPEG de 12/24/48 Mpx con
 * orientacion EXIF mezclada, escritos a disco (`setInputFiles` con rutas no tiene el tope de 50 MB de los buffers) y
 * utilidades para leer lo que el PDF incrusto y compararlo con el original (PSNR / SSIM, calculados en Node).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PDFDocument, PDFName, PDFRawStream, type PDFRef } from "@cantoo/pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { drawSyntheticPhoto, psnr, reducePixels, ssim, withExifOrientation, type Pixels } from "../../src/lib/image/photoTestUtils";
import type { ExifOrientation } from "../../src/lib/pdf/jpegOrientation";

export type PhotoSpec = { width: number; height: number; orientation: ExifOrientation };
export type PhotoSet = {
  dir: string;
  paths: string[];
  specs: PhotoSpec[];
  /** Bytes de cada archivo (los de disco). */
  buffers: Buffer[];
  totalBytes: number;
};

export const MB = 1024 * 1024;

/** Orientaciones que se reparten por el lote: derechas, giradas a ambos lados y del reves. */
const ORIENTATIONS: ExifOrientation[] = [1, 6, 8, 3, 1, 6];

/**
 * Lote de `count` fotos. `size` da el tamano de cada una (por posicion). Se generan pocas fotos distintas (cada una cuesta
 * cientos de ms) y se reparten con orientaciones EXIF distintas: cada archivo tiene su propio nombre y orientacion.
 */
export async function makePhotoSet(options: {
  name: string;
  count: number;
  size: (index: number) => { width: number; height: number };
  distinct?: number;
  quality?: number;
}): Promise<PhotoSet> {
  const dir = path.resolve(process.cwd(), ".evidence", "img-opt-tmp", options.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const distinct = options.distinct ?? 8;
  const bases = new Map<string, Buffer>();
  const paths: string[] = [];
  const specs: PhotoSpec[] = [];
  const buffers: Buffer[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const { width, height } = options.size(index);
    const orientation = ORIENTATIONS[index % ORIENTATIONS.length];
    const key = `${width}x${height}:${index % distinct}`;
    let base = bases.get(key);
    if (!base) {
      const canvas = drawSyntheticPhoto({ width, height, seed: 1000 + (index % distinct) * 17 + width });
      base = canvas.toBuffer("image/jpeg", options.quality ?? 92);
      bases.set(key, base);
    }
    const bytes = orientation === 1 ? base : withExifOrientation(base, orientation);
    const file = path.join(dir, `foto-${String(index + 1).padStart(2, "0")}.jpg`);
    writeFileSync(file, bytes);
    paths.push(file);
    specs.push({ width, height, orientation });
    buffers.push(bytes);
  }
  return { dir, paths, specs, buffers, totalBytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0) };
}

export function removePhotoSet(set: PhotoSet | undefined): void {
  if (set) rmSync(set.dir, { recursive: true, force: true });
}

export type EmbeddedImage = { page: number; width: number; height: number; bytes: Uint8Array; filter: string };

/** Imagenes (XObject) de cada pagina del PDF, en orden de pagina. */
export async function embeddedImages(pdfBytes: Buffer | Uint8Array): Promise<EmbeddedImage[]> {
  const document = await PDFDocument.load(new Uint8Array(pdfBytes), { updateMetadata: false });
  const out: EmbeddedImage[] = [];
  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    const xobjects = document.getPage(pageIndex).node.Resources()?.lookup(PDFName.of("XObject"));
    if (!xobjects) continue;
    // @ts-expect-error entries() existe en PDFDict
    for (const [, ref] of xobjects.entries()) {
      const stream = document.context.lookup(ref as PDFRef);
      if (!(stream instanceof PDFRawStream)) continue;
      out.push({
        page: pageIndex,
        width: Number(stream.dict.get(PDFName.of("Width"))),
        height: Number(stream.dict.get(PDFName.of("Height"))),
        bytes: stream.contents,
        filter: String(stream.dict.get(PDFName.of("Filter"))),
      });
    }
  }
  return out;
}

async function pixelsOf(bytes: Uint8Array | Buffer): Promise<Pixels> {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

/**
 * PSNR y SSIM de lo que el PDF incrusto frente al ORIGINAL reducido al mismo tamano (Skia aplica la orientacion EXIF al
 * decodificar, como el navegador). El original y el incrustado deben tener la misma proporcion.
 */
export async function qualityAgainstOriginal(embedded: Uint8Array, original: Buffer): Promise<{ psnr: number; ssim: number; width: number; height: number }> {
  const out = await pixelsOf(embedded);
  const source = await pixelsOf(original);
  const reduced = out.width === source.width && out.height === source.height ? source : reducePixels(source, out.width, out.height);
  return { psnr: psnr(out, reduced), ssim: ssim(out, reduced), width: out.width, height: out.height };
}

/* ------------------------------ medidas del navegador ------------------------------ */

export type RssRow = { pid: number; rss: number; kind: "web" | "gpu" | "other"; name: string };

/**
 * Procesos del navegador de ESTA prueba con su memoria residente (MB): los descendientes del worker de Playwright
 * (Chromium: web, GPU, red, utilidades) y, en WebKit de macOS, tambien los procesos XPC del propio WebKit de Playwright
 * (`ms-playwright/webkit-*`), que cuelgan de launchd y no del worker (por eso en WebKit la lista puede incluir otro WebKit de
 * Playwright abierto a la vez en la maquina, o el de la prueba anterior que aun no ha terminado de cerrarse). `web` es el
 * proceso de la pagina (WebContent / renderer, donde corre nuestro codigo y el worker) y `gpu` el de lienzos aceleradas.
 * Solo mide (`ps`), no toca nada.
 */
export function browserProcesses(options: { webkit?: boolean } = {}): RssRow[] {
  const found: RssRow[] = [];
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 64 * MB });
    const rows: Array<{ pid: number; ppid: number; rss: number; command: string }> = [];
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), command: match[4] });
    }
    const family = new Set<number>([process.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (!family.has(row.pid) && family.has(row.ppid)) {
          family.add(row.pid);
          grew = true;
        }
      }
    }
    for (const row of rows) {
      if (row.pid === process.pid) continue;
      const isXpc = options.webkit === true && row.command.includes("ms-playwright") && /webkit/i.test(row.command) && /(WebContent|Networking|GPU)/.test(row.command);
      if (!family.has(row.pid) && !isXpc) continue;
      const kind = /WebContent|--type=renderer/.test(row.command) ? "web" : /\.GPU\.|--type=gpu-process/.test(row.command) ? "gpu" : "other";
      found.push({ pid: row.pid, rss: row.rss / 1024, kind, name: row.command.replace(/^.*\//, "").slice(0, 60) });
    }
  } catch {
    // Sin `ps`: no hay medida.
  }
  return found;
}

export const browserRssMb = (options: { webkit?: boolean } = {}): number => browserProcesses(options).reduce((sum, row) => sum + row.rss, 0);

export type RssReport = {
  /** Suma de todos los procesos al empezar y en el instante de mayor suma. */
  baseline: number;
  peak: number;
  /** Aumento por proceso (suma de lo que crecio cada proceso que ya existia mas lo que ocupan los nuevos): pagina, GPU y el resto. */
  webDelta: number;
  gpuDelta: number;
  otherDelta: number;
  detail: string[];
};

/**
 * Muestrea los procesos cada 250 ms. El aumento se calcula POR PROCESO (pico de cada pid menos su valor inicial, nunca
 * negativo): asi un proceso de la prueba anterior que se esta cerrando no resta ni suma, y el proceso de la pagina se mide
 * por lo que crece de verdad.
 */
export function startRssSampler(options: { webkit?: boolean; everyMs?: number } = {}): { stop: () => RssReport } {
  const first = browserProcesses(options);
  const base = new Map(first.map((row) => [row.pid, row.rss]));
  const peaks = new Map(first.map((row) => [row.pid, row]));
  let baseline = first.reduce((sum, row) => sum + row.rss, 0);
  let peak = baseline;
  let detail = first.map((row) => `${Math.round(row.rss)} MB ${row.name}`);
  const sample = (): void => {
    const now = browserProcesses(options);
    let total = 0;
    for (const row of now) {
      total += row.rss;
      const previous = peaks.get(row.pid);
      if (!previous || row.rss > previous.rss) peaks.set(row.pid, row);
    }
    if (total > peak) {
      peak = total;
      detail = now.map((row) => `${Math.round(row.rss)} MB ${row.name}`);
    }
  };
  const timer = setInterval(sample, options.everyMs ?? 250);
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      const delta = { web: 0, gpu: 0, other: 0 };
      for (const [pid, row] of peaks) delta[row.kind] += Math.max(0, row.rss - (base.get(pid) ?? 0));
      baseline = Math.max(baseline, 0);
      return { baseline, peak, webDelta: delta.web, gpuDelta: delta.gpu, otherDelta: delta.other, detail };
    },
  };
}
