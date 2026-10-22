import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { JPEG_CMYK, JPEG_GRAY, JPEG_RGB } from "./__fixtures__/images/jpegSamples";
import { MAX_JPEG_SCAN_BYTES, buildJpegIndex, readJpegHeader, refKey } from "./imagesJpeg";
import { findImageAssets } from "./images";
import { openLegacy } from "./images.testUtils";

type Dict = Record<string, unknown>;

/** PDF con un JPEG incrustado con el diccionario dado (mas lo basico de una imagen). */
async function pdfWithImage(extra: Dict, bytes: Uint8Array = JPEG_RGB.bytes(), size: [number, number] = [JPEG_RGB.width, JPEG_RGB.height], encrypt = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  const ref = doc.context.register(
    doc.context.stream(bytes, { Type: "XObject", Subtype: "Image", Width: size[0], Height: size[1], ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode", ...extra } as never),
  );
  page.node.setXObject(doc.context.obj("Im") as never, ref);
  page.node.addContentStream(doc.context.register(doc.context.flateStream(new TextEncoder().encode("q 100 0 0 75 10 10 cm /Im Do Q\n"))));
  if (encrypt) doc.encrypt({ userPassword: "u", ownerPassword: "o", permissions: { printing: "highResolution" } });
  return doc.save({ useObjectStreams: false });
}

describe("readJpegHeader", () => {
  it("lee medidas y componentes; None si no es un JPEG", () => {
    expect(readJpegHeader(JPEG_RGB.bytes())).toEqual({ width: 64, height: 48, components: 3 });
    expect(readJpegHeader(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(readJpegHeader(new Uint8Array([0xff, 0xd8]))).toBeNull();
    // Cabecera cortada a mitad del marcador SOF.
    expect(readJpegHeader(JPEG_RGB.bytes().subarray(0, 30))).toBeNull();
  });

  it("recorre marcadores antes del SOF (APPn, DQT) sin confundirse con el relleno 0xFF", () => {
    const header = readJpegHeader(JPEG_GRAY.bytes());
    expect(header).toEqual({ width: 48, height: 32, components: 1 });
  });
});

describe("refKey", () => {
  it("coincide con `Ref.toString()` de pdf.js: 12R y, si la generacion no es 0, 12R3", () => {
    expect(refKey({ objectNumber: 12, generationNumber: 0 })).toBe("12R");
    expect(refKey({ objectNumber: 12, generationNumber: 3 })).toBe("12R3");
  });
});

describe("buildJpegIndex — cuando se ofrece el original", () => {
  it("un JPEG RGB con un unico /DCTDecode: si, con los bytes TAL CUAL", async () => {
    const index = await buildJpegIndex(await pdfWithImage({}));
    expect(index.size).toBe(1);
    const [entry] = [...index.values()];
    expect(entry).toMatchObject({ width: 64, height: 48, components: 3 });
    expect([...entry.bytes]).toEqual([...JPEG_RGB.bytes()]);
  });

  it("tambien un JPEG de gris, y el filtro dado como lista de un solo elemento", async () => {
    expect((await buildJpegIndex(await pdfWithImage({ ColorSpace: "DeviceGray" }, JPEG_GRAY.bytes(), [48, 32]))).size).toBe(1);
    expect((await buildJpegIndex(await pdfWithImage({ Filter: ["DCTDecode"] }))).size).toBe(1);
  });

  it.each([
    ["con /SMask", { SMask: undefined as unknown }],
    ["con /Mask (enmascarado por color)", { Mask: [0, 10] }],
    ["con /Decode (invierte los valores)", { Decode: [1, 0, 1, 0, 1, 0] }],
    ["con otro filtro delante (el flujo no es un JPEG)", { Filter: ["ASCIIHexDecode", "DCTDecode"] }],
    ["con un filtro que no es DCT", { Filter: "FlateDecode" }],
    ["con un filtro DESPUES del DCT", { Filter: ["DCTDecode", "FlateDecode"] }],
    ["como mascara de imagen (/ImageMask)", { ImageMask: true }],
  ])("NO se ofrece %s", async (_label, extra) => {
    const dict: Dict = { ...extra };
    const doc = await PDFDocument.create({ updateMetadata: false });
    if ("SMask" in dict) {
      const smask = doc.context.register(doc.context.flateStream(new Uint8Array(64 * 48), { Type: "XObject", Subtype: "Image", Width: 64, Height: 48, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
      dict.SMask = smask;
    }
    const page = doc.addPage([200, 200]);
    // Los bytes SON un JPEG valido: lo unico que debe excluirlo es la regla del caso, no unos bytes rotos.
    const ref = doc.context.register(doc.context.stream(JPEG_RGB.bytes(), { Type: "XObject", Subtype: "Image", Width: 64, Height: 48, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode", ...dict } as never));
    page.node.setXObject(doc.context.obj("Im") as never, ref);
    expect((await buildJpegIndex(await doc.save({ useObjectStreams: false }))).size).toBe(0);
  });

  it("NO se ofrece un JPEG de 4 componentes (CMYK/YCCK de Adobe: fuera del PDF se veria invertido)", async () => {
    expect((await buildJpegIndex(await pdfWithImage({ ColorSpace: "DeviceCMYK" }, JPEG_CMYK.bytes(), [32, 24]))).size).toBe(0);
  });

  it("NO se ofrece si los bytes no empiezan como un JPEG", async () => {
    expect((await buildJpegIndex(await pdfWithImage({}, new Uint8Array(200).fill(7)))).size).toBe(0);
  });

  it("documento cifrado: los bytes del archivo estan cifrados, no se ofrece ninguno", async () => {
    expect((await buildJpegIndex(await pdfWithImage({}, JPEG_RGB.bytes(), [64, 48], true))).size).toBe(0);
  });

  it("un objeto con bytes que no son JPEG no impide indexar los siguientes", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([200, 200]);
    const dict = { Type: "XObject", Subtype: "Image", Width: 64, Height: 48, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "DCTDecode" };
    const bad = doc.context.register(doc.context.stream(new Uint8Array(100).fill(9), dict as never));
    const good = doc.context.register(doc.context.stream(JPEG_RGB.bytes(), dict as never));
    page.node.setXObject(doc.context.obj("Bad") as never, bad);
    page.node.setXObject(doc.context.obj("Good") as never, good);
    const index = await buildJpegIndex(await doc.save({ useObjectStreams: false }));
    expect([...index.keys()]).toEqual([refKey(good)]);
  });

  it("si pdf-lib dice que el documento esta cifrado no se ofrece ningun original (aunque los bytes parezcan un JPEG)", async () => {
    const bytes = await pdfWithImage({});
    const plain = await PDFDocument.load(bytes, { updateMetadata: false });
    Object.defineProperty(plain, "isEncrypted", { get: () => true });
    const load = vi.spyOn(PDFDocument, "load").mockResolvedValue(plain);
    try {
      expect((await buildJpegIndex(bytes)).size).toBe(0);
    } finally {
      load.mockRestore();
    }
    expect((await buildJpegIndex(bytes)).size).toBe(1);
  });

  it("bytes que no son un PDF: indice vacio, sin lanzar", async () => {
    expect((await buildJpegIndex(new Uint8Array([1, 2, 3, 4]))).size).toBe(0);
    expect((await buildJpegIndex(new Uint8Array(0))).size).toBe(0);
  });

  it("por encima del tope de tamano no se abre con pdf-lib (duplicaria la memoria)", async () => {
    const load = vi.spyOn(PDFDocument, "load");
    try {
      expect((await buildJpegIndex(new Uint8Array(MAX_JPEG_SCAN_BYTES + 1))).size).toBe(0);
      expect(load).not.toHaveBeenCalled();
      await buildJpegIndex(new Uint8Array([1, 2, 3]));
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });
});

describe("el motor y los bytes originales", () => {
  it("la clave del indice es la `ref` que entrega pdf.js (si no, jamas se ofreceria el original)", async () => {
    const bytes = await pdfWithImage({});
    const opened = await openLegacy(bytes);
    try {
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes });
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].formats).toEqual(["png", "jpg-original"]);
    } finally {
      await opened.close();
    }
  });

  it("si las medidas del JPEG no coinciden con las de la imagen decodificada, no se ofrece (otro objeto)", async () => {
    // El diccionario dice 32 x 24 pero el JPEG real es 64 x 48: pdf.js decodifica con las medidas del diccionario.
    const bytes = await pdfWithImage({}, JPEG_RGB.bytes(), [32, 24]);
    const opened = await openLegacy(bytes);
    try {
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes });
      for (const asset of result.assets) expect(asset.formats).not.toContain("jpg-original");
    } finally {
      await opened.close();
    }
  });
});
