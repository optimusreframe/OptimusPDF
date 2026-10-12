import { createCanvas } from "@napi-rs/canvas";
import { PDFArray, PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { buildPdfFromImages } from "@/lib/pdf/imagesToPdf";
import {
  orientationMatrix,
  orientedSize,
  readJpegOrientation,
  type ExifOrientation,
} from "@/lib/pdf/jpegOrientation";

/**
 * Orientacion EXIF de los JPEG (ronda de correcciones de U8): un JPEG de 300×100 con orientacion 6 es una foto VERTICAL
 * de 100×300; antes salia una pagina horizontal con la imagen sin girar. JPEG sinteticos con la etiqueta puesta a mano.
 */

function plainJpeg(width: number, height: number): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#cc2222";
  context.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/jpeg", 80));
}

/** Inserta un segmento APP1/Exif con la orientacion justo despues de SOI (little o big endian). */
function withOrientation(jpeg: Uint8Array, orientation: number, endian: "II" | "MM" = "II"): Uint8Array {
  const little = endian === "II";
  const u16 = (value: number) => (little ? [value & 255, value >> 8] : [value >> 8, value & 255]);
  const u32 = (value: number) => (little ? [value & 255, (value >> 8) & 255, 0, 0] : [0, 0, (value >> 8) & 255, value & 255]);
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1), // una entrada
    ...u16(0x0112),
    ...u16(3), // SHORT
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0), // sin otra IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = body.length + 2;
  const segment = [0xff, 0xe1, length >> 8, length & 255, ...body];
  return new Uint8Array([...jpeg.slice(0, 2), ...segment, ...jpeg.slice(2)]);
}

describe("readJpegOrientation", () => {
  it("un JPEG sin EXIF es la orientacion 1", () => {
    expect(readJpegOrientation(plainJpeg(30, 10))).toBe(1);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("lee la orientacion %i (little endian)", (value) => {
    expect(readJpegOrientation(withOrientation(plainJpeg(30, 10), value, "II"))).toBe(value);
  });

  it.each([3, 6, 8] as const)("lee la orientacion %i (big endian)", (value) => {
    expect(readJpegOrientation(withOrientation(plainJpeg(30, 10), value, "MM"))).toBe(value);
  });

  it("un valor fuera de rango (0 o 9) se trata como 1", () => {
    expect(readJpegOrientation(withOrientation(plainJpeg(30, 10), 0))).toBe(1);
    expect(readJpegOrientation(withOrientation(plainJpeg(30, 10), 9))).toBe(1);
  });

  it("bytes que no son un JPEG, vacios o truncados no lanzan y dan 1", () => {
    expect(readJpegOrientation(new Uint8Array([]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([1, 2, 3, 4, 5]))).toBe(1);
    expect(readJpegOrientation(withOrientation(plainJpeg(30, 10), 6).slice(0, 14))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]))).toBe(1);
  });

  it("un APP1 que no es Exif (XMP) se salta y se sigue buscando", () => {
    const jpeg = plainJpeg(30, 10);
    const xmp = [0xff, 0xe1, 0x00, 0x08, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f];
    const mixed = new Uint8Array([...jpeg.slice(0, 2), ...xmp, ...withOrientation(jpeg, 8).slice(2)]);
    expect(readJpegOrientation(mixed)).toBe(8);
  });
});

describe("orientedSize", () => {
  it("5..8 intercambian ancho y alto; 1..4 no", () => {
    for (const o of [1, 2, 3, 4] as const) expect(orientedSize(300, 100, o)).toEqual({ width: 300, height: 100 });
    for (const o of [5, 6, 7, 8] as const) expect(orientedSize(300, 100, o)).toEqual({ width: 100, height: 300 });
  });
});

describe("orientationMatrix: donde cae cada esquina de la imagen guardada", () => {
  const W = 300;
  const H = 100;
  /** Esquina de la imagen guardada (pixel 0,0 = arriba-izquierda) como posicion en el rectangulo dibujado. */
  function place(orientation: ExifOrientation, s: number, t: number): "TL" | "TR" | "BL" | "BR" {
    const shown = orientedSize(W, H, orientation);
    const box = { x: 10, y: 20, width: shown.width, height: shown.height };
    const [a, b, c, d, e, f] = orientationMatrix(orientation, W, H, box);
    const x = a * s + c * t + e;
    const y = b * s + d * t + f;
    const right = Math.abs(x - (box.x + box.width)) < 1e-6;
    const left = Math.abs(x - box.x) < 1e-6;
    const top = Math.abs(y - (box.y + box.height)) < 1e-6;
    const bottom = Math.abs(y - box.y) < 1e-6;
    expect(left || right, `x=${x}`).toBe(true);
    expect(top || bottom, `y=${y}`).toBe(true);
    return `${top ? "T" : "B"}${left ? "L" : "R"}` as "TL";
  }

  // Esquina guardada arriba-izquierda (s=0, t=1) y arriba-derecha (s=1, t=1) segun la tabla EXIF.
  const EXPECTED: Record<ExifOrientation, [string, string]> = {
    1: ["TL", "TR"],
    2: ["TR", "TL"],
    3: ["BR", "BL"],
    4: ["BL", "BR"],
    5: ["TL", "BL"],
    6: ["TR", "BR"],
    7: ["BR", "TR"],
    8: ["BL", "TL"],
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("orientacion %i", (orientation) => {
    expect(place(orientation, 0, 1)).toBe(EXPECTED[orientation][0]);
    expect(place(orientation, 1, 1)).toBe(EXPECTED[orientation][1]);
  });

  it("la matriz de la orientacion 1 es la identidad escalada al rectangulo", () => {
    expect(orientationMatrix(1, W, H, { x: 5, y: 7, width: 300, height: 100 })).toEqual([300, 0, 0, 100, 5, 7]);
  });

  it("la orientacion 6 es un giro de 90° (a y d nulos)", () => {
    const [a, b, c, d] = orientationMatrix(6, W, H, { x: 0, y: 0, width: 100, height: 300 });
    expect(Math.abs(a)).toBeLessThan(1e-9);
    expect(Math.abs(d)).toBeLessThan(1e-9);
    expect(Math.abs(b)).toBeCloseTo(300 / 1, 6 * 0 + 0);
    expect(Math.abs(c)).toBeCloseTo(100, 6);
  });
});

describe("buildPdfFromImages respeta la orientacion EXIF", () => {
  async function pageSizeOf(jpeg: Uint8Array, layout = { orientation: "auto", pageSize: "a4", margin: "none" } as const) {
    const doc = await buildPdfFromImages([new Blob([jpeg as unknown as BlobPart])], layout);
    const saved = await PDFDocument.load(await doc.save());
    return saved.getPage(0).getSize();
  }

  it("300×100 sin etiqueta: pagina HORIZONTAL (como siempre)", async () => {
    const size = await pageSizeOf(plainJpeg(300, 100));
    expect(size.width).toBeGreaterThan(size.height);
  });

  it("300×100 con orientacion 1: igual que sin etiqueta", async () => {
    const size = await pageSizeOf(withOrientation(plainJpeg(300, 100), 1));
    expect(size.width).toBeGreaterThan(size.height);
  });

  it.each([5, 6, 7, 8])("300×100 con orientacion %i: es una foto vertical → pagina VERTICAL", async (value) => {
    const size = await pageSizeOf(withOrientation(plainJpeg(300, 100), value));
    expect(size.height).toBeGreaterThan(size.width);
  });

  it.each([2, 3, 4])("300×100 con orientacion %i: sigue siendo horizontal", async (value) => {
    const size = await pageSizeOf(withOrientation(plainJpeg(300, 100), value));
    expect(size.width).toBeGreaterThan(size.height);
  });

  it("«Ajustar»: la pagina toma el tamano de la imagen YA girada (100×300 con orientacion 6 u 8)", async () => {
    for (const value of [6, 8]) {
      const size = await pageSizeOf(withOrientation(plainJpeg(300, 100), value), { orientation: "auto", pageSize: "fit", margin: "none" } as never);
      expect(Math.round(size.width)).toBe(100);
      expect(Math.round(size.height)).toBe(300);
    }
  });

  it("el flujo de la pagina contiene la matriz del giro (orientacion 6) y no la matriz simple", async () => {
    const draw = async (value: number) => {
      const doc = await buildPdfFromImages([new Blob([withOrientation(plainJpeg(300, 100), value) as unknown as BlobPart])], {
        orientation: "auto",
        pageSize: "fit",
        margin: "none",
      });
      const contents = doc.getPage(0).node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
      return streams
        .map((stream) => new TextDecoder("latin1").decode((stream as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents()))
        .join("\n");
    };
    // Giro de 90°: a y d nulos, b y c = ±300 / ±100.
    expect(await draw(6)).toMatch(/\bq\s+0\s+-?300\s+-?100\s+0\s+[\d.]+\s+[\d.]+\s+cm\b/);
    // Sin etiqueta: matriz simple de `drawImage` (ancho 300, alto 100, sin giro).
    expect(await draw(1)).toMatch(/\b300\s+0\s+0\s+100\s+[\d.]+\s+[\d.]+\s+cm\b/);
  });

  it("varias imagenes con orientaciones distintas dan una pagina cada una, en orden", async () => {
    const doc = await buildPdfFromImages(
      [plainJpeg(300, 100), withOrientation(plainJpeg(300, 100), 6), withOrientation(plainJpeg(100, 300), 8)].map(
        (jpeg) => new Blob([jpeg as unknown as BlobPart]),
      ),
    );
    const saved = await PDFDocument.load(await doc.save());
    const orientations = saved.getPages().map((page) => (page.getWidth() > page.getHeight() ? "H" : "V"));
    // 300×100 → H; 300×100 ori 6 → V; 100×300 ori 8 → H (queda 300×100).
    expect(orientations).toEqual(["H", "V", "H"]);
  });
});
