import { encodePngBytes } from "@/lib/image/inkPng";
import { PdfError } from "@/lib/pdf/core";
import {
  EXTRACT_LIMITS,
  type AssetFormat,
  type AssetKind,
  type AssetSource,
  type ExtractAssetsApi,
  type ExtractOptions,
  type ExtractResult,
  type ExtractWarning,
  type ExtractedAsset,
  type NormRect,
} from "@/lib/pdf/extractAssets/types";

/**
 * MOTOR FALSO de «Extraer elementos» (F7 · U7.4): implementa `ExtractAssetsApi` con resultados SINTETICOS y deterministas
 * para construir y probar la interfaz sin el motor real (imagenes, anotaciones/OCG, clasificador). Nada de aqui se importa
 * desde la aplicacion: solo desde las pruebas (Vitest) y desde `e2e/helpers/extract-entry.ts` (que se empaqueta con Vite
 * y se inyecta en la build de produccion con `globalThis.__optimusExtractEngine`). No lee el PDF que recibe.
 *
 * Escenarios (`scenario`):
 * - `mixed`     (por defecto) firma, firma probable, firma de lapiz (Ink), iniciales, logo repetido en todas las paginas,
 *               sello, marca de agua de texto, imagen (con su JPG original), foto y un dibujo vectorial «beta»; una pagina
 *               escaneada (`scannedPages`) y su aviso.
 * - `signatures` solo firmas e iniciales.
 * - `warnings`  `mixed` mas un aviso de cada tipo (firma digital, imagen decodificada mal, imagen enorme, cifrado...).
 * - `many`      `assetCount` (520 por defecto) elementos: se corta en `maxAssets` (500) con `truncated` y su aviso.
 * - `tooManyPages` documento de 450 paginas: analiza el rango pedido o las primeras 300 (aviso `too-many-pages`).
 * - `empty`     sin elementos y con una pagina escaneada.
 * Fallos: `failWith` hace que `extractAssets` rechace con ese `PdfError`; `failRender` que `renderAsset` rechace.
 * `delayMs` espera por pagina (para cancelar a mitad); cancelar rechaza con `AbortError`, como un motor de verdad.
 */

export type FakeScenario = "mixed" | "signatures" | "warnings" | "many" | "tooManyPages" | "empty";

export type FakeEngineOptions = {
  scenario?: FakeScenario;
  /** Paginas del documento (por defecto 6; 450 en `tooManyPages`). */
  pageCount?: number;
  /** Elementos de `many` (por defecto 520). */
  assetCount?: number;
  /** Espera por pagina en milisegundos (por defecto 0). */
  delayMs?: number;
  failWith?: "encrypted" | "corrupt" | "unknown";
  /** `true` (todos) o ids de elementos cuyo `renderAsset` falla. */
  failRender?: boolean | readonly string[];
};

export type FakeCall = { method: "extractAssets" | "renderAsset" | "cropRegion"; detail: string };

export type FakeExtractEngine = ExtractAssetsApi & {
  options: FakeEngineOptions;
  calls: FakeCall[];
  /** Cambia opciones en caliente (los E2E eligen el escenario tras cargar la pagina). */
  configure(options: FakeEngineOptions): void;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Pixeles sinteticos                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

type Rgba = { width: number; height: number; data: Uint8ClampedArray };
type Color = readonly [number, number, number];
type Painter = "script" | "initials" | "logo" | "stamp" | "photo" | "mosaic" | "drawing";
type Background = "transparent" | "white" | "paper";

const INK_BLUE: Color = [20, 48, 138];
const INK_BLACK: Color = [20, 20, 22];
const STAMP_RED: Color = [190, 28, 40];

function blank(width: number, height: number, background: Background): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  if (background !== "transparent") {
    for (let i = 0; i < width * height; i += 1) {
      const shade = background === "paper" ? 236 + ((i * 7) % 5) : 255;
      data[i * 4] = shade;
      data[i * 4 + 1] = shade;
      data[i * 4 + 2] = shade - (background === "paper" ? 6 : 0);
      data[i * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Pone un disco de tinta (borde suave de 1 px). */
function dot(img: Rgba, cx: number, cy: number, radius: number, color: Color): void {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.min(1, Math.max(0, radius + 0.5 - distance));
      if (cover <= 0) continue;
      const o = (y * img.width + x) * 4;
      const under = img.data[o + 3] / 255;
      const alpha = cover + under * (1 - cover);
      for (let c = 0; c < 3; c += 1) {
        img.data[o + c] = (color[c] * cover + img.data[o + c] * under * (1 - cover)) / (alpha || 1);
      }
      img.data[o + 3] = Math.round(alpha * 255);
    }
  }
}

function line(img: Rgba, x0: number, y0: number, x1: number, y1: number, radius: number, color: Color): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let s = 0; s <= steps; s += 1) dot(img, x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, radius, color);
}

function paint(painter: Painter, width: number, height: number, seed: number, background: Background, color: Color): Rgba {
  const img = blank(width, height, painter === "photo" || painter === "mosaic" ? "white" : background);
  const radius = Math.max(1.2, Math.min(width, height) * 0.022);
  switch (painter) {
    case "script": {
      let px = width * 0.08;
      let py = height * 0.6;
      for (let s = 1; s <= 80; s += 1) {
        const t = s / 80;
        const x = width * (0.08 + t * 0.84);
        const y = height * (0.52 + Math.sin(t * Math.PI * (5 + (seed % 3))) * 0.3 * (1 - t * 0.35) - t * 0.08);
        line(img, px, py, x, y, radius, color);
        px = x;
        py = y;
      }
      line(img, width * 0.1, height * 0.82, width * 0.9, height * 0.76, radius * 0.8, color);
      break;
    }
    case "initials": {
      // Dos letras torpes: una «J» y una «P».
      const t = radius;
      line(img, width * 0.3, height * 0.2, width * 0.3, height * 0.7, t, color);
      line(img, width * 0.3, height * 0.7, width * 0.16, height * 0.8, t, color);
      line(img, width * 0.6, height * 0.2, width * 0.6, height * 0.85, t, color);
      line(img, width * 0.6, height * 0.2, width * 0.82, height * 0.3, t, color);
      line(img, width * 0.82, height * 0.3, width * 0.6, height * 0.5, t, color);
      break;
    }
    case "logo": {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const inside = x > width * 0.04 && x < width * 0.96 && y > height * 0.1 && y < height * 0.9;
          if (!inside) continue;
          const bar = Math.floor((x / width) * 6) % 2 === 0;
          const o = (y * width + x) * 4;
          img.data[o] = bar ? 24 : 240;
          img.data[o + 1] = bar ? 90 : 244;
          img.data[o + 2] = bar ? 170 : 250;
          img.data[o + 3] = 255;
        }
      }
      break;
    }
    case "stamp": {
      const cx = width / 2;
      const cy = height / 2;
      const outer = Math.min(width, height) * 0.45;
      for (let a = 0; a < 720; a += 1) {
        const angle = (a / 720) * Math.PI * 2;
        dot(img, cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer, radius, color);
        dot(img, cx + Math.cos(angle) * outer * 0.78, cy + Math.sin(angle) * outer * 0.78, radius * 0.7, color);
      }
      line(img, cx - outer * 0.55, cy, cx + outer * 0.55, cy, radius * 1.4, color);
      line(img, cx - outer * 0.4, cy - outer * 0.25, cx + outer * 0.4, cy - outer * 0.25, radius, color);
      line(img, cx - outer * 0.4, cy + outer * 0.25, cx + outer * 0.4, cy + outer * 0.25, radius, color);
      break;
    }
    case "photo": {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const o = (y * width + x) * 4;
          img.data[o] = 90 + Math.round(120 * (x / width));
          img.data[o + 1] = 110 + Math.round(70 * Math.sin((x + seed * 9) / 23) * Math.cos(y / 31));
          img.data[o + 2] = 60 + Math.round(150 * (y / height));
          img.data[o + 3] = 255;
        }
      }
      break;
    }
    case "mosaic": {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const o = (y * width + x) * 4;
          const cell = (Math.floor(x / 40) + Math.floor(y / 40) + seed) % 3;
          img.data[o] = [220, 60, 250][cell];
          img.data[o + 1] = [200, 120, 240][cell];
          img.data[o + 2] = [60, 200, 90][cell];
          img.data[o + 3] = 255;
        }
      }
      break;
    }
    case "drawing": {
      const stroke = Math.max(1.2, radius * 0.8);
      for (let s = 0; s < 6; s += 1) {
        line(img, width * (0.1 + s * 0.15), height * 0.8, width * (0.18 + s * 0.15), height * 0.2, stroke, color);
        line(img, width * (0.18 + s * 0.15), height * 0.2, width * (0.26 + s * 0.15), height * 0.8, stroke, color);
      }
      break;
    }
  }
  return img;
}

/** Reduce a un lado mayor de `maxSide` (vecino mas cercano: basta para una miniatura sintetica). */
function shrink(img: Rgba, maxSide: number): Rgba {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (Math.min(img.height - 1, Math.floor(y / scale)) * img.width + Math.min(img.width - 1, Math.floor(x / scale))) * 4;
      out.set(img.data.subarray(s, s + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}

async function pngBlob(img: Rgba): Promise<Blob> {
  return new Blob([(await encodePngBytes(img)) as unknown as BlobPart], { type: "image/png" });
}

/** JPEG minimo valido (1 x 1): para la descarga del «JPG original» basta con que empiece por FFD8 y acabe en FFD9. */
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function tinyJpeg(): Blob {
  const text = typeof atob === "function" ? atob(TINY_JPEG_BASE64) : Buffer.from(TINY_JPEG_BASE64, "base64").toString("binary");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Catalogo de elementos                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

type Spec = {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  confidence: number;
  reasons: string[];
  pages: number[];
  width: number;
  height: number;
  alpha: boolean;
  painter: Painter | "text";
  color: Color;
  seed: number;
  formats: AssetFormat[];
  text?: string;
};

const rectFor = (kind: AssetKind, index: number): NormRect => {
  switch (kind) {
    case "logo":
      return { x: 0.06, y: 0.03, width: 0.22, height: 0.06 };
    case "signature":
      return { x: 0.12 + (index % 3) * 0.05, y: 0.72, width: 0.34, height: 0.07 };
    case "initials":
      return { x: 0.78, y: 0.9, width: 0.1, height: 0.05 };
    case "stamp":
      return { x: 0.55, y: 0.55, width: 0.2, height: 0.14 };
    case "watermark":
      return { x: 0.1, y: 0.35, width: 0.8, height: 0.3 };
    default:
      return { x: 0.15, y: 0.2, width: 0.5, height: 0.3 };
  }
};

function mixedSpecs(pageCount: number): Spec[] {
  const last = Math.max(0, pageCount - 1);
  const at = (page: number): number => Math.min(last, page);
  const all = Array.from({ length: pageCount }, (_, index) => index);
  return [
    { id: "fx-sig-1", kind: "signature", source: "xobject", confidence: 0.93, reasons: ["transparente", "cerca de “Signature”"], pages: [at(2)], width: 420, height: 140, alpha: true, painter: "script", color: INK_BLUE, seed: 1, formats: ["png"] },
    { id: "fx-sig-2", kind: "signature", source: "xobject", confidence: 0.64, reasons: ["fondo casi blanco con tinta oscura", "cerca de “Firma”"], pages: [at(3)], width: 520, height: 180, alpha: false, painter: "script", color: INK_BLACK, seed: 2, formats: ["png", "jpg-original"] },
    { id: "fx-sig-ink", kind: "signature", source: "ink-annot", confidence: 0.97, reasons: ["anotación de dibujo a mano"], pages: [at(1)], width: 380, height: 120, alpha: true, painter: "script", color: INK_BLUE, seed: 3, formats: ["png", "svg"] },
    { id: "fx-ini-1", kind: "initials", source: "xobject", confidence: 0.82, reasons: ["pequeña y de tinta", "repetida en 2 páginas"], pages: [at(0), at(1)], width: 160, height: 90, alpha: true, painter: "initials", color: INK_BLUE, seed: 4, formats: ["png"] },
    { id: "fx-logo-1", kind: "logo", source: "xobject", confidence: 0.9, reasons: [`repetida en ${pageCount} páginas`, "franja superior"], pages: all, width: 300, height: 100, alpha: false, painter: "logo", color: INK_BLUE, seed: 5, formats: ["png", "jpg-original"] },
    { id: "fx-stamp-1", kind: "stamp", source: "stamp-annot", confidence: 0.96, reasons: ["anotación de sello"], pages: [at(3)], width: 220, height: 220, alpha: true, painter: "stamp", color: STAMP_RED, seed: 6, formats: ["png"] },
    { id: "fx-wm-1", kind: "watermark", source: "text", confidence: 0.7, reasons: ["texto girado y translúcido", `repetido en ${pageCount} páginas`], pages: all, width: 0, height: 0, alpha: false, painter: "text", color: INK_BLACK, seed: 7, formats: ["txt", "svg"], text: "CONFIDENCIAL" },
    { id: "fx-img-1", kind: "image", source: "xobject", confidence: 0.99, reasons: ["imagen incrustada"], pages: [at(4)], width: 800, height: 600, alpha: false, painter: "mosaic", color: INK_BLACK, seed: 8, formats: ["jpg-original", "png"] },
    { id: "fx-photo-1", kind: "photo", source: "xobject", confidence: 0.95, reasons: ["imagen incrustada", "mucho color"], pages: [at(5)], width: 640, height: 480, alpha: false, painter: "photo", color: INK_BLACK, seed: 9, formats: ["png"] },
    { id: "fx-draw-1", kind: "drawing", source: "vector", confidence: 0.45, reasons: ["trazos vectoriales (beta)", "sin texto dentro"], pages: [at(2)], width: 300, height: 120, alpha: true, painter: "drawing", color: INK_BLACK, seed: 10, formats: ["svg", "png"] },
  ];
}

function signatureSpecs(pageCount: number): Spec[] {
  return mixedSpecs(pageCount).filter((spec) => spec.kind === "signature" || spec.kind === "initials");
}

const MANY_KINDS: { kind: AssetKind; painter: Painter; source: AssetSource; width: number; height: number; alpha: boolean; color: Color }[] = [
  { kind: "image", painter: "mosaic", source: "xobject", width: 320, height: 240, alpha: false, color: INK_BLACK },
  { kind: "signature", painter: "script", source: "xobject", width: 300, height: 110, alpha: true, color: INK_BLUE },
  { kind: "photo", painter: "photo", source: "xobject", width: 400, height: 300, alpha: false, color: INK_BLACK },
  { kind: "stamp", painter: "stamp", source: "stamp-annot", width: 160, height: 160, alpha: true, color: STAMP_RED },
  { kind: "initials", painter: "initials", source: "xobject", width: 120, height: 80, alpha: true, color: INK_BLUE },
  { kind: "logo", painter: "logo", source: "xobject", width: 240, height: 80, alpha: false, color: INK_BLUE },
  { kind: "drawing", painter: "drawing", source: "vector", width: 220, height: 100, alpha: true, color: INK_BLACK },
];

function manySpecs(count: number, pageCount: number): Spec[] {
  return Array.from({ length: count }, (_, index) => {
    const base = MANY_KINDS[index % MANY_KINDS.length];
    return {
      id: `fx-many-${index}`,
      kind: base.kind,
      source: base.source,
      confidence: 0.5 + ((index * 7) % 50) / 100,
      reasons: [`elemento sintético ${index + 1}`],
      pages: [index % Math.max(1, pageCount)],
      width: base.width,
      height: base.height,
      alpha: base.alpha,
      painter: base.painter,
      color: base.color,
      seed: index,
      formats: ["png"] as AssetFormat[],
    };
  });
}

/** Ya analizado (la miniatura, el SVG y el texto se generan aparte, a demanda). */
function specToAsset(spec: Spec, thumb: Blob | null, bytesEstimate: number): ExtractedAsset {
  return {
    id: spec.id,
    kind: spec.kind,
    confidence: spec.confidence,
    reasons: spec.reasons,
    source: spec.source,
    occurrences: spec.pages.map((pageIndex, index) => ({ pageIndex, rect: rectFor(spec.kind, index) })),
    pixel: spec.painter === "text" ? null : { width: spec.width, height: spec.height, hasAlpha: spec.alpha },
    formats: spec.formats,
    bytesEstimate,
    thumb,
    ref:
      spec.painter === "text"
        ? { engine: "text", text: spec.text ?? "" }
        : { engine: "image", objectId: spec.id, pageIndex: spec.pages[0] ?? 0 },
  };
}

function svgFor(spec: Spec): string {
  const width = spec.width || 400;
  const height = spec.height || 160;
  const stroke = `rgb(${spec.color.join(",")})`;
  if (spec.painter === "text") {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<text x="20" y="${height / 2}" font-size="48" fill="${stroke}" fill-opacity="0.3" transform="rotate(-20 20 ${height / 2})">${spec.text ?? ""}</text></svg>`
    );
  }
  const points = Array.from({ length: 40 }, (_, index) => {
    const t = index / 39;
    return `${(width * (0.08 + t * 0.84)).toFixed(1)},${(height * (0.52 + Math.sin(t * Math.PI * 5) * 0.3)).toFixed(1)}`;
  }).join(" ");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Motor                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(): DOMException {
  return new DOMException("La extracción se canceló.", "AbortError");
}

export function createFakeEngine(initial: FakeEngineOptions = {}): FakeExtractEngine {
  const specs = new Map<string, Spec>();
  const calls: FakeCall[] = [];
  const engine = {
    options: { ...initial },
    calls,
    configure(next: FakeEngineOptions): void {
      engine.options = { ...engine.options, ...next };
    },
  } as FakeExtractEngine;

  const specsFor = (opts: FakeEngineOptions, pageCount: number, maxAssets: number): { list: Spec[]; truncated: boolean } => {
    const scenario = opts.scenario ?? "mixed";
    let list: Spec[];
    if (scenario === "empty") list = [];
    else if (scenario === "signatures") list = signatureSpecs(pageCount);
    else if (scenario === "many") list = manySpecs(opts.assetCount ?? 520, pageCount);
    else if (scenario === "tooManyPages") list = mixedSpecs(Math.min(pageCount, 6)).slice(0, 4);
    else list = mixedSpecs(pageCount);
    const truncated = list.length > maxAssets;
    return { list: truncated ? list.slice(0, maxAssets) : list, truncated };
  };

  engine.extractAssets = async (_file: File | Uint8Array, extractOptions: ExtractOptions = {}): Promise<ExtractResult> => {
    const opts = engine.options;
    const scenario = opts.scenario ?? "mixed";
    calls.push({ method: "extractAssets", detail: scenario });
    if (opts.failWith) throw new PdfError(opts.failWith);
    const pageCount = opts.pageCount ?? (scenario === "tooManyPages" ? 450 : 6);
    const maxPages = extractOptions.maxPages ?? EXTRACT_LIMITS.maxPages;
    const maxAssets = extractOptions.maxAssets ?? EXTRACT_LIMITS.maxAssets;
    const requested = extractOptions.pageRange;
    const from = Math.max(0, Math.min(pageCount - 1, requested?.from ?? 0));
    const to = Math.max(from, Math.min(pageCount - 1, requested?.to ?? pageCount - 1, from + maxPages - 1));
    // Sin rango pedido, un documento de mas de `maxPages` se corta en las primeras; con rango, lo pedido manda.
    const tooMany = pageCount > maxPages && !requested;
    const warnings: ExtractWarning[] = [];
    const analyzed = to - from + 1;
    for (let index = 0; index < analyzed; index += 1) {
      if (extractOptions.signal?.aborted) throw abortError();
      if ((opts.delayMs ?? 0) > 0) await sleep(opts.delayMs ?? 0);
      if (extractOptions.signal?.aborted) throw abortError();
      extractOptions.onProgress?.({ pageIndex: from + index, pageCount, assetsSoFar: Math.round((index / analyzed) * 10) });
    }
    const { list, truncated } = specsFor(opts, scenario === "tooManyPages" ? pageCount : Math.min(pageCount, to + 1), maxAssets);
    const assets: ExtractedAsset[] = [];
    for (const spec of list) {
      if (extractOptions.signal?.aborted) throw abortError();
      specs.set(spec.id, spec);
      let thumb: Blob | null = null;
      let bytes = spec.text?.length ?? 0;
      if (spec.painter !== "text") {
        const small = shrink(paint(spec.painter, spec.width, spec.height, spec.seed, spec.alpha ? "transparent" : spec.painter === "script" ? "paper" : "white", spec.color), EXTRACT_LIMITS.thumbPx);
        thumb = await pngBlob(small);
        bytes = Math.round(spec.width * spec.height * (spec.alpha ? 0.12 : 0.4));
      }
      assets.push(specToAsset(spec, thumb, bytes));
    }
    const scannedPages = scenario === "empty" ? [0] : scenario === "mixed" || scenario === "warnings" ? [Math.min(pageCount - 1, 4)] : [];
    for (const page of scannedPages) warnings.push({ code: "scanned-page", pageIndex: page });
    if (scenario === "warnings") {
      warnings.push(
        { code: "digital-signature", pageIndex: 1 },
        { code: "decode-failed", pageIndex: 2, detail: "Imagen JPX" },
        { code: "image-too-large", pageIndex: 3 },
        { code: "encrypted" },
      );
    }
    if (truncated || scenario === "many") warnings.push({ code: "too-many-assets" });
    if (tooMany) warnings.push({ code: "too-many-pages" });
    return { pageCount, assets, scannedPages, warnings, truncated: truncated || tooMany };
  };

  engine.renderAsset = async (_file: File | Uint8Array, asset: ExtractedAsset, format: AssetFormat = "png"): Promise<Blob> => {
    calls.push({ method: "renderAsset", detail: `${asset.id}:${format}` });
    const failing = engine.options.failRender;
    if (failing === true || (Array.isArray(failing) && failing.includes(asset.id))) throw new PdfError("unknown", "render fallido");
    const spec = specs.get(asset.id);
    if (!spec) throw new PdfError("unknown", "elemento desconocido");
    if (format === "txt") return new Blob([spec.text ?? ""], { type: "text/plain;charset=utf-8" });
    if (format === "svg") return new Blob([svgFor(spec)], { type: "image/svg+xml" });
    if (format === "jpg-original") return tinyJpeg();
    if (spec.painter === "text") {
      const img = blank(480, 160, "transparent");
      line(img, 20, 120, 460, 40, 5, spec.color);
      return pngBlob(img);
    }
    // PNG a tamano completo: con alfa si el elemento lo tiene, si no con su fondo opaco (papel o blanco).
    return pngBlob(paint(spec.painter, spec.width, spec.height, spec.seed, spec.alpha ? "transparent" : spec.painter === "script" ? "paper" : "white", spec.color));
  };

  engine.cropRegion = async (_file: File | Uint8Array, pageIndex: number, rect: NormRect, cropOptions = {}) => {
    calls.push({ method: "cropRegion", detail: `${pageIndex}:${rect.x.toFixed(2)},${rect.y.toFixed(2)}` });
    if (cropOptions.signal?.aborted) throw abortError();
    const width = Math.max(40, Math.round(rect.width * 1000));
    const height = Math.max(20, Math.round(rect.height * 1000));
    const clean = cropOptions.cleanBackground !== false;
    const img = paint("script", width, height, pageIndex, clean ? "transparent" : "white", INK_BLUE);
    return { png: await pngBlob(img), width, height };
  };

  return engine;
}
