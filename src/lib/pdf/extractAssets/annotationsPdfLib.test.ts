import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "@cantoo/pdf-lib";
import { EMPTY_INDEX, MAX_PDFLIB_BYTES, indexPdfLibAnnotations, inspectAppearance, objectNumberOfAnnotationId } from "./annotationsPdfLib";
import { makeDecoys, makeSigKids, makeSigWidgets, makeStampAnnot, makeWatermarkAnnot } from "./__fixtures__/annots/generate";

async function dictOf(entries: Record<string, unknown>) {
  const doc = await PDFDocument.create();
  return doc.context.obj(entries as never) as unknown as import("@cantoo/pdf-lib").PDFDict;
}

describe("objectNumberOfAnnotationId", () => {
  it("lee «13R» como objeto 13 y rechaza lo sintetico", () => {
    expect(objectNumberOfAnnotationId("13R")).toBe(13);
    expect(objectNumberOfAnnotationId("pdfjs_internal_id_5")).toBeNull();
    expect(objectNumberOfAnnotationId("12")).toBeNull();
    expect(objectNumberOfAnnotationId(undefined)).toBeNull();
  });
});

describe("indexPdfLibAnnotations", () => {
  it("sin bytes, con bytes vacios o que no son un PDF devuelve un indice vacio", async () => {
    expect(await indexPdfLibAnnotations(undefined, [0])).toBe(EMPTY_INDEX);
    expect(await indexPdfLibAnnotations(new Uint8Array(0), [0])).toBe(EMPTY_INDEX);
    expect(await indexPdfLibAnnotations(new TextEncoder().encode("esto no es un pdf"), [0])).toBe(EMPTY_INDEX);
    expect(EMPTY_INDEX.loaded).toBe(false);
    expect(EMPTY_INDEX.find(0, 1)).toBeUndefined();
    expect(EMPTY_INDEX.forPage(0)).toEqual([]);
  });

  it("el tope de tamano evita cargar PDF enormes solo para leer anotaciones", () => {
    expect(MAX_PDFLIB_BYTES).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it("/V de un campo /Sig: presente, ausente y heredado del padre; FT y nombre heredados", async () => {
    const { bytes } = await makeSigWidgets();
    const index = await indexPdfLibAnnotations(bytes, [0, 1]);
    expect(index.loaded).toBe(true);
    const page0 = index.forPage(0).filter((a) => a.fieldType === "Sig");
    expect(page0.map((a) => [a.fieldName, a.hasValue])).toEqual([["SigConApariencia", false], ["SigVacio", false]]);
    const page1 = index.forPage(1).filter((a) => a.fieldType === "Sig");
    expect(page1.map((a) => [a.fieldName, a.hasValue])).toEqual([["SigFirmado", true], ["SigTexto", true]]);

    const kids = await indexPdfLibAnnotations((await makeSigKids()).bytes, [0]);
    expect(kids.forPage(0).map((a) => [a.fieldType, a.fieldName, a.hasValue])).toEqual([["Sig", "FirmaPadreFirmada", true], ["Sig", "FirmaPadreSinValor", false]]);
  });

  it("clasifica la apariencia: trazos, texto, vacia o ausente", async () => {
    const { bytes } = await makeSigWidgets();
    const index = await indexPdfLibAnnotations(bytes, [0, 1]);
    const byName = Object.fromEntries([...index.forPage(0), ...index.forPage(1)].map((a) => [a.fieldName, a.appearance]));
    expect(byName.SigConApariencia).toMatchObject({ present: true, hasPaths: true, hasText: false, hasImage: false, empty: false });
    expect(byName.SigConApariencia.pathSegments).toBeGreaterThan(20);
    expect(byName.SigTexto).toMatchObject({ present: true, hasText: true, empty: false });
    expect(byName.SigTexto.pathSegments).toBeLessThanOrEqual(8);
    expect(byName.SigVacio).toMatchObject({ present: false, empty: true });
  });

  it("lee el nombre del sello, el subtipo Watermark y su texto", async () => {
    const stamp = await indexPdfLibAnnotations((await makeStampAnnot()).bytes, [0]);
    expect(stamp.forPage(0).map((a) => [a.subtype, a.stampName])).toEqual([["Stamp", "Approved"], ["Stamp", "SignHere"]]);
    const watermark = await indexPdfLibAnnotations((await makeWatermarkAnnot()).bytes, [0]);
    expect(watermark.forPage(0)[0]).toMatchObject({ subtype: "Watermark", appearance: { hasText: true } });
  });

  it("solo indexa las paginas pedidas y los senuelos no traen apariencia", async () => {
    const { bytes } = await makeSigWidgets();
    const index = await indexPdfLibAnnotations(bytes, [1]);
    expect(index.forPage(0)).toEqual([]);
    expect(index.forPage(1).length).toBe(2);
    const decoys = await indexPdfLibAnnotations((await makeDecoys()).bytes, [0]);
    expect(decoys.forPage(0).find((a) => a.subtype === "Link")?.appearance.present).toBe(false);
  });

  it("encuentra por pagina y numero de objeto", async () => {
    const { bytes } = await makeSigWidgets();
    const index = await indexPdfLibAnnotations(bytes, [0]);
    const first = index.forPage(0)[0];
    expect(index.find(0, first.objectNumber)).toBe(first);
    expect(index.find(0, 99999)).toBeUndefined();
    expect(index.find(5, first.objectNumber)).toBeUndefined();
  });

  it("una anotacion mal formada o un /Annots que no es un arreglo no impiden leer el resto", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const good = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("ok"), Rect: [0, 0, 10, 10] } as never));
    const bad = doc.context.register(doc.context.obj({ Subtype: 5 } as never));
    page.node.set(PDFName.of("Annots"), doc.context.obj([bad, good, doc.context.obj({ Subtype: "Link" } as never), 7] as never));
    const page2 = doc.addPage([200, 200]);
    page2.node.set(PDFName.of("Annots"), doc.context.obj({ no: "arreglo" } as never));
    const index = await indexPdfLibAnnotations(await doc.save(), [0, 1]);
    expect(index.forPage(0).map((a) => a.fieldName ?? a.subtype)).toEqual(["", "ok"]);
    expect(index.forPage(1)).toEqual([]);
  });
});

describe("inspectAppearance", () => {
  it("sin /AP o con /AP sin /N: ausente y vacia", async () => {
    expect(inspectAppearance(await dictOf({}))).toMatchObject({ present: false, empty: true });
    expect(inspectAppearance(await dictOf({ AP: {} }))).toMatchObject({ present: false, empty: true });
  });

  it("un flujo solo con q Q (o vacio) esta vacio; con trazos o texto, no", async () => {
    const doc = await PDFDocument.create();
    const make = (content: string, resources?: Record<string, unknown>) => doc.context.register(doc.context.stream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], ...(resources ? { Resources: resources } : {}) } as never));
    const withAp = (ref: unknown) => doc.context.obj({ AP: { N: ref } } as never) as unknown as import("@cantoo/pdf-lib").PDFDict;
    expect(inspectAppearance(withAp(make("q Q")))).toMatchObject({ present: true, empty: true });
    expect(inspectAppearance(withAp(make("")))).toMatchObject({ present: true, empty: true });
    expect(inspectAppearance(withAp(make("1 w 0 0 m 5 5 l S")))).toMatchObject({ empty: false, hasPaths: true, hasText: false });
    expect(inspectAppearance(withAp(make("BT /F1 8 Tf (hola) Tj ET")))).toMatchObject({ empty: false, hasText: true, hasPaths: false });
  });

  it("detecta una imagen dibujada con Do, tambien dentro de un Form anidado (Acrobat usa capas n0, n2)", async () => {
    const doc = await PDFDocument.create();
    const image = doc.context.register(doc.context.stream("\u0000\u0000\u0000", { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceRGB", BitsPerComponent: 8 } as never));
    const inner = doc.context.register(doc.context.stream("q 10 0 0 10 0 0 cm /Im Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Resources: { XObject: { Im: image } } } as never));
    const outer = doc.context.register(doc.context.stream("q /n2 Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Resources: { XObject: { n2: inner } } } as never));
    const dict = doc.context.obj({ AP: { N: outer } } as never) as unknown as import("@cantoo/pdf-lib").PDFDict;
    expect(inspectAppearance(dict)).toMatchObject({ present: true, hasImage: true, empty: false });
  });

  it("si /N es un diccionario de estados usa /AS (casillas) o el primero", async () => {
    const doc = await PDFDocument.create();
    const on = doc.context.register(doc.context.stream("0 0 m 5 5 l S", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] } as never));
    const off = doc.context.register(doc.context.stream("q Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] } as never));
    const stateful = (state?: string) => doc.context.obj({ ...(state ? { AS: PDFName.of(state) } : {}), AP: { N: { On: on, Off: off } } } as never) as unknown as import("@cantoo/pdf-lib").PDFDict;
    expect(inspectAppearance(stateful("On")).hasPaths).toBe(true);
    expect(inspectAppearance(stateful("Off")).empty).toBe(true);
    expect(inspectAppearance(stateful()).present).toBe(true);
  });
});
