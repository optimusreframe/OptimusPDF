import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { checkImageBytes } from "@/lib/image/imageIntegrity";
import { makeSyntheticJpeg } from "@/lib/image/photoTestUtils";

/**
 * Comprobacion estructural de fotos: un JPEG cortado, un `.png` que es texto o basura se detectan SIN decodificar; los
 * archivos completos (baseline, progresivos con varias pasadas, con miniaturas MPF detras del EOI, con EXIF) pasan.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function pngBytes(): Uint8Array {
  return new Uint8Array(createCanvas(40, 30).toBuffer("image/png"));
}

/** JPEG a mano con las pasadas indicadas: SOI, APP0, DQT, SOF, DHT, (SOS + datos con FF00 y RST)* y EOI. */
function handmadeJpeg(options: { scans: number; progressive?: boolean; eoi?: boolean; width?: number; height?: number; dataBytes?: number }): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  out.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  out.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(8));
  const width = options.width ?? 16;
  const height = options.height ?? 16;
  out.push(0xff, options.progressive ? 0xc2 : 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00);
  out.push(0xff, 0xc4, 0x00, 0x14, 0x00, ...new Array(16).fill(0), ...new Array(1).fill(0));
  for (let scan = 0; scan < options.scans; scan += 1) {
    out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
    // Datos entropicos: bytes comunes, FF00 (FF escapado), un reinicio FFD0 y relleno FFFF.
    const data: number[] = [];
    for (let index = 0; index < (options.dataBytes ?? 40); index += 1) data.push((index * 37 + 11) % 251);
    data.push(0xff, 0x00, 0x12, 0xff, 0xd0, 0x34, 0xff, 0xff, 0x00, 0x56);
    out.push(...data);
  }
  if (options.eoi !== false) out.push(0xff, 0xd9);
  return new Uint8Array(out);
}

describe("checkImageBytes · JPEG", () => {
  const photo = new Uint8Array(makeSyntheticJpeg({ width: 640, height: 480, seed: 3, quality: 90 }));

  it("un JPEG completo y normal pasa", () => {
    expect(checkImageBytes(photo)).toEqual({ ok: true });
  });

  it("un JPEG con orientacion EXIF (APP1) completo pasa", () => {
    const rotated = new Uint8Array(makeSyntheticJpeg({ width: 320, height: 200, seed: 4, orientation: 6 }));
    expect(checkImageBytes(rotated)).toEqual({ ok: true });
  });

  it("un JPEG cortado en cualquier punto se marca como incompleto (nunca como bueno)", () => {
    for (const fraction of [0.02, 0.1, 0.3, 0.5, 0.75, 0.9, 0.99]) {
      const cut = photo.subarray(0, Math.floor(photo.length * fraction));
      expect(checkImageBytes(cut), `cortado al ${fraction * 100} %`).toEqual({ ok: false, problem: "truncated" });
    }
  });

  it("un JPEG al que solo le falta el marcador final EOI (FFD9) se marca como incompleto", () => {
    expect(photo[photo.length - 2]).toBe(0xff);
    expect(photo[photo.length - 1]).toBe(0xd9);
    expect(checkImageBytes(photo.subarray(0, photo.length - 2))).toEqual({ ok: false, problem: "truncated" });
    expect(checkImageBytes(photo.subarray(0, photo.length - 1))).toEqual({ ok: false, problem: "truncated" });
  });

  it("los datos que hay DESPUES del EOI (miniaturas MPF, mapas de ganancia, relleno) no hacen que falle", () => {
    const tail = new Uint8Array([0xff, 0xd8, 0xff, 0xe2, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xff, 0xd9, 0, 0, 0, 0]);
    const withTrailer = new Uint8Array(photo.length + tail.length);
    withTrailer.set(photo);
    withTrailer.set(tail, photo.length);
    expect(checkImageBytes(withTrailer)).toEqual({ ok: true });
  });

  it("un EOI dentro de un segmento (miniatura EXIF) no se confunde con el final de la imagen principal", () => {
    // APP1 con una miniatura completa dentro; la imagen principal esta cortada: debe ser incompleta, no buena.
    const thumbnail = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...thumbnail];
    const length = body.length + 2;
    const app1 = new Uint8Array([0xff, 0xe1, length >> 8, length & 255, ...body]);
    const cutPhoto = photo.subarray(0, Math.floor(photo.length * 0.5));
    const joined = new Uint8Array(cutPhoto.length + app1.length);
    joined.set(cutPhoto.subarray(0, 2));
    joined.set(app1, 2);
    joined.set(cutPhoto.subarray(2), 2 + app1.length);
    expect(checkImageBytes(joined)).toEqual({ ok: false, problem: "truncated" });
  });

  it("un JPEG progresivo con varias pasadas (SOS repetido, FF00, reinicios y relleno FFFF) completo pasa", () => {
    expect(checkImageBytes(handmadeJpeg({ scans: 3, progressive: true }))).toEqual({ ok: true });
    expect(checkImageBytes(handmadeJpeg({ scans: 1 }))).toEqual({ ok: true });
  });

  it("un JPEG progresivo cortado entre pasadas o dentro de una se marca como incompleto", () => {
    const full = handmadeJpeg({ scans: 3, progressive: true });
    expect(checkImageBytes(handmadeJpeg({ scans: 3, progressive: true, eoi: false }))).toEqual({ ok: false, problem: "truncated" });
    expect(checkImageBytes(full.subarray(0, full.length - 30))).toEqual({ ok: false, problem: "truncated" });
  });

  it("cabeceras sin imagen o con dimensiones imposibles son «danadas»", () => {
    expect(checkImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ ok: false, problem: "corrupt" });
    expect(checkImageBytes(handmadeJpeg({ scans: 1, width: 0 }))).toEqual({ ok: false, problem: "corrupt" });
    expect(checkImageBytes(handmadeJpeg({ scans: 1, height: 0 }))).toEqual({ ok: false, problem: "corrupt" });
  });

  it("solo la firma FFD8FF y nada mas es incompleta", () => {
    expect(checkImageBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({ ok: false, problem: "truncated" });
    expect(checkImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toEqual({ ok: false, problem: "truncated" });
  });
});

describe("checkImageBytes · PNG, WebP y formatos que el navegador abre", () => {
  it("un PNG completo pasa y uno cortado se marca como incompleto", () => {
    const png = pngBytes();
    expect(checkImageBytes(png)).toEqual({ ok: true });
    expect(checkImageBytes(png.subarray(0, png.length - 1))).toEqual({ ok: false, problem: "truncated" });
    expect(checkImageBytes(png.subarray(0, Math.floor(png.length / 2)))).toEqual({ ok: false, problem: "truncated" });
    expect(checkImageBytes(png.subarray(0, 20))).toEqual({ ok: false, problem: "truncated" });
  });

  it("un PNG sin datos de imagen o con el primer bloque equivocado esta danado", () => {
    const png = pngBytes();
    const broken = new Uint8Array(png);
    broken.set(bytesOf("XXXX"), 12); // IHDR -> XXXX
    expect(checkImageBytes(broken)).toEqual({ ok: false, problem: "corrupt" });
  });

  it("WebP: el tamano RIFF declarado no puede pasar del archivo", () => {
    const webp = new Uint8Array(40);
    webp.set(bytesOf("RIFF"), 0);
    webp[4] = 32; // 32 + 8 = 40
    webp.set(bytesOf("WEBPVP8 "), 8);
    expect(checkImageBytes(webp)).toEqual({ ok: true });
    expect(checkImageBytes(webp.subarray(0, 30))).toEqual({ ok: false, problem: "truncated" });
    const zeroSized = new Uint8Array(webp);
    zeroSized[4] = 0;
    expect(checkImageBytes(zeroSized)).toEqual({ ok: false, problem: "corrupt" });
  });

  it("HEIC, AVIF, GIF y BMP se dejan pasar: lo decide el navegador al decodificar", () => {
    const heic = new Uint8Array(40);
    heic.set([0, 0, 0, 24], 0);
    heic.set(bytesOf("ftypheic"), 4);
    expect(checkImageBytes(heic)).toEqual({ ok: true });
    const avif = new Uint8Array(40);
    avif.set(bytesOf("ftypavif"), 4);
    expect(checkImageBytes(avif)).toEqual({ ok: true });
    expect(checkImageBytes(bytesOf("GIF89a....................."))).toEqual({ ok: true });
    const bmp = new Uint8Array(40);
    bmp.set([0x42, 0x4d], 0);
    expect(checkImageBytes(bmp)).toEqual({ ok: true });
  });
});

describe("checkImageBytes · lo que no es una imagen", () => {
  it("un archivo vacio", () => {
    expect(checkImageBytes(new Uint8Array(0))).toEqual({ ok: false, problem: "empty" });
  });

  it("un .jpg con basura aleatoria y un .png que es texto", () => {
    const garbage = new Uint8Array(4096);
    for (let index = 0; index < garbage.length; index += 1) garbage[index] = (index * 131 + 7) & 255;
    garbage[0] = 0x12; // sin firma de imagen
    expect(checkImageBytes(garbage)).toEqual({ ok: false, problem: "notImage" });
    expect(checkImageBytes(bytesOf("Esto no es una imagen, es un texto cualquiera.\n".repeat(20)))).toEqual({ ok: false, problem: "notImage" });
    expect(checkImageBytes(bytesOf("<html><body>hola</body></html>"))).toEqual({ ok: false, problem: "notImage" });
  });

  it("un PDF renombrado a .jpg", () => {
    expect(checkImageBytes(bytesOf("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"))).toEqual({ ok: false, problem: "notImage" });
  });

  it("un SVG no vale (no se puede incrustar como foto)", () => {
    expect(checkImageBytes(bytesOf('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))).toEqual({ ok: false, problem: "notImage" });
  });
});
