import { describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFName, PDFString } from "@cantoo/pdf-lib";
import { findAnnotationAssets, planPages } from "./annotations";
import { ownsAnnotationAsset, renderAnnotationAsset } from "./annotationsRender";
import {
  buildAnnotCorpus,
  makeDecoys,
  makeInkMulti,
  makeMixed,
  makeOcgHidden,
  makeOcgWatermark,
  makeRotatedPage,
  makeSigKids,
  makeSigWidgets,
  makeStampAnnot,
  makeStampDecoys,
  makeWatermarkAnnot,
  makeWatermarkEdges,
  wave,
} from "./__fixtures__/annots/generate";
import { decodePng, getLegacyOps, isPng, napiSurfaceFactory, withLegacyDocument } from "./__fixtures__/annots/nodeEnv";
import { bySource, runOn, spyDocument } from "./__fixtures__/annots/testKit";
import { EXTRACT_LIMITS, type ExtractedAsset } from "./types";
import type { PdfDocument, RasterImage } from "./annotationsTypes";

const render = async (doc: PdfDocument, asset: ExtractedAsset, format?: Parameters<typeof renderAnnotationAsset>[2]) => {
  const ops = await getLegacyOps();
  return renderAnnotationAsset(doc, asset, format, { ops, createSurface: napiSurfaceFactory });
};

const visible = (image: RasterImage): number => image.data.filter((v, i) => i % 4 === 3 && v > 8).length;
const dark = (image: RasterImage): number => {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 3] > 60 && image.data[i] < 80 && image.data[i + 1] < 80 && image.data[i + 2] < 80) count += 1;
  return count;
};
const meanColor = (image: RasterImage, minAlpha = 200): [number, number, number] => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < minAlpha) continue;
    r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; n += 1;
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
};

describe("Ink", () => {
  it("SVG con trazos, color y grosor reales", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      const blue = assets[0];
      expect(blue.formats).toEqual(["png", "svg"]);
      const svg = await (await render(doc, blue, "svg")).text();
      expect(svg).toContain('stroke="#0d1ab2"');
      expect(svg).toContain('stroke-width="2.5"');
      expect(svg.match(/<path /g)).toHaveLength(2);
      const red = await (await render(doc, assets[1], "svg")).text();
      expect(red).toContain('stroke="#d91a1a"');
      expect(red).toContain('stroke-width="3"');
    });
  });

  it("PNG transparente con el color de la anotacion y sin la pagina debajo", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      const png = await render(doc, assets[1]); // la roja: por defecto PNG
      expect(await isPng(png)).toBe(true);
      const image = await decodePng(png);
      expect(image.data[3]).toBe(0); // esquina transparente
      const [r, g, b] = meanColor(image);
      expect(r).toBeGreaterThan(190);
      expect(g).toBeLessThan(60);
      expect(b).toBeLessThan(60);
      expect(dark(image)).toBe(0); // el texto de la pagina no se cuela
      expect(image.width).toBe(assets[1].pixel?.width);
    });
  });

  it("la anotacion sin /AP tambien se extrae (los trazos salen de /InkList, no de la apariencia)", async () => {
    const { assets } = await runOn(await makeInkMulti());
    const noAp = assets[2];
    expect(noAp.reasons.join(" ")).toContain("#0D0D0D");
    expect(noAp.thumb).not.toBeNull();
  });

  it("la caja se da en coordenadas de la VISTA normalizadas (origen arriba a la izquierda)", async () => {
    const { assets } = await runOn(await makeInkMulti());
    const rect = assets[0].occurrences[0].rect;
    expect(rect.x).toBeCloseTo(89 / 612, 1);
    expect(rect.width).toBeCloseTo(215 / 612, 1);
    // y de usuario 100-170 => vista (792 - y): 622-692 de 792
    expect(rect.y).toBeGreaterThan(0.75);
    expect(rect.y + rect.height).toBeLessThan(0.9);
  });

  it("en una pagina girada 90 la firma sale como firma (la proporcion se mide en la vista) y su caja esta en la vista", async () => {
    const { assets } = await runOn(await makeRotatedPage());
    const ink = bySource(assets, "ink-annot")[0];
    expect(ink.kind).toBe("signature");
    const rect = ink.occurrences[0].rect;
    expect(rect.x).toBeGreaterThan(0.12);
    expect(rect.x).toBeLessThan(0.16);
    expect(rect.width).toBeGreaterThan(0.32);
    expect(rect.y).toBeGreaterThan(0.58);
    expect(rect.y).toBeLessThan(0.66);
    expect(rect.height).toBeLessThan(0.16);
    expect(ink.pixel?.width).toBeGreaterThan((ink.pixel?.height ?? 0) * 2);
  });

  it("la Ink con la bandera Hidden no se extrae", async () => {
    expect((await runOn(await makeDecoys())).assets).toEqual([]);
  });
});

describe("campos /Sig", () => {
  it("un campo vacio se informa con confianza baja, sin pixeles ni formatos", async () => {
    const { assets } = await runOn(await makeSigWidgets());
    const empty = assets[1];
    expect(empty).toMatchObject({ kind: "signature", source: "sig-widget", pixel: null, formats: [], thumb: null, bytesEstimate: 0 });
    expect(empty.confidence).toBeLessThanOrEqual(0.2);
    expect(empty.reasons).toContain("campo de firma vacío (sin firmar)"); // por la lectura de la apariencia, sin renderizar
    expect(empty.occurrences[0].rect.width).toBeGreaterThan(0.2);
  });

  it("con /V: aviso digital-signature por pagina y campo, y se dice que no se verifica", async () => {
    const { assets, warnings } = await runOn(await makeSigWidgets());
    expect(warnings).toEqual([
      { code: "digital-signature", pageIndex: 1, detail: "SigFirmado" },
      { code: "digital-signature", pageIndex: 1, detail: "SigTexto" },
    ]);
    const signed = assets[2];
    expect(signed.reasons.join(" ")).toContain("firmado digitalmente");
    expect(signed.reasons.join(" ")).toContain("no se verifica");
    expect(signed.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("la apariencia de texto («Digitally signed by…») baja la confianza y lo explica", async () => {
    const { assets } = await runOn(await makeSigWidgets());
    const text = assets[3];
    expect(text.confidence).toBeLessThanOrEqual(0.4);
    expect(text.reasons.join(" ")).toContain("parece texto");
    expect(text.formats).toEqual(["png"]);
  });

  it("el PNG es SOLO la caja del campo, limpia (sin la pagina) y con la tinta de la firma", async () => {
    const fixture = await makeSigWidgets();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      const image = await decodePng(await render(doc, assets[0]));
      expect(image.data[3]).toBe(0);
      expect(dark(image)).toBe(0);
      const [r, , b] = meanColor(image);
      expect(b).toBeGreaterThan(r + 40); // azul
      // La caja del campo mide 190 x 60 pt: a 4 px/pt la firma recortada no pasa de 760 x 240.
      expect(image.width).toBeLessThanOrEqual(190 * 4 + 8);
      expect(image.height).toBeLessThanOrEqual(60 * 4 + 8);
      expect(visible(image)).toBeGreaterThan(300);
    });
  });

  it("los campos con FT y /V en el padre (/Kids) se detectan y se avisa del firmado", async () => {
    const { assets, warnings } = await runOn(await makeSigKids());
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.source === "sig-widget" && a.confidence >= 0.7)).toBe(true);
    expect(warnings.map((w) => [w.code, w.detail])).toEqual([["digital-signature", "FirmaPadreFirmada"]]);
  });

  it("sin los bytes del PDF (sin pdf-lib) se sigue detectando, con confianza media y sin saber si hay /V", async () => {
    const { assets, warnings } = await runOn(await makeSigWidgets(), { withBytes: false });
    expect(assets).toHaveLength(4);
    expect(assets[0]).toMatchObject({ confidence: 0.6, formats: ["png"] });
    expect(assets[0].reasons.join(" ")).toContain("no se pudo comprobar");
    expect(warnings).toEqual([]); // limite documentado: el /V solo se lee con pdf-lib
  });

  it("regenerar un campo vacio es un error controlado", async () => {
    const fixture = await makeSigWidgets();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      await expect(render(doc, assets[1])).rejects.toMatchObject({ name: "AnnotationRenderError", code: "unsupported-format" });
    });
  });
});

describe("sellos", () => {
  it("Stamp: PNG con alfa, solo los pixeles del sello (el texto de la pagina que queda debajo no entra)", async () => {
    const fixture = await makeStampAnnot();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      expect(assets).toHaveLength(2);
      const image = await decodePng(await render(doc, assets[0]));
      // Solo los bordes antialias del sello sobre las letras negras de debajo salen oscuros (limite de la diferencia de renders).
      expect(dark(image)).toBeLessThan(visible(image) * 0.01);
      const [r, g, b] = meanColor(image);
      expect(r).toBeGreaterThan(170);
      expect(g + b).toBeLessThan(120);
      expect(image.data[3]).toBe(0);
      expect(assets[0].pixel).toMatchObject({ hasAlpha: true });
      expect(assets[0].confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  it("Stamp sin apariencia (no pinta nada) no se extrae", async () => {
    expect((await runOn(await makeStampDecoys())).assets).toEqual([]);
  });

  it("Form XObject: confianza media (<= 0,7), una sola entrada para el sello repetido y PNG limpio de lo que hay debajo", async () => {
    const fixture = (await buildAnnotCorpus()).find((item) => item.name === "form-stamps");
    if (!fixture) throw new Error("falta form-stamps");
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      expect(assets).toHaveLength(2);
      const circle = assets.find((a) => a.reasons.join(" ").includes("circular")) as ExtractedAsset;
      expect(circle.occurrences.map((o) => o.pageIndex)).toEqual([0, 1]);
      expect(circle.confidence).toBeLessThanOrEqual(0.7);
      expect(circle.ref).toMatchObject({ engine: "vector", pageIndex: 0 });
      const image = await decodePng(await render(doc, circle));
      expect(dark(image)).toBe(0);
      expect(meanColor(image)[0]).toBeGreaterThan(190);
      // Es la caja del sello (92 pt) y no la de la pagina.
      expect(image.width).toBeLessThan(100 * 4 + 8);
      expect(image.width).toBeGreaterThan(90 * 4);
    });
  });
});

describe("marcas de agua", () => {
  it("(a) capa «Watermark»: PNG solo del grupo, mas pequeno que la pagina y sin la capa que no es marca", async () => {
    const fixture = await makeOcgWatermark();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      expect(assets).toHaveLength(1);
      const asset = assets[0];
      expect(asset.ref).toEqual({ engine: "ocg", groupId: expect.any(String) });
      expect(asset.reasons).toEqual(expect.arrayContaining(["capa opcional «Watermark»", "visible por defecto", "aparece en 3 páginas"]));
      const image = await decodePng(await render(doc, asset));
      expect(image.width).toBeLessThan(612 * 4);
      expect(image.data[3]).toBe(0);
      const [r, g] = meanColor(image, 50); // la capa es translucida (ca 0,3): su alfa ronda 76
      expect(Math.abs(r - g)).toBeLessThan(12); // gris
      expect(g).toBeGreaterThan(100);
      // El rectangulo verde de «Capa de notas» no esta.
      let green = 0;
      for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 3] > 50 && image.data[i + 1] > image.data[i] + 60) green += 1;
      expect(green).toBe(0);
    });
  });

  it("(a) una capa apagada por defecto tambien se extrae y lo dice", async () => {
    const { assets } = await runOn(await makeOcgHidden());
    expect(assets).toHaveLength(1);
    expect(assets[0].reasons).toContain("oculta por defecto");
    expect(assets[0].thumb).not.toBeNull();
  });

  it("(a) una capa con nombre de marca de agua que ninguna pagina usa no da elemento", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const ocg = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("Watermark") } as never));
    doc.catalog.set(PDFName.of("OCProperties"), doc.context.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } } as never));
    const bytes = await doc.save();
    expect((await runOn({ bytes })).assets).toEqual([]);
  });

  it("(b) anotacion /Watermark con apariencia: elemento kind watermark, alta confianza, PNG del texto", async () => {
    const fixture = await makeWatermarkAnnot();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ kind: "watermark", source: "stamp-annot", confidence: 0.9 });
      expect(assets[0].reasons[0]).toContain("/Watermark");
      const image = await decodePng(await render(doc, assets[0]));
      expect(visible(image)).toBeGreaterThan(500);
    });
  });

  it("(c) texto translucido repetido: entrega el TEXTO y una vista previa; el limite del 50 % es exacto", async () => {
    const { assets } = await runOn(await makeWatermarkEdges());
    expect(assets).toHaveLength(1);
    expect(assets[0].ref).toMatchObject({ engine: "text", text: "CONFIDENCIAL", angleDeg: 35, opacity: expect.closeTo(0.2, 2) });
    expect(assets[0].occurrences.map((o) => o.pageIndex)).toEqual([0, 2, 4]);
    expect(assets[0].formats).toEqual(["txt", "png", "svg"]);
    expect(assets[0].reasons).toContain("repetido en 3 de 6 páginas");
  });

  it("(c) solo se analizan las paginas pedidas: con un rango, el 50 % se calcula sobre ese rango", async () => {
    const fixture = await makeWatermarkEdges();
    // Paginas 0 y 1: «CONFIDENCIAL» solo esta en la 0 (1 de 2 y no se repite en 2 paginas): nada.
    expect((await runOn(fixture, { options: { pageRange: { from: 0, to: 1 } } })).assets).toEqual([]);
    // Paginas 0 a 2: esta en 0 y 2 (2 de 3 = 67 %): si.
    const range = await runOn(fixture, { options: { pageRange: { from: 0, to: 2 } } });
    expect(range.assets).toHaveLength(1);
    expect(range.assets[0].reasons).toContain("repetido en 2 de 3 páginas");
  });

  it("(d) la imagen translucida repetida no se entrega: queda como candidata con su pagina y su caja", async () => {
    const fixture = (await buildAnnotCorpus()).find((item) => item.name === "translucent-image-6");
    if (!fixture) throw new Error("falta translucent-image-6");
    const result = await runOn(fixture);
    expect(result.assets).toEqual([]);
    expect(result.translucentImages).toHaveLength(6);
    expect(result.translucentImages?.[0]).toMatchObject({ pageIndex: 0, alpha: expect.closeTo(0.2, 2) });
    expect(result.translucentImages?.[0].rect.width).toBeGreaterThan(0.6);
  });
});

describe("(d) imagenes translucidas: solo las repetidas y grandes", () => {
  const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
  async function withImages(plan: Array<{ page: number; opacity: number; width: number; height: number }>, pages = 6) {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(PNG);
    for (let i = 0; i < pages; i += 1) {
      const page = doc.addPage([612, 792]);
      for (const item of plan.filter((p) => p.page === i)) page.drawImage(png, { x: 80, y: 200, width: item.width, height: item.height, opacity: item.opacity });
    }
    return { bytes: await doc.save() };
  }

  it("en menos de la mitad de las paginas no hay candidata", async () => {
    const fixture = await withImages([{ page: 0, opacity: 0.2, width: 450, height: 380 }, { page: 3, opacity: 0.2, width: 450, height: 380 }]);
    expect((await runOn(fixture)).translucentImages).toBeUndefined();
  });

  it("en la mitad o mas si; opaca o pequena no", async () => {
    const big = [0, 1, 2].map((page) => ({ page, opacity: 0.2, width: 450, height: 380 }));
    expect((await runOn(await withImages(big))).translucentImages?.map((c) => c.pageIndex)).toEqual([0, 1, 2]);
    expect((await runOn(await withImages(big.map((i) => ({ ...i, opacity: 1 }))))).translucentImages).toBeUndefined();
    expect((await runOn(await withImages(big.map((i) => ({ ...i, width: 100, height: 100 }))))).translucentImages).toBeUndefined();
  });

  it("un documento de una sola pagina no tiene repeticion que demostrar", async () => {
    expect((await runOn(await withImages([{ page: 0, opacity: 0.2, width: 450, height: 380 }], 1))).translucentImages).toBeUndefined();
  });
});

describe("limites, cancelacion y progreso", () => {
  it("planPages respeta el rango y el tope de paginas del contrato", () => {
    expect(planPages(10, undefined)).toEqual({ pages: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], truncated: false });
    expect(planPages(10, { pageRange: { from: 3, to: 5 } })).toEqual({ pages: [3, 4, 5], truncated: false });
    expect(planPages(10, { pageRange: { from: 8, to: 99 } }).pages).toEqual([8, 9]);
    expect(planPages(10, { maxPages: 4 })).toEqual({ pages: [0, 1, 2, 3], truncated: true });
    expect(planPages(1000, undefined).pages).toHaveLength(EXTRACT_LIMITS.maxPages);
    expect(planPages(1000, { maxPages: 9999 }).pages).toHaveLength(EXTRACT_LIMITS.maxPages);
    expect(planPages(5, { pageRange: { from: -3, to: 2 } }).pages).toEqual([0, 1, 2]);
    expect(planPages(5, { maxPages: 0 }).pages).toHaveLength(1);
  });

  it("el rango deja fuera lo que no pide", async () => {
    const result = await runOn(await makeMixed(), { options: { pageRange: { from: 1, to: 2 } } });
    expect(result.assets.map((a) => [a.source, a.occurrences.map((o) => o.pageIndex)])).toEqual([
      ["stamp-annot", [1]],
      ["sig-widget", [2]],
      ["text", [1, 2]], // la marca de texto se recalcula sobre las 2 paginas analizadas
    ]);
  });

  it("maxPages recorta y avisa", async () => {
    const result = await runOn(await makeMixed(), { options: { maxPages: 2 } });
    expect(result.warnings.some((w) => w.code === "too-many-pages")).toBe(true);
    expect(result.assets.every((a) => a.occurrences.every((o) => o.pageIndex < 2))).toBe(true);
  });

  it("maxAssets y los elementos que ya llevan otros motores cuentan para el tope", async () => {
    const fixture = await makeMixed();
    const capped = await runOn(fixture, { options: { maxAssets: 2 } });
    expect(capped.assets).toHaveLength(2);
    expect(capped.warnings.some((w) => w.code === "too-many-assets")).toBe(true);
    const shared = await runOn(fixture, { options: { maxAssets: 5 }, assetsAlreadyFound: 4 });
    expect(shared.assets).toHaveLength(1);
    const none = await runOn(fixture, { options: { maxAssets: 3 }, assetsAlreadyFound: 3 });
    expect(none.assets).toHaveLength(0);
    const free = await runOn(fixture, { options: { maxAssets: 500 } });
    expect(free.assets.length).toBeGreaterThan(3);
    expect(free.warnings.some((w) => w.code === "too-many-assets")).toBe(false);
  });

  it("informa del progreso: una vez por pagina, con el recuento acumulado", async () => {
    const calls: Array<{ pageIndex: number; pageCount: number; assetsSoFar: number }> = [];
    await runOn(await makeMixed(), { options: { onProgress: (p) => calls.push(p) } });
    expect(calls.map((c) => c.pageIndex)).toEqual([0, 1, 2, 3]);
    expect(calls.every((c) => c.pageCount === 4)).toBe(true);
    for (let i = 1; i < calls.length; i += 1) expect(calls[i].assetsSoFar).toBeGreaterThanOrEqual(calls[i - 1].assetsSoFar);
    expect(calls[calls.length - 1].assetsSoFar).toBe(1 + 1 + 1 + 0); // ink + stamp + sig (el resto son de varias paginas y salen al final)
  });

  it("cancela antes de empezar y a mitad de camino con el mismo error que el resto de herramientas", async () => {
    const fixture = await makeMixed();
    const already = new AbortController();
    already.abort();
    await expect(runOn(fixture, { options: { signal: already.signal } })).rejects.toMatchObject({ code: "cancelled" });
    const mid = new AbortController();
    await expect(runOn(fixture, { options: { signal: mid.signal, onProgress: (p) => p.pageIndex === 1 && mid.abort() } })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancelar a mitad de camino corta un documento sin nada que renderizar y no abre mas paginas", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 5; i += 1) doc.addPage([200, 200]);
    const bytes = await doc.save();
    const ops = await getLegacyOps();
    const controller = new AbortController();
    let opened = 0;
    await withLegacyDocument(bytes, async (real) => {
      const spied = spyDocument(real, { failPage: () => { opened += 1; return null; } });
      await expect(
        findAnnotationAssets(spied, { ops, createSurface: napiSurfaceFactory, bytes, options: { signal: controller.signal, onProgress: (p) => p.pageIndex === 1 && controller.abort() } }),
      ).rejects.toMatchObject({ code: "cancelled" });
    });
    expect(opened).toBe(2); // paginas 1 y 2; las otras tres ni se abren
  });

  it("cancelar justo tras la ultima pagina tambien cancela (no devuelve un resultado a medias)", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) doc.addPage([200, 200]);
    const controller = new AbortController();
    await expect(runOn({ bytes: await doc.save() }, { options: { signal: controller.signal, onProgress: (p) => p.pageIndex === 2 && controller.abort() } })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("llama a page.cleanup() en cada pagina, tambien cuando la pagina falla", async () => {
    const fixture = await makeMixed();
    const cleaned: number[] = [];
    const ops = await getLegacyOps();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const spied = spyDocument(doc, { cleaned, failOperators: (n) => (n === 2 ? new Error("operadores rotos") : null) });
      const result = await findAnnotationAssets(spied, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      expect(result.warnings.some((w) => w.code === "decode-failed" && w.pageIndex === 1)).toBe(true);
    });
    expect(cleaned.filter((n, i) => cleaned.indexOf(n) === i).sort()).toEqual([1, 2, 3, 4]);
    expect(cleaned.filter((n) => n === 2).length).toBeGreaterThanOrEqual(1);
  });
});

describe("errores controlados", () => {
  it("una pagina que no se puede abrir, o cuyas anotaciones fallan, avisa y el resto sigue", async () => {
    const fixture = await makeMixed();
    const ops = await getLegacyOps();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const spied = spyDocument(doc, { failPage: (n) => (n === 1 ? new Error("pagina rota") : null), failAnnotations: (n) => (n === 2 ? new Error("anotaciones rotas") : null) });
      const result = await findAnnotationAssets(spied, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      const codes = result.warnings.filter((w) => w.code === "decode-failed");
      expect(codes.map((w) => w.pageIndex).sort()).toEqual([0, 1]);
      expect(result.assets.some((a) => a.source === "form")).toBe(true); // pagina 4 intacta
    });
  });

  it("pdf.js que deja una promesa sin resolver (anotaciones, operadores, pagina) no cuelga la extraccion: aviso y siguiente pagina", async () => {
    const fixture = await makeMixed();
    const ops = await getLegacyOps();
    const hang = <T,>(): Promise<T> => new Promise<T>(() => undefined);
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const stuck = new Proxy(doc, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop !== "getPage") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          return async (n: number) => {
            if (n === 1) return hang();
            const page = await target.getPage(n);
            return new Proxy(page, {
              get(pageTarget, pageProp) {
                const member = Reflect.get(pageTarget, pageProp, pageTarget) as unknown;
                if (typeof member !== "function") return member;
                if (n === 2 && pageProp === "getAnnotations") return () => hang();
                if (n === 3 && pageProp === "getOperatorList") return () => hang();
                return (member as (...a: unknown[]) => unknown).bind(pageTarget);
              },
            });
          };
        },
      }) as unknown as PdfDocument;
      const started = performance.now();
      const result = await findAnnotationAssets(stuck, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes, stepTimeoutMs: 300 });
      expect(performance.now() - started).toBeLessThan(5000);
      const timeouts = result.warnings.filter((w) => w.code === "decode-failed" && w.detail?.includes("tiempo agotado"));
      expect(timeouts.map((w) => w.pageIndex).sort()).toEqual([0, 1, 2]);
      // La pagina 4 (con el sello de contenido) se analizo con normalidad.
      expect(result.assets.some((a) => a.source === "form")).toBe(true);
    });
  });

  it("cancelar mientras pdf.js esta colgado corta al instante, sin esperar al plazo", async () => {
    const fixture = await makeMixed();
    const ops = await getLegacyOps();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const stuck = new Proxy(doc, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop === "getPage") return () => new Promise(() => undefined);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as unknown as PdfDocument;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = performance.now();
      await expect(findAnnotationAssets(stuck, { ops, createSurface: napiSurfaceFactory, bytes: fixture.bytes, options: { signal: controller.signal }, stepTimeoutMs: 60_000 })).rejects.toMatchObject({ code: "cancelled" });
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  it("anotaciones malformadas (sin InkList, caja imposible, tipos raros) no rompen las buenas", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const add = (dict: Record<string, unknown>) => {
      const ref = doc.context.register(doc.context.obj({ Type: "Annot", P: page.ref, F: 4, ...dict } as never));
      const annots = page.node.lookup(PDFName.of("Annots"));
      if (annots && "push" in annots) (annots as unknown as { push(r: unknown): void }).push(ref);
      else page.node.set(PDFName.of("Annots"), doc.context.obj([ref] as never));
    };
    add({ Subtype: "Ink", Rect: [10, 10, 100, 50], InkList: [] });
    add({ Subtype: "Ink", Rect: [0, 0, 0, 0], InkList: [[1]] });
    add({ Subtype: "Ink", InkList: "no" });
    add({ Subtype: "Stamp", Rect: [0, 0, 0, 0] });
    add({ Subtype: "Stamp", Rect: [50, 50, 20, 20] });
    add({ Subtype: "Widget", FT: "Sig", Rect: [0, 0, 0, 0] });
    add({ Subtype: "Nada" });
    const good = wave(100, 300, 190, 60, 3);
    add({ Subtype: "Ink", Rect: [90, 290, 300, 370], InkList: [good.flatMap(([x, y]) => [x, y])], C: [0, 0, 1], BS: { W: 2 } });
    const bytes = await doc.save();
    const result = await runOn({ bytes });
    const ink = result.assets.filter((a) => a.source === "ink-annot");
    expect(ink).toHaveLength(1);
    expect(ink[0].kind).toBe("signature");
    // La firma invisible (0x0) se informa como campo sin caja visible; lo demas no da elementos.
    const invisible = result.assets.filter((a) => a.source === "sig-widget");
    expect(invisible).toHaveLength(1);
    expect(invisible[0].reasons.join(" ")).toContain("sin caja visible");
    expect(invisible[0]).toMatchObject({ pixel: null, formats: [] });
    expect(result.assets.filter((a) => a.source === "stamp-annot")).toHaveLength(0);
  });

  it("un PDF sin anotaciones ni capas da un resultado vacio y sin avisos", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const result = await runOn({ bytes: await doc.save() });
    expect(result).toEqual({ assets: [], warnings: [] });
  });
});

describe("regenerar bajo demanda", () => {
  it("rechaza formatos que el elemento no ofrece y anotaciones que ya no estan", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      await expect(render(doc, assets[0], "jpg")).rejects.toMatchObject({ code: "unsupported-format" });
      await expect(render(doc, assets[0], "txt")).rejects.toMatchObject({ code: "unsupported-format" });
      const gone = { ...assets[0], ref: { engine: "annotation" as const, pageIndex: 0, annotationIndex: 99 } };
      await expect(render(doc, gone)).rejects.toMatchObject({ code: "not-found" });
      const badPage = { ...assets[0], ref: { engine: "annotation" as const, pageIndex: 40, annotationIndex: 0 } };
      await expect(render(doc, badPage)).rejects.toMatchObject({ code: "not-found" });
      const image = { ...assets[0], ref: { engine: "image" as const, objectId: "x", pageIndex: 0 } };
      await expect(render(doc, image)).rejects.toMatchObject({ code: "unsupported-format" });
    });
  });

  it("encuentra la anotacion por su id aunque cambie su posicion en la pagina", async () => {
    const fixture = await makeInkMulti();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      const moved = { ...assets[1], ref: { ...(assets[1].ref as { engine: "annotation"; pageIndex: number; annotationIndex: number; annotationId?: string }), annotationIndex: 0 } };
      const svg = await (await render(doc, moved, "svg")).text();
      expect(svg).toContain("#d91a1a");
    });
  });

  it("cancela con el mismo error que el resto", async () => {
    const fixture = await makeSigWidgets();
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: fixture.bytes });
      const controller = new AbortController();
      controller.abort();
      await expect(renderAnnotationAsset(doc, assets[0], "png", { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, options: { signal: controller.signal } })).rejects.toMatchObject({ code: "cancelled" });
    });
  });
});

describe("integracion con el orquestador", () => {
  it("reutiliza la lista de operadores que ya pidio el orquestador (con anotaciones activas) y no pide otra", async () => {
    const fixture = await makeMixed();
    const ops = await getLegacyOps();
    let calls = 0;
    await withLegacyDocument(fixture.bytes, async (doc) => {
      const spied = spyDocument(doc, { failOperators: () => { calls += 1; return null; } });
      const shared: number[] = [];
      const result = await findAnnotationAssets(spied, {
        ops,
        createSurface: napiSurfaceFactory,
        bytes: fixture.bytes,
        getOperatorList: async (page, pageIndex) => {
          shared.push(pageIndex);
          return (page as unknown as { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }> }).getOperatorList(); // con anotaciones activas
        },
      });
      expect(shared).toEqual([0, 1, 2, 3]);
      expect(calls).toBe(4); // solo las 4 de la funcion del orquestador: el motor no pidio ninguna por su cuenta
      const baseline = await runOn(fixture);
      expect(result.assets.map((a) => a.id)).toEqual(baseline.assets.map((a) => a.id));
    });
  });

  it("ownsAnnotationAsset reparte los elementos: anotacion, capa, texto y sello de Form son de este motor", async () => {
    const corpus = await buildAnnotCorpus();
    const everything = (await Promise.all(corpus.map((fixture) => runOn(fixture)))).flatMap((r) => r.assets);
    expect(everything.length).toBeGreaterThan(20);
    expect(everything.every((asset) => ownsAnnotationAsset(asset))).toBe(true);
    const base = everything[0];
    expect(ownsAnnotationAsset({ ...base, ref: { engine: "image", objectId: "x", pageIndex: 0 }, source: "xobject" })).toBe(false);
    expect(ownsAnnotationAsset({ ...base, ref: { engine: "region", pageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 } }, source: "region" })).toBe(false);
    // La firma vectorial beta usa la misma referencia `vector` con origen `vector`: no es de este motor.
    expect(ownsAnnotationAsset({ ...base, ref: { engine: "vector", pageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 } }, source: "vector" })).toBe(false);
    expect(ownsAnnotationAsset({ ...base, ref: { engine: "vector", pageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 } }, source: "form" })).toBe(true);
  });
});

describe("contrato y privacidad", () => {
  it("cada elemento cumple el contrato de types.ts", async () => {
    for (const fixture of await buildAnnotCorpus()) {
      const { assets } = await runOn(fixture);
      const ids = new Set<string>();
      for (const asset of assets) {
        const label = `${fixture.name}/${asset.id}`;
        expect(asset.id, label).toMatch(/^[a-z-]+-[0-9a-f]{8}$/);
        expect(ids.has(asset.id), `${label} repetido`).toBe(false);
        ids.add(asset.id);
        expect(asset.confidence, label).toBeGreaterThanOrEqual(0);
        expect(asset.confidence, label).toBeLessThanOrEqual(1);
        expect(asset.reasons.length, label).toBeGreaterThan(0);
        expect(asset.reasons.every((r) => typeof r === "string" && r.length > 3), label).toBe(true);
        expect(asset.occurrences.length, label).toBeGreaterThan(0);
        for (const o of asset.occurrences) {
          expect(o.rect.x, label).toBeGreaterThanOrEqual(0);
          expect(o.rect.y, label).toBeGreaterThanOrEqual(0);
          expect(o.rect.x + o.rect.width, label).toBeLessThanOrEqual(1.001);
          expect(o.rect.y + o.rect.height, label).toBeLessThanOrEqual(1.001);
        }
        if (asset.pixel) {
          expect(asset.pixel.width, label).toBeGreaterThan(0);
          expect(asset.pixel.height, label).toBeGreaterThan(0);
        }
        if (asset.formats.length > 0) expect(asset.bytesEstimate, label).toBeGreaterThan(0);
        if (asset.thumb) {
          const thumb = await decodePng(asset.thumb);
          expect(Math.max(thumb.width, thumb.height), label).toBeLessThanOrEqual(EXTRACT_LIMITS.thumbPx);
        }
        // El resultado no guarda pixeles completos: solo miniatura (Blob) y datos pequenos.
        expect(JSON.stringify({ ...asset, thumb: null }).length, label).toBeLessThan(4000);
      }
    }
  });

  it("los identificadores son estables entre ejecuciones", async () => {
    const fixture = await makeMixed();
    const a = (await runOn(fixture)).assets.map((x) => x.id);
    const b = (await runOn(fixture)).assets.map((x) => x.id);
    expect(a).toEqual(b);
  });

  it("no hace ninguna peticion de red", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const beacon = vi.fn();
    const xhr = vi.fn();
    const ws = vi.fn();
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("WebSocket", ws);
    if (typeof navigator !== "undefined") vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    try {
      for (const fixture of await buildAnnotCorpus()) await runOn(fixture);
      const withDoc = await makeSigWidgets();
      await withLegacyDocument(withDoc.bytes, async (doc) => {
        const { assets } = await findAnnotationAssets(doc, { ops: await getLegacyOps(), createSurface: napiSurfaceFactory, bytes: withDoc.bytes });
        await render(doc, assets[0]);
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhr).not.toHaveBeenCalled();
      expect(ws).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      fetchSpy.mockRestore();
    }
  });
});
