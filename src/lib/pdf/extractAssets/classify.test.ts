import { describe, expect, it } from "vitest";
import { DUPLICATE_IOU, classifyAssets, dedupeAssets, geometryOf, iou, sortAssets } from "./classify";
import { line, makeAsset, page, pngBlobOf, vectorCandidate } from "./classify.testUtils";
import { BLACK_PEN, BLUE_PEN, initialsRaster, inkSignatureRaster, logoRaster, photoRaster, stampRaster } from "./__fixtures__/classify/rasters";
import type { ClassifyInput } from "./classifyTypes";
import type { ExtractedAsset } from "./types";

/** Clasificador completo: miniaturas PNG reales + hechos de pagina + candidatas del motor de anotaciones. */

const sizeOf = () => ({ width: 612, height: 792 });

async function signatureAsset(over: Parameters<typeof makeAsset>[0] = {}): Promise<ExtractedAsset> {
  return makeAsset({ thumb: await pngBlobOf(inkSignatureRaster({ seed: 1 })), rect: { x: 0.12, y: 0.82, width: 0.3, height: 0.07 }, reasons: ["transparente"], ...over });
}

const labelPage = (index = 0, text = "Firma del Asegurado:", y = 716) => page(index, [line(text, 72, y, 110, 10)]);

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return { assets: [], pages: [labelPage()], analyzedPages: 1, ...over };
}

describe("geometryOf", () => {
  it("aspecto, altura, area y ancho segun el tamano de pagina (puntos)", () => {
    const g = geometryOf([{ pageIndex: 0, rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.07 } }], sizeOf, 0)!;
    expect(g.aspect).toBeCloseTo((0.3 * 612) / (0.07 * 792), 5);
    expect(g.heightFrac).toBe(0.07);
    expect(g.areaFrac).toBeCloseTo(0.021, 5);
    expect(g.widthFrac).toBe(0.3);
    expect(g.widthPt).toBeCloseTo(183.6, 5);
    expect(g.heightPt).toBeCloseTo(55.44, 5);
    expect(g.pages).toBe(1);
    expect(g.repeatPages).toBe(1);
    expect(g.band).toBeNull();
  });
  it("sin apariciones no hay geometria", () => {
    expect(geometryOf([], sizeOf, 0)).toBeNull();
  });
  it("manda la aparicion MAS GRANDE", () => {
    const g = geometryOf(
      [
        { pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } },
        { pageIndex: 1, rect: { x: 0, y: 0, width: 0.4, height: 0.2 } },
      ],
      sizeOf,
      0,
    )!;
    expect(g.widthFrac).toBe(0.4);
  });
  it("repeticion en el mismo sitio (+-4 %): cuenta paginas distintas; en franja superior o inferior del 20 %", () => {
    const rect = { x: 0.1, y: 0.03, width: 0.2, height: 0.05 };
    const top = geometryOf([0, 1, 2].map((pageIndex) => ({ pageIndex, rect })), sizeOf, 0)!;
    expect(top.repeatPages).toBe(3);
    expect(top.band).toBe("top");
    const bottom = geometryOf([0, 1].map((pageIndex) => ({ pageIndex, rect: { x: 0.1, y: 0.9, width: 0.2, height: 0.05 } })), sizeOf, 0)!;
    expect(bottom.band).toBe("bottom");
    const middle = geometryOf([0, 1].map((pageIndex) => ({ pageIndex, rect: { x: 0.1, y: 0.5, width: 0.2, height: 0.05 } })), sizeOf, 0)!;
    expect(middle.repeatPages).toBe(2);
    expect(middle.band).toBeNull();
    const moved = geometryOf([{ pageIndex: 0, rect }, { pageIndex: 1, rect: { ...rect, x: 0.5 } }], sizeOf, 0)!;
    expect(moved.repeatPages).toBe(1);
    expect(moved.band).toBeNull();
    // Una sola pagina no es repeticion ni cabecera.
    expect(geometryOf([{ pageIndex: 0, rect }], sizeOf, 0)!.band).toBeNull();
  });
  it("la franja es del 20 %: el centro en 0,19 es cabecera, en 0,21 no", () => {
    const at = (y: number) => geometryOf([0, 1].map((pageIndex) => ({ pageIndex, rect: { x: 0.1, y: y - 0.025, width: 0.2, height: 0.05 } })), sizeOf, 0)!.band;
    expect(at(0.19)).toBe("top");
    expect(at(0.21)).toBeNull();
    expect(at(0.81)).toBe("bottom");
    expect(at(0.79)).toBeNull();
  });
  it("firstPageTop: arriba (centro < 20 %) en la primera pagina analizada", () => {
    const rect = { x: 0.1, y: 0.03, width: 0.2, height: 0.05 };
    expect(geometryOf([{ pageIndex: 4, rect }], sizeOf, 4)!.firstPageTop).toBe(true);
    expect(geometryOf([{ pageIndex: 4, rect }], sizeOf, 0)!.firstPageTop).toBe(false);
    expect(geometryOf([{ pageIndex: 0, rect: { ...rect, y: 0.5 } }], sizeOf, 0)!.firstPageTop).toBe(false);
  });
});

describe("iou", () => {
  it("interseccion sobre union", () => {
    expect(iou({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 })).toBe(1);
    expect(iou({ x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 })).toBe(0);
    expect(iou({ x: 0, y: 0, width: 2, height: 1 }, { x: 1, y: 0, width: 2, height: 1 })).toBeCloseTo(1 / 3, 5);
    expect(iou({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 })).toBe(0);
  });
});

describe("classifyAssets · imagenes", () => {
  it("firma de OptimusPDF con la etiqueta cerca: firma probable con motivos y los del motor", async () => {
    const out = await classifyAssets(input({ assets: [await signatureAsset()] }));
    const [asset] = out.assets;
    expect(asset.kind).toBe("signature");
    expect(asset.confidence).toBeGreaterThanOrEqual(0.85);
    expect(asset.confidence).toBeLessThanOrEqual(0.89);
    expect(asset.reasons).toContain("fondo transparente");
    expect(asset.reasons.some((reason) => reason.startsWith("cerca de «Firma"))).toBe(true);
    expect(asset.reasons).not.toContain("transparente"); // ya lo dice «fondo transparente»
    expect(out.vectorSignatures).toEqual([]);
  });

  it("no cambia lo que no decide: id, formatos, miniatura, referencia y apariciones", async () => {
    const original = await signatureAsset();
    const [asset] = (await classifyAssets(input({ assets: [original] }))).assets;
    expect(asset.id).toBe(original.id);
    expect(asset.formats).toBe(original.formats);
    expect(asset.thumb).toBe(original.thumb);
    expect(asset.ref).toBe(original.ref);
    expect(asset.occurrences).toBe(original.occurrences);
    expect(asset.source).toBe("xobject");
  });

  it("sin etiqueta la misma firma queda «posible»; sin miniatura NO se decide (solo geometria)", async () => {
    const [posible] = (await classifyAssets(input({ assets: [await signatureAsset()], pages: [page(0)] }))).assets;
    expect(posible.kind).toBe("signature");
    expect(posible.confidence).toBeLessThan(0.85);
    const [sinMiniatura] = (await classifyAssets(input({ assets: [await signatureAsset({ thumb: null })] }))).assets;
    expect(sinMiniatura.kind).toBe("image");
    expect(sinMiniatura.confidence).toBe(1);
  });

  it("una miniatura que no se puede leer se trata como sin miniatura (sin lanzar)", async () => {
    const [asset] = (await classifyAssets(input({ assets: [await signatureAsset({ thumb: new Blob(["no soy un png"]) })] }))).assets;
    expect(asset.kind).toBe("image");
    const [again] = (await classifyAssets(input({ assets: [await signatureAsset()], decodeThumb: async () => { throw new Error("falla"); } }))).assets;
    expect(again.kind).toBe("image");
  });

  it("iniciales repetidas en el pie con la etiqueta «Iniciales» cerca", async () => {
    const initials = makeAsset({ thumb: await pngBlobOf(initialsRaster({ seed: 2 })), rect: { x: 0.86, y: 0.91, width: 0.09, height: 0.05 }, pages: [0, 1, 2] });
    const pages = [0, 1, 2].map((index) => page(index, [line("Iniciales:", 470, 752, 50, 9)]));
    const [asset] = (await classifyAssets(input({ assets: [initials], pages, analyzedPages: 3 }))).assets;
    expect(asset.kind).toBe("initials");
    expect(asset.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("logo de colores repetido en la cabecera, foto grande opaca y sello circular", async () => {
    const logo = makeAsset({ thumb: await pngBlobOf(logoRaster({ seed: 1 })), rect: { x: 0.09, y: 0.03, width: 0.22, height: 0.05 }, pages: [0, 1, 2, 3], pixel: { width: 220, height: 70, hasAlpha: true } });
    const photo = makeAsset({ thumb: await pngBlobOf(photoRaster({ seed: 1 })), rect: { x: 0.18, y: 0.28, width: 0.49, height: 0.28 }, pages: [1], pixel: { width: 320, height: 240, hasAlpha: false } });
    const stamp = makeAsset({ thumb: await pngBlobOf(stampRaster({})), rect: { x: 0.65, y: 0.68, width: 0.16, height: 0.13 }, pages: [0] });
    const pages = [0, 1, 2, 3].map((index) => page(index));
    const out = await classifyAssets(input({ assets: [logo, photo, stamp], pages, analyzedPages: 4 }));
    expect(out.assets.map((a) => a.kind)).toEqual(["logo", "photo", "stamp"]);
  });

  it("una imagen que cubre la pagina entera sigue siendo imagen; si la pagina esta escaneada lo dice", async () => {
    const full = makeAsset({ thumb: await pngBlobOf(photoRaster({ seed: 9 })), rect: { x: 0, y: 0, width: 1, height: 1 }, pixel: { width: 320, height: 240, hasAlpha: false } });
    const [asset] = (await classifyAssets(input({ assets: [full], pages: [page(0)] }))).assets;
    expect(asset.kind).toBe("image");
    expect(asset.reasons).toEqual([]);
    const [scanned] = (await classifyAssets(input({ assets: [full], pages: [page(0)], scannedPages: [0] }))).assets;
    expect(scanned.kind).toBe("image");
    expect(scanned.reasons).toEqual(["página completa: escaneo del documento"]);
  });

  it("(d) imagen translucida repetida del motor de anotaciones: marca de agua por posicion, aunque sus pixeles sean opacos", async () => {
    const rect = { x: 0.2, y: 0.3, width: 0.6, height: 0.4 };
    const image = makeAsset({ thumb: await pngBlobOf(photoRaster({ seed: 3 })), rect, pages: [0, 1, 2, 3], pixel: { width: 320, height: 240, hasAlpha: false } });
    const translucentImages = [0, 1, 2, 3].map((pageIndex) => ({ pageIndex, rect, alpha: 0.25 }));
    const [asset] = (await classifyAssets(input({ assets: [image], translucentImages, pages: [0, 1, 2, 3].map((i) => page(i)), analyzedPages: 4 }))).assets;
    expect(asset.kind).toBe("watermark");
    expect(asset.confidence).toBe(0.8);
    expect(asset.reasons[0]).toBe("imagen translúcida repetida (opacidad del 25 %)");
    expect(asset.reasons[1]).toBe("en el mismo sitio de 4 páginas");
    // Una candidata en otro sitio no la convierte.
    const [other] = (await classifyAssets(input({ assets: [image], translucentImages: [{ pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, alpha: 0.2 }], pages: [page(0)] }))).assets;
    expect(other.kind).not.toBe("watermark");
  });

  it("elementos que otro motor ya clasifico no se reclasifican: solo ganan la etiqueta cercana si es descargable", async () => {
    const ink = makeAsset({ kind: "signature", confidence: 0.85, source: "ink-annot", ref: { engine: "annotation", pageIndex: 0, annotationIndex: 0 }, rect: { x: 0.12, y: 0.82, width: 0.3, height: 0.07 }, reasons: ["trazos de lápiz"] });
    const [boosted] = (await classifyAssets(input({ assets: [ink] }))).assets;
    expect(boosted.kind).toBe("signature");
    expect(boosted.confidence).toBeGreaterThan(0.85);
    expect(boosted.confidence).toBeLessThanOrEqual(0.97);
    expect(boosted.reasons).toEqual(["trazos de lápiz", expect.stringContaining("cerca de «Firma")]);
    // Un campo /Sig vacio (formats []) se queda como esta.
    const empty = makeAsset({ kind: "signature", confidence: 0.1, source: "sig-widget", formats: [], ref: { engine: "annotation", pageIndex: 0, annotationIndex: 0 }, rect: { x: 0.12, y: 0.82, width: 0.3, height: 0.07 } });
    const [same] = (await classifyAssets(input({ assets: [empty] }))).assets;
    expect(same).toBe(empty);
    // Un sello (stamp) o una marca de agua tampoco cambian.
    const wm = makeAsset({ kind: "watermark", confidence: 0.9, source: "ocg" });
    expect((await classifyAssets(input({ assets: [wm] }))).assets[0]).toBe(wm);
    // Ya trae el motivo: no se repite.
    const withReason = makeAsset({ kind: "signature", confidence: 0.85, source: "ink-annot", rect: { x: 0.12, y: 0.82, width: 0.3, height: 0.07 }, reasons: ["cerca de «Firma del Asegurado»"] });
    expect((await classifyAssets(input({ assets: [withReason] }))).assets[0]).toBe(withReason);
  });

  it("un elemento sin apariciones queda como esta", async () => {
    const orphan = makeAsset({ thumb: await pngBlobOf(inkSignatureRaster({ seed: 1 })) });
    orphan.occurrences = [];
    expect((await classifyAssets(input({ assets: [orphan] }))).assets[0]).toBe(orphan);
  });

  it("cancelar a mitad rechaza con AbortError (sin parciales)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(classifyAssets(input({ assets: [await signatureAsset()], signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("vacio y sin hechos: no lanza", async () => {
    expect(await classifyAssets({ assets: [], pages: [], analyzedPages: 0 })).toEqual({ assets: [], vectorSignatures: [] });
    const [asset] = (await classifyAssets({ assets: [await signatureAsset()], pages: [], analyzedPages: 0 })).assets;
    expect(asset.kind).toBe("signature"); // sin hechos usa carta
  });

  it("en un documento de 1 sola pagina un logo arriba de la pagina 1 es logo posible", async () => {
    const logo = makeAsset({ thumb: await pngBlobOf(logoRaster({ seed: 1 })), rect: { x: 0.09, y: 0.03, width: 0.2, height: 0.05 }, pixel: { width: 220, height: 70, hasAlpha: true } });
    const [asset] = (await classifyAssets(input({ assets: [logo], pages: [page(0)] }))).assets;
    expect(asset.kind).toBe("logo");
    expect(asset.confidence).toBeLessThanOrEqual(0.8);
  });

  it("iniciales negras gruesas SIN etiqueta repetidas en el pie son un logo de poca certeza (limite conocido)", async () => {
    const thick = makeAsset({ thumb: await pngBlobOf(initialsRaster({ seed: 3, size: 120, ink: BLACK_PEN, thickness: 6 })), rect: { x: 0.86, y: 0.91, width: 0.08, height: 0.04 }, pages: [0, 1, 2] });
    const [asset] = (await classifyAssets(input({ assets: [thick], pages: [0, 1, 2].map((i) => page(i)), analyzedPages: 3 }))).assets;
    expect(asset.kind).toBe("logo");
    expect(asset.confidence).toBeLessThanOrEqual(0.7);
    expect(asset.reasons.join(" ")).toContain("iniciales");
  });

  it("una firma de mas del 8 % de la altura es una imagen (limite conocido del plan: 1-8 %)", async () => {
    const big = await signatureAsset({ rect: { x: 0.12, y: 0.7, width: 0.4, height: 0.12 } });
    expect((await classifyAssets(input({ assets: [big] }))).assets[0].kind).toBe("image");
  });

  it("firma azul sobre papel gris con la etiqueta (escaneo opaco)", async () => {
    const scan = makeAsset({ thumb: await pngBlobOf(inkSignatureRaster({ seed: 6, ink: BLUE_PEN, background: "paper", noise: 20, paper: 238 })), rect: { x: 0.12, y: 0.82, width: 0.29, height: 0.07 }, pixel: { width: 300, height: 90, hasAlpha: false } });
    expect((await classifyAssets(input({ assets: [scan] }))).assets[0].kind).toBe("signature");
  });
});

describe("classifyAssets · vectores", () => {
  it("acepta las candidatas con etiqueta cerca y devuelve la decision (sin pixeles)", async () => {
    const candidate = vectorCandidate({ bbox: { x: 150, y: 660, width: 140, height: 40 } });
    const out = await classifyAssets(input({ vectors: [{ pageIndex: 0, candidates: [candidate], lines: [] }] }));
    expect(out.vectorSignatures).toHaveLength(1);
    expect(out.vectorSignatures[0].kind).toBe("signature");
    expect(out.vectorSignatures[0].candidate).toBe(candidate);
    expect(out.assets).toEqual([]);
  });
  it("una candidata sin senal externa no se devuelve", async () => {
    const out = await classifyAssets(input({ pages: [page(0)], vectors: [{ pageIndex: 0, candidates: [vectorCandidate()], lines: [] }] }));
    expect(out.vectorSignatures).toEqual([]);
  });
});

describe("sortAssets", () => {
  const mk = (kind: ExtractedAsset["kind"], confidence: number, pageIndex: number, y = 0.5, x = 0.1, id = `${kind}-${confidence}-${pageIndex}`) =>
    makeAsset({ kind, confidence, id, pages: [pageIndex], rect: { x, y, width: 0.1, height: 0.05 } });
  it("firmas e iniciales juntas por confianza, luego sellos, logos, marcas de agua y el resto", () => {
    const sorted = sortAssets([mk("image", 1, 0), mk("watermark", 0.9, 0), mk("logo", 0.93, 0), mk("stamp", 0.7, 0), mk("initials", 0.89, 2), mk("signature", 0.88, 1), mk("photo", 0.8, 0), mk("signature", 0.7, 0), mk("drawing", 0.8, 0)]);
    expect(sorted.map((a) => `${a.kind}:${a.confidence}`)).toEqual([
      "initials:0.89",
      "signature:0.88",
      "signature:0.7",
      "stamp:0.7",
      "logo:0.93",
      "watermark:0.9",
      "drawing:0.8", // dibujos y fotos comparten grupo; a igual confianza y sitio decide el id
      "photo:0.8",
      "image:1",
    ]);
  });
  it("a igual tipo y confianza: pagina, luego de arriba abajo y de izquierda a derecha, luego id", () => {
    const sorted = sortAssets([mk("image", 1, 1, 0.1, 0.1, "b"), mk("image", 1, 0, 0.9, 0.1, "c"), mk("image", 1, 0, 0.2, 0.5, "d"), mk("image", 1, 0, 0.2, 0.1, "a"), mk("image", 1, 0, 0.2, 0.1, "0")]);
    expect(sorted.map((a) => a.id)).toEqual(["0", "a", "d", "c", "b"]);
  });
  it("no modifica la lista original y los sin apariciones van al final de su grupo", () => {
    const orphan = makeAsset({ id: "orphan" });
    orphan.occurrences = [];
    const list = [orphan, mk("image", 1, 0, 0.1, 0.1, "x")];
    const sorted = sortAssets(list);
    expect(sorted.map((a) => a.id)).toEqual(["x", "orphan"]);
    expect(list[0].id).toBe("orphan");
  });
});

describe("dedupeAssets", () => {
  const rect = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 };
  it("la misma pieza vista por dos motores (IoU >= 0,6): gana la mas especifica y se unen las apariciones", () => {
    const image = makeAsset({ id: "img-1", kind: "image", rect, pages: [0] });
    const stamp = makeAsset({ id: "stamp-1", kind: "stamp", confidence: 0.9, rect: { ...rect, x: 0.11 }, pages: [0, 2] });
    const out = dedupeAssets([image, stamp]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("stamp-1");
    expect(out[0].occurrences.map((o) => o.pageIndex).sort()).toEqual([0, 2]);
    expect(dedupeAssets([stamp, image])[0].id).toBe("stamp-1");
  });
  it("a igual especificidad gana la de mayor confianza", () => {
    const a = makeAsset({ id: "a", kind: "signature", confidence: 0.7, rect });
    const b = makeAsset({ id: "b", kind: "signature", confidence: 0.88, rect });
    expect(dedupeAssets([a, b]).map((x) => x.id)).toEqual(["b"]);
    expect(dedupeAssets([b, a]).map((x) => x.id)).toEqual(["b"]);
  });
  it("cajas distintas, paginas distintas o IoU < 0,6 no se fusionan", () => {
    const a = makeAsset({ id: "a", rect });
    expect(dedupeAssets([a, makeAsset({ id: "b", rect: { ...rect, x: 0.9 } })])).toHaveLength(2);
    expect(dedupeAssets([a, makeAsset({ id: "c", rect, pages: [1] })])).toHaveLength(2);
    // IoU justo por debajo del umbral.
    const shifted = { ...rect, x: rect.x + rect.width * 0.5 }; // IoU = 1/3
    expect(iou(rect, shifted)).toBeLessThan(DUPLICATE_IOU);
    expect(dedupeAssets([a, makeAsset({ id: "d", rect: shifted })])).toHaveLength(2);
    expect(DUPLICATE_IOU).toBe(0.6);
  });
  it("el mismo id no se fusiona consigo mismo y los elementos sin apariciones pasan", () => {
    const a = makeAsset({ id: "a", rect });
    expect(dedupeAssets([a, a])).toHaveLength(2);
    const orphan = makeAsset({ id: "o" });
    orphan.occurrences = [];
    expect(dedupeAssets([orphan, a])).toHaveLength(2);
  });
});
