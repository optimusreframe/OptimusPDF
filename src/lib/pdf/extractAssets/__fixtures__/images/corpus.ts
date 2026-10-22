/**
 * CORPUS SINTETICO de imagenes incrustadas (U7.5, parte del motor de imagenes de «Extraer elementos»).
 *
 * `buildImagesCorpus()` genera, con pdf-lib y sin ningun dato real, un PDF por caso y su VERDAD (que imagenes lleva, en
 * que paginas y cajas 0..1 con origen arriba-izquierda). Es 100 % reproducible: no usa aleatorios ni la fecha, y los
 * mismos bytes de entrada dan los mismos PDF y la misma verdad (`truth.json` es la verdad guardada; una prueba falla si
 * deja de coincidir con la que genera este archivo). Corre igual en Node (Vitest) y en un navegador (E2E).
 *
 * Casos: PNG con alfa, PNG opaco, JPEG (RGB, gris y CMYK), el MISMO logo en 5 paginas, imagenes en linea (pequena,
 * grande y 12 seguidas que pdf.js fusiona en un atlas), mascara de 1 bit, imagen dentro de dos Form XObjects anidados
 * con giro y escala, imagen con SMask (RGB y JPEG), paginas escaneadas (y una pagina con fondo de pagina completa pero
 * con texto, que NO lo es), 200 imagenes pequenas distintas (mosaico), la misma imagen 12 veces seguidas (pdf.js la
 * fusiona en una repeticion), una bomba de pixeles (64 MP en pocos KB), una imagen que no se puede decodificar, JPX y
 * JBIG2 (decodificadores WASM), una pagina girada 90 grados y una pagina con la caja de medios desplazada.
 *
 * La verdad se calcula con una cuenta INDEPENDIENTE del motor: lleva las cuatro esquinas del cuadrado unidad por cada
 * matriz, de dentro a fuera, y las normaliza con las medidas de la pagina (el motor usa el producto de matrices).
 */

import { PDFDocument, PDFName, PDFRef, StandardFonts, degrees, type PDFPage } from "@cantoo/pdf-lib";
import { encodePngBytes } from "@/lib/image/inkPng";
import { JPEG_CMYK, JPEG_GRAY, JPEG_RGB } from "./jpegSamples";
import { JPX_HEIGHT, JPX_WIDTH, jbig2SampleBitmap, jbig2Stream, jpxBytes, jpxExpectedPixel } from "./codecs";

export type TruthRect = { x: number; y: number; width: number; height: number };
export type TruthOccurrence = { pageIndex: number; rect: TruthRect };

export type TruthImage = {
  /** Nombre legible; es unico dentro del documento y es lo que se agrupa: una imagen = un elemento esperado. */
  id: string;
  /** Tipo esperado del elemento; se omite cuando pdf.js decide (p. ej. una imagen en linea grande se trata como XObject). */
  source?: "xobject" | "inline" | "mask";
  width: number;
  height: number;
  hasAlpha: boolean;
  /** `true` si se debe ofrecer el JPEG original sin recomprimir. */
  jpegOriginal: boolean;
  occurrences: TruthOccurrence[];
};

export type TruthDoc = {
  name: string;
  description: string;
  pageCount: number;
  images: TruthImage[];
  scannedPages: number[];
  /** Codigos de aviso que DEBE dar el motor (y solo esos). */
  warnings: string[];
  /** Aclaracion sobre lo que el caso comprueba (o sobre una decision de pdf.js que la verdad no exige). */
  note?: string;
};

export type PixelExpectation = {
  /** Pixel RGBA esperado de la imagen `id` (decodificacion SIN perdida): se compara exactamente. */
  imageId: string;
  at: (x: number, y: number) => [number, number, number, number];
};

export type CorpusEntry = {
  name: string;
  bytes: Uint8Array;
  truth: TruthDoc;
  /** Pixeles exactos esperados (no van al JSON: son funciones). */
  pixels: PixelExpectation[];
  /** Bytes del JPEG original que `jpg-original` debe devolver tal cual, por `id` de imagen. */
  jpegBytes: Record<string, Uint8Array>;
};

const PAGE_W = 612;
const PAGE_H = 792;

/* ------------------------------------------------------------------ *
 * Geometria independiente (verdad)
 * ------------------------------------------------------------------ */

type Mat = [number, number, number, number, number, number];

function apply(m: Mat, p: [number, number]): [number, number] {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/**
 * Caja normalizada de una imagen: se llevan las 4 esquinas por las matrices de dentro a fuera (la ultima es la
 * pagina) y se normaliza contra la caja de medios `[x0, y0, x1, y1]`; `rotate` (0 o 90) gira la pagina en sentido horario.
 */
function truthRect(innerToOuter: Mat[], media: [number, number, number, number] = [0, 0, PAGE_W, PAGE_H], rotate: 0 | 90 = 0): TruthRect {
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const mapped = corners.map((c) => innerToOuter.reduce((point, m) => apply(m, point), c));
  const w = media[2] - media[0];
  const h = media[3] - media[1];
  // A coordenadas normalizadas con origen arriba-izquierda (sin girar).
  const norm = mapped.map(([x, y]): [number, number] => [(x - media[0]) / w, 1 - (y - media[1]) / h]);
  const turned = rotate === 90 ? norm.map(([u, v]): [number, number] => [1 - v, u]) : norm;
  const xs = turned.map((p) => p[0]);
  const ys = turned.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

const place = (x: number, y: number, w: number, h: number): Mat => [w, 0, 0, h, x, y];

/* ------------------------------------------------------------------ *
 * Construccion de PDFs
 * ------------------------------------------------------------------ */

type Builder = {
  doc: PDFDocument;
  addRaw(spec: RawImage): PDFRef;
  addStream(dict: Record<string, unknown>, data: Uint8Array, compress?: boolean): PDFRef;
  setContent(page: PDFPage, content: string | Uint8Array): void;
  addXObject(page: PDFPage, name: string, ref: PDFRef): void;
};

type RawImage = {
  width: number;
  height: number;
  /** 1 = DeviceGray, 3 = DeviceRGB. */
  components: 1 | 3;
  bits?: 1 | 8;
  data: Uint8Array;
  smask?: PDFRef;
  extra?: Record<string, unknown>;
};

async function newBuilder(): Promise<Builder> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const context = doc.context;
  const builder: Builder = {
    doc,
    addStream(dict, data, compress = true) {
      return context.register(compress ? context.flateStream(data, dict as never) : context.stream(data, dict as never));
    },
    addRaw(spec) {
      const dict: Record<string, unknown> = {
        Type: "XObject",
        Subtype: "Image",
        Width: spec.width,
        Height: spec.height,
        ColorSpace: spec.components === 1 ? "DeviceGray" : "DeviceRGB",
        BitsPerComponent: spec.bits ?? 8,
        ...(spec.extra ?? {}),
      };
      if (spec.smask) dict.SMask = spec.smask;
      return builder.addStream(dict, spec.data);
    },
    setContent(page, content) {
      // Se AÑADE como otro flujo de contenido (los `drawText` de pdf-lib siguen yendo al flujo original de la pagina).
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      page.node.addContentStream(context.register(context.flateStream(bytes)));
    },
    addXObject(page, name, ref) {
      page.node.setXObject(PDFName.of(name), ref);
    },
  };
  return builder;
}

async function finish(builder: Builder): Promise<Uint8Array> {
  return builder.doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

const fmt = (n: number): string => (Math.round(n * 1e6) / 1e6).toString();

function cm(m: Mat): string {
  return `${m.map(fmt).join(" ")} cm`;
}

/** Texto de cuerpo que NO es una imagen (para que una pagina no parezca vacia). */
async function addBodyText(builder: Builder, page: PDFPage, lines: string[], y = 700): Promise<void> {
  const font = await builder.doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) => page.drawText(line, { x: 72, y: y - i * 18, size: 11, font }));
}

function rgbPattern(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = color(x, y);
      data.set([r, g, b], (y * width + x) * 3);
    }
  }
  return data;
}

/** Trazo de firma sintetico: curva senoidal gruesa, azul, con bordes suavizados (alfa). */
function signatureRgba(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = x / width;
      const center = height * (0.5 + 0.28 * Math.sin(t * Math.PI * 6) * (1 - 0.4 * t));
      const distance = Math.abs(y - center);
      const alpha = Math.max(0, Math.min(1, 1.6 - distance / 1.8));
      const i = (y * width + x) * 4;
      data.set([18, 50, 125, Math.round(alpha * 255)], i);
    }
  }
  return data;
}

const hex = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/* ------------------------------------------------------------------ *
 * Casos
 * ------------------------------------------------------------------ */

async function casePngAlpha(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const rgba = signatureRgba(120, 48);
  const png = await b.doc.embedPng(await encodePngBytes({ width: 120, height: 48, data: rgba }));
  page.drawImage(png, { x: 72, y: 600, width: 240, height: 96 });
  const bytes = await finish(b);
  return {
    name: "png-alpha",
    bytes,
    truth: {
      name: "png-alpha",
      description: "Un PNG 120 x 48 con transparencia (firma sintetica azul) en una pagina carta.",
      pageCount: 1,
      images: [{ id: "firma", source: "xobject", width: 120, height: 48, hasAlpha: true, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([place(72, 600, 240, 96)]) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "firma", at: (x, y) => [rgba[(y * 120 + x) * 4], rgba[(y * 120 + x) * 4 + 1], rgba[(y * 120 + x) * 4 + 2], rgba[(y * 120 + x) * 4 + 3]] }],
    jpegBytes: {},
  };
}

async function casePngOpaque(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const color = (x: number, y: number): [number, number, number] => [(x * 4) % 256, (y * 4) % 256, ((x + y) * 3) % 256];
  const rgba = new Uint8ClampedArray(96 * 64 * 4);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 96; x += 1) rgba.set([...color(x, y), 255], (y * 96 + x) * 4);
  const png = await b.doc.embedPng(await encodePngBytes({ width: 96, height: 64, data: rgba }));
  page.drawImage(png, { x: 100, y: 300, width: 192, height: 128 });
  const bytes = await finish(b);
  return {
    name: "png-opaque",
    bytes,
    truth: {
      name: "png-opaque",
      description: "Un PNG opaco 96 x 64 (degradado) en una pagina carta.",
      pageCount: 1,
      images: [{ id: "degradado", source: "xobject", width: 96, height: 64, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([place(100, 300, 192, 128)]) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "degradado", at: (x, y) => [...color(x, y), 255] as [number, number, number, number] }],
    jpegBytes: {},
  };
}

async function caseJpeg(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const rgbBytes = JPEG_RGB.bytes();
  const grayBytes = JPEG_GRAY.bytes();
  const cmykBytes = JPEG_CMYK.bytes();
  const dct = { Filter: "DCTDecode" };
  const rgb = b.addStream({ Type: "XObject", Subtype: "Image", Width: JPEG_RGB.width, Height: JPEG_RGB.height, ColorSpace: "DeviceRGB", BitsPerComponent: 8, ...dct }, rgbBytes, false);
  const gray = b.addStream({ Type: "XObject", Subtype: "Image", Width: JPEG_GRAY.width, Height: JPEG_GRAY.height, ColorSpace: "DeviceGray", BitsPerComponent: 8, ...dct }, grayBytes, false);
  const cmyk = b.addStream({ Type: "XObject", Subtype: "Image", Width: JPEG_CMYK.width, Height: JPEG_CMYK.height, ColorSpace: "DeviceCMYK", BitsPerComponent: 8, Decode: [1, 0, 1, 0, 1, 0, 1, 0], ...dct }, cmykBytes, false);
  b.addXObject(page, "Rgb", rgb);
  b.addXObject(page, "Gray", gray);
  b.addXObject(page, "Cmyk", cmyk);
  const placements = { rgb: place(50, 560, 128, 96), gray: place(220, 560, 96, 64), cmyk: place(360, 560, 96, 72) };
  b.setContent(page, `q ${cm(placements.rgb)} /Rgb Do Q\nq ${cm(placements.gray)} /Gray Do Q\nq ${cm(placements.cmyk)} /Cmyk Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "jpeg",
    bytes,
    truth: {
      name: "jpeg",
      description: "Tres JPEG: RGB (original disponible), gris (original disponible) y CMYK Adobe con /Decode (sin original: se veria invertido).",
      pageCount: 1,
      images: [
        { id: "jpeg-rgb", source: "xobject", width: JPEG_RGB.width, height: JPEG_RGB.height, hasAlpha: false, jpegOriginal: true, occurrences: [{ pageIndex: 0, rect: truthRect([placements.rgb]) }] },
        { id: "jpeg-gris", source: "xobject", width: JPEG_GRAY.width, height: JPEG_GRAY.height, hasAlpha: false, jpegOriginal: true, occurrences: [{ pageIndex: 0, rect: truthRect([placements.gray]) }] },
        { id: "jpeg-cmyk", source: "xobject", width: JPEG_CMYK.width, height: JPEG_CMYK.height, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([placements.cmyk]) }] },
      ],
      scannedPages: [],
      warnings: [],
    },
    pixels: [],
    jpegBytes: { "jpeg-rgb": rgbBytes, "jpeg-gris": grayBytes },
  };
}

async function caseLogoRepeat(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const rgba = new Uint8ClampedArray(90 * 30 * 4);
  for (let y = 0; y < 30; y += 1) {
    for (let x = 0; x < 90; x += 1) {
      const inside = (x - 45) ** 2 / 44 ** 2 + (y - 15) ** 2 / 14 ** 2 <= 1;
      rgba.set(inside ? [200, 30, 30, 255] : [0, 0, 0, 0], (y * 90 + x) * 4);
    }
  }
  const png = await b.doc.embedPng(await encodePngBytes({ width: 90, height: 30, data: rgba }));
  const occurrences: TruthOccurrence[] = [];
  for (let i = 0; i < 5; i += 1) {
    const page = b.doc.addPage([PAGE_W, PAGE_H]);
    page.drawImage(png, { x: 40, y: 730, width: 90, height: 30 });
    await addBodyText(b, page, [`Pagina ${i + 1} del contrato sintetico de prueba.`, "Texto de relleno del cuerpo del documento."]);
    occurrences.push({ pageIndex: i, rect: truthRect([place(40, 730, 90, 30)]) });
  }
  const bytes = await finish(b);
  return {
    name: "logo-repeat",
    bytes,
    truth: {
      name: "logo-repeat",
      description: "El MISMO logo (un solo objeto) en la cabecera de 5 paginas: un elemento con 5 apariciones.",
      pageCount: 5,
      images: [{ id: "logo", source: "xobject", width: 90, height: 30, hasAlpha: true, jpegOriginal: false, occurrences }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "logo", at: (x, y) => [rgba[(y * 90 + x) * 4], rgba[(y * 90 + x) * 4 + 1], rgba[(y * 90 + x) * 4 + 2], rgba[(y * 90 + x) * 4 + 3]] }],
    jpegBytes: {},
  };
}

async function caseLogoCopies(): Promise<CorpusEntry> {
  // Tres COPIAS del mismo dibujo en objetos distintos (como las que deja un conversor): se agrupan por los pixeles.
  const b = await newBuilder();
  const w = 60;
  const h = 40;
  const data = rgbPattern(w, h, (x, y) => (x > 10 && x < 50 && y > 8 && y < 32 ? [30, 90, 200] : [245, 245, 245]));
  const occurrences: TruthOccurrence[] = [];
  for (let i = 0; i < 3; i += 1) {
    const page = b.doc.addPage([PAGE_W, PAGE_H]);
    const ref = b.addRaw({ width: w, height: h, components: 3, data });
    b.addXObject(page, "Logo", ref);
    b.setContent(page, `q ${cm(place(450, 720, 90, 60))} /Logo Do Q\n`);
    occurrences.push({ pageIndex: i, rect: truthRect([place(450, 720, 90, 60)]) });
  }
  const bytes = await finish(b);
  return {
    name: "logo-copies",
    bytes,
    truth: {
      name: "logo-copies",
      description: "Tres objetos de imagen DISTINTOS con exactamente los mismos pixeles (una en cada pagina): un elemento con 3 apariciones.",
      pageCount: 3,
      images: [{ id: "logo-copia", source: "xobject", width: w, height: h, hasAlpha: false, jpegOriginal: false, occurrences }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "logo-copia", at: (x, y) => [...(x > 10 && x < 50 && y > 8 && y < 32 ? [30, 90, 200] : [245, 245, 245]), 255] as [number, number, number, number] }],
    jpegBytes: {},
  };
}

async function caseInline(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  // Pequena: 8 x 8 RGB con AHx (la lista de operadores de pdf.js la trae entera: `paintInlineImageXObject`).
  const small: number[] = [];
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) small.push(x * 30, y * 30, 120);
  // Grande: 120 x 100 gris (w + h >= 200): pdf.js la trata como un objeto de imagen aparte.
  const big: number[] = [];
  for (let y = 0; y < 100; y += 1) for (let x = 0; x < 120; x += 1) big.push((x * 2 + y) % 256);
  const content =
    `q ${cm(place(100, 600, 64, 64))} BI /W 8 /H 8 /CS /RGB /BPC 8 /F /AHx ID ${hex(small)}> EI Q\n` +
    `q ${cm(place(250, 560, 120, 100))} BI /W 120 /H 100 /CS /G /BPC 8 /F /AHx ID ${hex(big)}> EI Q\n`;
  b.setContent(page, content);
  const bytes = await finish(b);
  return {
    name: "inline",
    bytes,
    truth: {
      name: "inline",
      description: "Dos imagenes en linea (BI/ID/EI): una de 8 x 8 y otra de 120 x 100.",
      pageCount: 1,
      images: [
        { id: "inline-pequena", source: "inline", width: 8, height: 8, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([place(100, 600, 64, 64)]) }] },
        { id: "inline-grande", width: 120, height: 100, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([place(250, 560, 120, 100)]) }] },
      ],
      scannedPages: [],
      warnings: [],
      note: "La grande pasa por `paintImageXObject` en pdf.js (w + h >= 200): el tipo de origen no se exige.",
    },
    pixels: [
      { imageId: "inline-pequena", at: (x, y) => [x * 30, y * 30, 120, 255] },
      { imageId: "inline-grande", at: (x, y) => [(x * 2 + y) % 256, (x * 2 + y) % 256, (x * 2 + y) % 256, 255] },
    ],
    jpegBytes: {},
  };
}

async function caseInlineGroup(): Promise<CorpusEntry> {
  // 12 imagenes en linea SEGUIDAS (q cm BI..EI Q): pdf.js las pega en un atlas (`paintInlineImageXObjectGroup`).
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  let content = "";
  const images: TruthImage[] = [];
  const colors: Array<[number, number, number]> = [];
  for (let i = 0; i < 12; i += 1) {
    const bytes: number[] = [];
    const base: [number, number, number] = [(i * 53 + 20) % 256, (i * 97 + 60) % 256, (i * 29 + 100) % 256];
    colors.push(base);
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bytes.push(...(x === y ? [255, 255, 255] : base));
    const m = place(60 + (i % 6) * 80, 600 - Math.floor(i / 6) * 90, 60, 60);
    content += `q ${cm(m)} BI /W 8 /H 8 /CS /RGB /BPC 8 /F /AHx ID ${hex(bytes)}> EI Q\n`;
    images.push({ id: `atlas-${i}`, source: "inline", width: 8, height: 8, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m]) }] });
  }
  b.setContent(page, content);
  const bytes = await finish(b);
  return {
    name: "inline-group",
    bytes,
    truth: { name: "inline-group", description: "12 imagenes en linea distintas y consecutivas (8 x 8): pdf.js las funde en un atlas y hay que separarlas.", pageCount: 1, images, scannedPages: [], warnings: [] },
    pixels: images.map((image, i) => ({ imageId: image.id, at: (x: number, y: number) => [...(x === y ? [255, 255, 255] : colors[i]), 255] as [number, number, number, number] })),
    jpegBytes: {},
  };
}

async function caseMask(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  // 16 x 16, 1 bit: 0 = se pinta. Tablero de 4 x 4 px.
  const rows: number[] = [];
  for (let y = 0; y < 16; y += 1) {
    let bits = 0;
    for (let x = 0; x < 16; x += 1) bits = (bits << 1) | ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 0 : 1);
    rows.push((bits >> 8) & 255, bits & 255);
  }
  const mask = b.addStream({ Type: "XObject", Subtype: "Image", Width: 16, Height: 16, ImageMask: true, BitsPerComponent: 1 }, new Uint8Array(rows));
  b.addXObject(page, "Mk", mask);
  const m = place(100, 560, 64, 64);
  b.setContent(page, `q 1 0 0 rg ${cm(m)} /Mk Do Q\n`);
  const bytes = await finish(b);
  const painted = (x: number, y: number): boolean => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
  return {
    name: "mask-1bit",
    bytes,
    truth: {
      name: "mask-1bit",
      description: "Una mascara de imagen de 1 bit (tablero de 16 x 16) pintada en rojo.",
      pageCount: 1,
      images: [{ id: "mascara", source: "mask", width: 16, height: 16, hasAlpha: true, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m]) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "mascara", at: (x, y) => [255, 0, 0, painted(x, y) ? 255 : 0] }],
    jpegBytes: {},
  };
}

async function caseFormNested(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const formPixel = (x: number, y: number): [number, number, number] => {
    const base: [number, number, number] = x < 15 ? [230, 120, 20] : [20, 160, 200];
    return y === 10 ? [255 - base[0], 255 - base[1], 255 - base[2]] : base;
  };
  const image = b.addRaw({ width: 30, height: 20, components: 3, data: rgbPattern(30, 20, formPixel) });
  const page1 = b.doc.addPage([PAGE_W, PAGE_H]);
  const page2 = b.doc.addPage([PAGE_W, PAGE_H]);
  const context = b.doc.context;

  const angle = (30 * Math.PI) / 180;
  const inner: Mat = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 20, 10];
  const outer: Mat = [1.5, 0, 0, 1.25, 30, 15];
  const draw: Mat = place(0, 0, 60, 40);

  const innerForm = context.flateStream(`q ${cm(draw)} /Im Do Q\n`, {
    Type: "XObject",
    Subtype: "Form",
    BBox: [-1000, -1000, 1000, 1000],
    Matrix: inner,
    Resources: context.obj({ XObject: { Im: image } }),
  });
  const innerRef = context.register(innerForm);
  const outerForm = context.flateStream("q 1 0 0 1 5 5 cm /Fi Do Q\n", {
    Type: "XObject",
    Subtype: "Form",
    BBox: [-1000, -1000, 1000, 1000],
    Matrix: outer,
    Resources: context.obj({ XObject: { Fi: innerRef } }),
  });
  const outerRef = context.register(outerForm);
  b.addXObject(page1, "Fo", outerRef);
  const pageMatrix: Mat = [1, 0, 0, 1, 150, 400];
  b.setContent(page1, `q ${cm(pageMatrix)} /Fo Do Q\n`);

  // Pagina 2: la MISMA imagen, directa.
  b.addXObject(page2, "Im", image);
  const direct = place(100, 100, 60, 40);
  b.setContent(page2, `q ${cm(direct)} /Im Do Q\n`);

  const bytes = await finish(b);
  const nested = truthRect([draw, inner, [1, 0, 0, 1, 5, 5], outer, pageMatrix]);
  const pixelAt = (x: number, y: number): [number, number, number, number] => [...formPixel(x, y), 255];
  return {
    name: "form-nested",
    bytes,
    truth: {
      name: "form-nested",
      description: "Una imagen dentro de dos Form XObjects anidados (giro de 30 grados y escala 1,5 x 1,25) en la pagina 1 y la misma imagen directa en la 2.",
      pageCount: 2,
      images: [
        {
          id: "imagen-en-formulario",
          source: "xobject",
          width: 30,
          height: 20,
          hasAlpha: false,
          jpegOriginal: false,
          occurrences: [
            { pageIndex: 0, rect: nested },
            { pageIndex: 1, rect: truthRect([direct]) },
          ],
        },
      ],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "imagen-en-formulario", at: pixelAt }],
    jpegBytes: {},
  };
}

async function caseSmask(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const w = 40;
  const h = 40;
  const alphaOf = (x: number): number => Math.round((x * 255) / (w - 1));
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) mask[y * w + x] = alphaOf(x);
  const smask = b.addRaw({ width: w, height: h, components: 1, data: mask });
  const rgb = b.addRaw({ width: w, height: h, components: 3, data: rgbPattern(w, h, () => [200, 50, 50]), smask });
  // JPEG con SMask: sin JPEG original.
  const jpegMask = new Uint8Array(JPEG_RGB.width * JPEG_RGB.height).fill(128);
  const jpegSmask = b.addRaw({ width: JPEG_RGB.width, height: JPEG_RGB.height, components: 1, data: jpegMask });
  const jpeg = b.addStream({ Type: "XObject", Subtype: "Image", Width: JPEG_RGB.width, Height: JPEG_RGB.height, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode", SMask: jpegSmask }, JPEG_RGB.bytes(), false);
  b.addXObject(page, "Sm", rgb);
  b.addXObject(page, "Jm", jpeg);
  const a = place(80, 560, 120, 120);
  const c = place(260, 560, 128, 96);
  b.setContent(page, `0.9 0.9 0.2 rg 60 540 360 160 re f\nq ${cm(a)} /Sm Do Q\nq ${cm(c)} /Jm Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "smask",
    bytes,
    truth: {
      name: "smask",
      description: "Una imagen RGB con SMask de degradado horizontal y un JPEG con SMask (sin JPEG original: la transparencia no cabe), sobre un fondo amarillo.",
      pageCount: 1,
      images: [
        { id: "rgb-smask", source: "xobject", width: w, height: h, hasAlpha: true, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([a]) }] },
        { id: "jpeg-smask", source: "xobject", width: JPEG_RGB.width, height: JPEG_RGB.height, hasAlpha: true, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([c]) }] },
      ],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "rgb-smask", at: (x) => [200, 50, 50, alphaOf(x)] }],
    jpegBytes: {},
  };
}

async function caseScanned(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const w = 120;
  const h = 156;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) gray[y * w + x] = (x > 20 && x < 100 && (y % 24 < 3) ? 40 : 235);
  const scan = b.addRaw({ width: w, height: h, components: 1, data: gray });
  // Pagina 1: escaneada (sola, sin texto).
  const p1 = b.doc.addPage([PAGE_W, PAGE_H]);
  b.addXObject(p1, "Sc", scan);
  b.setContent(p1, `q ${cm(place(0, 0, PAGE_W, PAGE_H))} /Sc Do Q\n`);
  // Pagina 2: solo texto.
  const p2 = b.doc.addPage([PAGE_W, PAGE_H]);
  await addBodyText(b, p2, ["Esta pagina solo lleva texto y ninguna imagen,", "como el cuerpo de un contrato normal de prueba."]);
  // Pagina 3: fondo de pagina completa CON texto (no es un escaneo).
  const p3 = b.doc.addPage([PAGE_W, PAGE_H]);
  b.addXObject(p3, "Sc", scan);
  b.setContent(p3, `q ${cm(place(0, 0, PAGE_W, PAGE_H))} /Sc Do Q\n`);
  await addBodyText(b, p3, ["Hoja con membrete de fondo y texto real encima del fondo.", "Segunda linea del texto del cuerpo de la pagina tres."]);
  const bytes = await finish(b);
  const full = truthRect([place(0, 0, PAGE_W, PAGE_H)]);
  return {
    name: "scanned",
    bytes,
    truth: {
      name: "scanned",
      description: "Pagina 1 escaneada (una imagen a pagina completa y nada de texto), pagina 2 solo texto y pagina 3 con el mismo fondo pero con texto real (no es un escaneo).",
      pageCount: 3,
      images: [
        {
          id: "escaneo",
          source: "xobject",
          width: w,
          height: h,
          hasAlpha: false,
          jpegOriginal: false,
          occurrences: [
            { pageIndex: 0, rect: full },
            { pageIndex: 2, rect: full },
          ],
        },
      ],
      scannedPages: [0],
      warnings: ["scanned-page"],
    },
    pixels: [{ imageId: "escaneo", at: (x, y) => [(x > 20 && x < 100 && y % 24 < 3 ? 40 : 235), (x > 20 && x < 100 && y % 24 < 3 ? 40 : 235), (x > 20 && x < 100 && y % 24 < 3 ? 40 : 235), 255] }],
    jpegBytes: {},
  };
}

async function caseMosaic(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const images: TruthImage[] = [];
  let content = "";
  for (let i = 0; i < 200; i += 1) {
    const color: [number, number, number] = [(i * 37) % 256, (i * 71 + 30) % 256, (i * 113 + 90) % 256];
    const ref = b.addRaw({ width: 12, height: 12, components: 3, data: rgbPattern(12, 12, (x, y) => (x === (i % 12) || y === Math.floor(i / 17) % 12 ? [255 - color[0], 255 - color[1], 255 - color[2]] : color)) });
    b.addXObject(page, `T${i}`, ref);
    const m = place(36 + (i % 20) * 27, 60 + Math.floor(i / 20) * 70, 24, 24);
    content += `q ${cm(m)} /T${i} Do Q\n`;
    images.push({ id: `tesela-${i}`, source: "xobject", width: 12, height: 12, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m]) }] });
  }
  b.setContent(page, content);
  const bytes = await finish(b);
  return {
    name: "mosaic-200",
    bytes,
    truth: { name: "mosaic-200", description: "200 imagenes pequenas DISTINTAS (12 x 12) en una cuadricula de 20 x 10.", pageCount: 1, images, scannedPages: [], warnings: [] },
    pixels: [],
    jpegBytes: {},
  };
}

async function caseRepeat(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const ref = b.addRaw({ width: 16, height: 16, components: 3, data: rgbPattern(16, 16, (x, y) => (x === y ? [255, 255, 255] : [30, 140, 70])) });
  b.addXObject(page, "Ic", ref);
  const occurrences: TruthOccurrence[] = [];
  let content = "";
  for (let i = 0; i < 12; i += 1) {
    const m = place(60 + (i % 6) * 80, 600 - Math.floor(i / 6) * 90, 50, 50);
    content += `q ${cm(m)} /Ic Do Q\n`;
    occurrences.push({ pageIndex: 0, rect: truthRect([m]) });
  }
  b.setContent(page, content);
  const bytes = await finish(b);
  return {
    name: "repeat-12",
    bytes,
    truth: {
      name: "repeat-12",
      description: "La misma imagen pintada 12 veces seguidas (q cm Do Q): pdf.js las funde en una operacion de repeticion.",
      pageCount: 1,
      images: [{ id: "icono", source: "xobject", width: 16, height: 16, hasAlpha: false, jpegOriginal: false, occurrences }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "icono", at: (x, y) => (x === y ? [255, 255, 255, 255] : [30, 140, 70, 255]) }],
    jpegBytes: {},
  };
}

async function caseBomb(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const side = 8000;
  const ref = b.addRaw({ width: side, height: side, components: 1, bits: 1, data: new Uint8Array((side / 8) * side) });
  b.addXObject(page, "Bomb", ref);
  const small = b.addRaw({ width: 10, height: 10, components: 3, data: rgbPattern(10, 10, () => [10, 200, 10]) });
  b.addXObject(page, "Ok", small);
  const m = place(0, 0, PAGE_W, PAGE_H);
  const s = place(100, 100, 40, 40);
  b.setContent(page, `q ${cm(m)} /Bomb Do Q\nq ${cm(s)} /Ok Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "bomb",
    bytes,
    truth: {
      name: "bomb",
      description: "Una bomba de pixeles: 8000 x 8000 (64 MP) de 1 bit en pocos KB, mas una imagen normal. La bomba se omite con `image-too-large` (no es un JPEG: no hay original que ofrecer) y, al cubrir toda la pagina sin texto, la pagina cuenta como escaneada.",
      pageCount: 1,
      images: [{ id: "normal", source: "xobject", width: 10, height: 10, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([s]) }] }],
      scannedPages: [0],
      warnings: ["image-too-large", "scanned-page"],
    },
    pixels: [],
    jpegBytes: {},
  };
}

async function caseDecodeFailed(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const good = b.addRaw({ width: 20, height: 20, components: 3, data: rgbPattern(20, 20, (x) => [x * 12, 80, 160]) });
  // JPX con bytes basura (una cabecera JP2 falsa): ni el decodificador WASM ni el de respaldo pueden con el.
  const garbage = new Uint8Array(200);
  garbage.set([0, 0, 0, 12, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a], 0);
  for (let i = 12; i < garbage.length; i += 1) garbage[i] = (i * 31) & 255;
  const bad = b.addStream({ Type: "XObject", Subtype: "Image", Width: 40, Height: 30, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "JPXDecode" }, garbage, false);
  b.addXObject(page, "Good", good);
  b.addXObject(page, "Bad", bad);
  const g = place(100, 500, 60, 60);
  const x = place(250, 500, 80, 60);
  b.setContent(page, `q ${cm(g)} /Good Do Q\nq ${cm(x)} /Bad Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "decode-failed",
    bytes,
    truth: {
      name: "decode-failed",
      description: "Una imagen buena y otra JPX corrupta: la corrupta da `decode-failed` y la buena se extrae igual.",
      pageCount: 1,
      images: [{ id: "buena", source: "xobject", width: 20, height: 20, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([g]) }] }],
      scannedPages: [],
      warnings: ["decode-failed"],
    },
    pixels: [],
    jpegBytes: {},
  };
}

async function caseJpx(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const ref = b.addStream({ Type: "XObject", Subtype: "Image", Width: JPX_WIDTH, Height: JPX_HEIGHT, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "JPXDecode" }, jpxBytes(), false);
  b.addXObject(page, "Jp", ref);
  const m = place(100, 500, 160, 100);
  b.setContent(page, `q ${cm(m)} /Jp Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "jpx",
    bytes,
    truth: {
      name: "jpx",
      description: "Una imagen JPX (JPEG 2000) sin perdida de 32 x 20: necesita `openjpeg.wasm` (U7.0).",
      pageCount: 1,
      images: [{ id: "jpx", source: "xobject", width: JPX_WIDTH, height: JPX_HEIGHT, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m]) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "jpx", at: (x, y) => [...jpxExpectedPixel(x, y), 255] as [number, number, number, number] }],
    jpegBytes: {},
  };
}

async function caseJbig2(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const bitmap = jbig2SampleBitmap();
  const ref = b.addStream({ Type: "XObject", Subtype: "Image", Width: 16, Height: 12, ColorSpace: "DeviceGray", BitsPerComponent: 1, Filter: "JBIG2Decode" }, jbig2Stream(bitmap), false);
  b.addXObject(page, "Jb", ref);
  const m = place(100, 500, 160, 120);
  b.setContent(page, `q ${cm(m)} /Jb Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "jbig2",
    bytes,
    truth: {
      name: "jbig2",
      description: "Una imagen JBIG2 (region generica MMR) de 16 x 12 con una «F» negra: necesita `jbig2.wasm` (U7.0).",
      pageCount: 1,
      images: [{ id: "jbig2", source: "xobject", width: 16, height: 12, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m]) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [{ imageId: "jbig2", at: (x, y) => (bitmap[y][x] ? [0, 0, 0, 255] : [255, 255, 255, 255]) }],
    jpegBytes: {},
  };
}

async function caseRotatedPage(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  page.setRotation(degrees(90));
  const ref = b.addRaw({ width: 24, height: 16, components: 3, data: rgbPattern(24, 16, (x) => [x * 10, 100, 200 - x * 8]) });
  b.addXObject(page, "Im", ref);
  const m = place(72, 500, 120, 80);
  b.setContent(page, `q ${cm(m)} /Im Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "rotated-page",
    bytes,
    truth: {
      name: "rotated-page",
      description: "Una pagina con /Rotate 90 y una imagen: la caja se da sobre la pagina GIRADA, como se ve.",
      pageCount: 1,
      images: [{ id: "imagen", source: "xobject", width: 24, height: 16, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m], [0, 0, PAGE_W, PAGE_H], 90) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [],
    jpegBytes: {},
  };
}

async function caseOffsetBox(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  const media: [number, number, number, number] = [20, 30, 20 + 500, 30 + 700];
  page.setMediaBox(20, 30, 500, 700);
  const ref = b.addRaw({ width: 16, height: 16, components: 3, data: rgbPattern(16, 16, (x, y) => [x * 16, y * 16, 90]) });
  b.addXObject(page, "Im", ref);
  const m = place(120, 330, 100, 100);
  b.setContent(page, `q ${cm(m)} /Im Do Q\n`);
  const bytes = await finish(b);
  return {
    name: "offset-box",
    bytes,
    truth: {
      name: "offset-box",
      description: "Una pagina de 500 x 700 con la caja de medios desplazada a (20, 30): las cajas se miden desde su esquina.",
      pageCount: 1,
      images: [{ id: "imagen", source: "xobject", width: 16, height: 16, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([m], media) }] }],
      scannedPages: [],
      warnings: [],
    },
    pixels: [],
    jpegBytes: {},
  };
}

async function caseAnnotationImage(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const context = b.doc.context;
  const page = b.doc.addPage([300, 300]);
  const content = b.addRaw({ width: 8, height: 8, components: 3, data: rgbPattern(8, 8, () => [50, 50, 200]) });
  const stamp = b.addRaw({ width: 8, height: 8, components: 3, data: rgbPattern(8, 8, (x) => [200, x * 20, 50]) });
  b.addXObject(page, "A", content);
  const a = place(20, 20, 50, 50);
  b.setContent(page, `q ${cm(a)} /A Do Q\n`);
  // Un sello (anotacion /Stamp) cuya apariencia es otra imagen: pertenece a `annotations.ts` (U7.2), no a este motor.
  const appearance = context.register(
    context.flateStream("q 60 0 0 60 0 0 cm /B Do Q\n", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 60, 60], Resources: context.obj({ XObject: { B: stamp } }) }),
  );
  const annot = context.register(context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [150, 150, 210, 210], F: 4, AP: { N: appearance } }));
  page.node.set(PDFName.of("Annots"), context.obj([annot]));
  const bytes = await finish(b);
  return {
    name: "annotation-image",
    bytes,
    truth: {
      name: "annotation-image",
      description: "Una imagen en el contenido y un sello (/Stamp) cuya apariencia lleva otra imagen: por defecto solo la del contenido (la del sello es de annotations.ts); con `includeAnnotations`, las dos.",
      pageCount: 1,
      images: [{ id: "contenido", source: "xobject", width: 8, height: 8, hasAlpha: false, jpegOriginal: false, occurrences: [{ pageIndex: 0, rect: truthRect([a], [0, 0, 300, 300]) }] }],
      scannedPages: [],
      warnings: [],
      note: "Con `includeAnnotations: true` aparece ademas la imagen del sello (8 x 8) en la caja del /Rect [150 150 210 210].",
    },
    pixels: [],
    jpegBytes: {},
  };
}

async function caseNoImages(): Promise<CorpusEntry> {
  const b = await newBuilder();
  const page = b.doc.addPage([PAGE_W, PAGE_H]);
  await addBodyText(b, page, ["Un documento sin ninguna imagen.", "Solo texto y una raya.", "Nada que extraer aqui."]);
  page.drawLine({ start: { x: 72, y: 600 }, end: { x: 300, y: 600 } });
  const bytes = await finish(b);
  return {
    name: "no-images",
    bytes,
    truth: { name: "no-images", description: "Texto y una raya, sin ninguna imagen.", pageCount: 1, images: [], scannedPages: [], warnings: [] },
    pixels: [],
    jpegBytes: {},
  };
}

/** Los casos, en orden. */
export const CORPUS_BUILDERS: Array<() => Promise<CorpusEntry>> = [
  casePngAlpha,
  casePngOpaque,
  caseJpeg,
  caseLogoRepeat,
  caseLogoCopies,
  caseInline,
  caseInlineGroup,
  caseMask,
  caseFormNested,
  caseSmask,
  caseScanned,
  caseMosaic,
  caseRepeat,
  caseBomb,
  caseDecodeFailed,
  caseJpx,
  caseJbig2,
  caseRotatedPage,
  caseOffsetBox,
  caseAnnotationImage,
  caseNoImages,
];

export async function buildImagesCorpus(): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  for (const build of CORPUS_BUILDERS) out.push(await build());
  return out;
}

/** La verdad de todo el corpus (lo que se guarda en `truth.json`). */
export function corpusTruth(entries: CorpusEntry[]): Record<string, TruthDoc> {
  const out: Record<string, TruthDoc> = {};
  for (const entry of entries) out[entry.name] = entry.truth;
  return out;
}

