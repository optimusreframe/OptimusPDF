import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_FILE_SIZE, PdfError } from "@/lib/pdf/core";
import { buildAnnotCorpus, type AnnotFixture } from "./__fixtures__/annots/generate";
import { spyDocument } from "./__fixtures__/annots/testKit";
import { decodePng } from "./__fixtures__/annots/nodeEnv";
import { buildImagesCorpus } from "./__fixtures__/images/corpus";
import { makeLogoHeaderFooter, makeOptimusOneSigner, makeOptimusTwoSigners, makeScannedPage, makeVectorSignatures } from "./__fixtures__/classify/generate";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";
import { sortAssets } from "./classify";
import { DOCUMENT_IDLE_MS, ExtractRenderError, extractWith, looksEncrypted, mergeWarnings, releaseRenderDocument, renderWith, type ExtractEnv } from "./orchestrate";
import type { ExtractOptions, ExtractedAsset } from "./types";

/**
 * Orquestador real contra el CONTRATO de integracion de la interfaz (U7.4): pageCount total, pageIndex 0-based, pageRange 0-based
 * inclusivo, errores como PdfError por nombre y codigo, cancelacion sin parciales, topes con avisos y `truncated`, formats[0] por
 * defecto, PNG con alfa. Todo en Node con pdf.js «legacy» y canvas de @napi-rs/canvas.
 */

const run = (bytes: Uint8Array, options: ExtractOptions = {}, env: ExtractEnv = nodeExtractEnv) => extractWith(env, bytes, options);

let optimus1: Uint8Array;
let logos: Uint8Array;
let annots: AnnotFixture[];

beforeAll(async () => {
  optimus1 = (await makeOptimusOneSigner()).bytes;
  logos = (await makeLogoHeaderFooter()).bytes;
  annots = await buildAnnotCorpus();
});

afterEach(async () => {
  await releaseRenderDocument();
  vi.useRealTimers();
});

const annot = (name: string): Uint8Array => annots.find((item) => item.name === name)!.bytes;
const pagesOf = (assets: ExtractedAsset[]): number[] => [...new Set(assets.flatMap((asset) => asset.occurrences.map((o) => o.pageIndex)))].sort((a, b) => a - b);

async function expectPdfError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("PdfError");
  expect((error as PdfError).code).toBe(code);
}

describe("contrato · paginas, rango y progreso", () => {
  it("pageCount son las paginas TOTALES aunque se pida un rango", async () => {
    const all = await run(optimus1);
    expect(all.pageCount).toBe(3);
    const range = await run(optimus1, { pageRange: { from: 2, to: 2 } });
    expect(range.pageCount).toBe(3);
    expect(pagesOf(range.assets)).toEqual([2]);
    // Con el rango solo salen las apariciones de esa pagina: las iniciales ya no estan en 0 y 1.
    expect(range.assets.map((asset) => asset.kind).sort()).toEqual(["initials", "signature"]);
  });

  it("pageRange es 0-based e inclusivo y se recorta al documento", async () => {
    expect(pagesOf((await run(optimus1, { pageRange: { from: 0, to: 0 } })).assets)).toEqual([0]);
    expect(pagesOf((await run(optimus1, { pageRange: { from: 1, to: 2 } })).assets)).toEqual([1, 2]);
    expect(pagesOf((await run(optimus1, { pageRange: { from: 1, to: 99 } })).assets)).toEqual([1, 2]);
    expect(pagesOf((await run(optimus1, { pageRange: { from: -5, to: 0 } })).assets)).toEqual([0]);
    // Un rango invertido se reduce a la pagina de inicio.
    expect(pagesOf((await run(optimus1, { pageRange: { from: 2, to: 0 } })).assets)).toEqual([2]);
  });

  it("onProgress: pageIndex 0-based dentro del rango, siempre en aumento y termina en la ultima pagina con el total", async () => {
    const events: Array<{ pageIndex: number; pageCount: number; assetsSoFar: number }> = [];
    const result = await run(logos, { onProgress: (progress) => events.push(progress) });
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events[0].pageIndex).toBe(0);
    for (let i = 0; i < events.length; i += 1) {
      expect(events[i].pageCount).toBe(5);
      expect(events[i].pageIndex).toBeGreaterThanOrEqual(0);
      expect(events[i].pageIndex).toBeLessThanOrEqual(4);
      if (i > 0) {
        expect(events[i].pageIndex).toBeGreaterThanOrEqual(events[i - 1].pageIndex);
        expect(events[i].assetsSoFar).toBeGreaterThanOrEqual(events[i - 1].assetsSoFar);
      }
    }
    const last = events[events.length - 1];
    expect(last.pageIndex).toBe(4);
    expect(last.assetsSoFar).toBe(result.assets.length);
  });

  it("con un rango el progreso se queda dentro de el", async () => {
    const events: number[] = [];
    await run(logos, { pageRange: { from: 2, to: 3 }, onProgress: (progress) => events.push(progress.pageIndex) });
    expect(Math.min(...events)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...events)).toBe(3);
    expect(events[events.length - 1]).toBe(3);
  });

  it("un documento de una pagina informa de la pagina 0", async () => {
    const scanned = (await makeScannedPage()).bytes;
    const events: number[] = [];
    await run(scanned, { onProgress: (progress) => events.push(progress.pageIndex) });
    expect(new Set(events)).toEqual(new Set([0]));
  });
});

describe("contrato · cancelacion", () => {
  it("ya cancelada: rechaza con PdfError «cancelled» sin abrir el documento", async () => {
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn(nodeExtractEnv.openDocument);
    await expectPdfError(run(optimus1, { signal: controller.signal }, { ...nodeExtractEnv, openDocument: open }), "cancelled");
    expect(open).not.toHaveBeenCalled();
  });

  it("cancelar a mitad (desde onProgress) rechaza con PdfError «cancelled» y no devuelve parciales", async () => {
    const controller = new AbortController();
    let after = 0;
    const promise = run(logos, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (controller.signal.aborted) after += 1;
        if (progress.pageIndex >= 1) controller.abort();
      },
    });
    await expectPdfError(promise, "cancelled");
    expect(after).toBeLessThan(10);
  });

  it("cancelar en cada etapa (imagenes, anotaciones, texto y trazos, clasificacion) cierra el documento", async () => {
    const closed: number[] = [];
    const env: ExtractEnv = { ...nodeExtractEnv, closeDocument: async (doc) => { closed.push(1); await nodeExtractEnv.closeDocument(doc); } };
    for (let threshold = 0; threshold < 9; threshold += 3) {
      const controller = new AbortController();
      let calls = 0;
      await expectPdfError(run(logos, { signal: controller.signal, onProgress: () => { calls += 1; if (calls > threshold) controller.abort(); } }, env), "cancelled");
    }
    expect(closed).toHaveLength(3);
  });
});

describe("contrato · topes", () => {
  it("maxPages: analiza las primeras N, avisa una sola vez con too-many-pages y marca truncated", async () => {
    const result = await run(logos, { maxPages: 2 });
    expect(result.pageCount).toBe(5);
    expect(Math.max(...pagesOf(result.assets))).toBe(1);
    expect(result.warnings.filter((w) => w.code === "too-many-pages")).toHaveLength(1);
    expect(result.truncated).toBe(true);
    const full = await run(logos);
    expect(full.truncated).toBe(false);
    expect(full.warnings.some((w) => w.code === "too-many-pages")).toBe(false);
  });

  it("maxPages se cuenta desde el inicio del rango", async () => {
    const result = await run(logos, { pageRange: { from: 1, to: 4 }, maxPages: 2 });
    expect(pagesOf(result.assets)).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
    const huge = await run(logos, { maxPages: 100_000 });
    expect(huge.truncated).toBe(false);
  });

  it("el tope de 300 paginas es DURO: pedir mas no lo sube", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < 305; i += 1) doc.addPage([100, 100]);
    const events: number[] = [];
    const result = await run(await doc.save({ useObjectStreams: true }), { maxPages: 1000, onProgress: (progress) => events.push(progress.pageIndex) });
    expect(result.pageCount).toBe(305);
    expect(result.warnings.filter((w) => w.code === "too-many-pages")).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(Math.max(...events)).toBe(299);
    // Y con un rango desde la 100 entran 300 paginas (hasta la 399), recortadas al final del documento.
    const tail = await run(await doc.save({ useObjectStreams: true }), { pageRange: { from: 100, to: 304 }, maxPages: 1000 });
    expect(tail.truncated).toBe(false);
  }, 120_000);

  it("un rango invertido se reduce a la pagina de inicio y el progreso sigue siendo valido", async () => {
    const events: number[] = [];
    await run(optimus1, { pageRange: { from: 2, to: 0 }, onProgress: (progress) => events.push(progress.pageIndex) });
    expect(events.length).toBeGreaterThan(0);
    for (const pageIndex of events) expect(pageIndex).toBe(2);
  });

  it("maxAssets: se queda en N, avisa too-many-assets y marca truncated", async () => {
    const mosaic = (await buildImagesCorpus()).find((entry) => entry.name === "mosaic-200")!;
    const result = await run(mosaic.bytes, { maxAssets: 50 });
    expect(result.assets).toHaveLength(50);
    expect(result.warnings.filter((w) => w.code === "too-many-assets")).toHaveLength(1);
    expect(result.truncated).toBe(true);
    const all = await run(mosaic.bytes);
    expect(all.assets).toHaveLength(200);
    expect(all.truncated).toBe(false);
  });

  it("ids unicos y orden estable aunque se recorte", async () => {
    const mosaic = (await buildImagesCorpus()).find((entry) => entry.name === "mosaic-200")!;
    const result = await run(mosaic.bytes, { maxAssets: 120 });
    expect(new Set(result.assets.map((a) => a.id)).size).toBe(120);
  });
});

describe("contrato · errores como PdfError (por nombre y codigo)", () => {
  it("vacio -> empty; muy grande -> tooLarge; basura -> corrupt", async () => {
    await expectPdfError(run(new Uint8Array(0)), "empty");
    await expectPdfError(run(new Uint8Array(MAX_SAFE_FILE_SIZE + 1)), "tooLarge");
    await expectPdfError(run(new TextEncoder().encode("esto no es un pdf, ni de lejos, solo texto cualquiera")), "corrupt");
    await expectPdfError(run(optimus1.subarray(0, 300)), "corrupt");
  });

  it("cifrado con contrasena -> encrypted (y el documento se cierra)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("secreto", { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    await doc.encrypt({ userPassword: "abc", ownerPassword: "own" });
    await expectPdfError(run(await doc.save()), "encrypted");
  });

  it("cifrado SOLO con restricciones (contrasena de propietario): se abre, se extrae y avisa «encrypted»", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("abierto", { x: 10, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    await doc.encrypt({ userPassword: "", ownerPassword: "own", permissions: { printing: false } });
    const result = await run(await doc.save());
    expect(result.pageCount).toBe(1);
    expect(result.warnings.some((w) => w.code === "encrypted")).toBe(true);
    expect((await run(optimus1)).warnings.some((w) => w.code === "encrypted")).toBe(false);
  });

  it("un documento que abre pero cuyas paginas NO se pueden leer -> corrupt, no un resultado vacio", async () => {
    const env: ExtractEnv = { ...nodeExtractEnv, openDocument: async (bytes) => spyDocument((await nodeExtractEnv.openDocument(bytes)) as never, { failPage: () => new Error("pagina rota") }) as never };
    await expectPdfError(run(optimus1, {}, env), "corrupt");
  });

  it("si solo falla UNA pagina se avisa de ella y se sigue", async () => {
    const env: ExtractEnv = { ...nodeExtractEnv, openDocument: async (bytes) => spyDocument((await nodeExtractEnv.openDocument(bytes)) as never, { failPage: (n) => (n === 1 ? new Error("pagina rota") : null) }) as never };
    const result = await run(optimus1, {}, env);
    expect(result.warnings.some((w) => w.code === "decode-failed" && w.pageIndex === 0)).toBe(true);
    expect(result.assets.length).toBeGreaterThan(0);
  });

  it("el documento se cierra siempre (con exito, error y cancelacion) y no se abre dos veces", async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const env: ExtractEnv = {
      ...nodeExtractEnv,
      openDocument: async (bytes) => (opened.push(1), nodeExtractEnv.openDocument(bytes)),
      closeDocument: async (doc) => (closed.push(1), nodeExtractEnv.closeDocument(doc)),
    };
    await run(optimus1, {}, env);
    expect([opened.length, closed.length]).toEqual([1, 1]);
    const controller = new AbortController();
    controller.abort();
    await run(optimus1, { signal: controller.signal }, env).catch(() => undefined);
    expect(opened.length).toBe(1); // cancelada antes de abrir
  });

  it("page.cleanup() de cada pagina en cada pasada", async () => {
    const cleaned: number[] = [];
    const env: ExtractEnv = { ...nodeExtractEnv, openDocument: async (bytes) => spyDocument((await nodeExtractEnv.openDocument(bytes)) as never, { cleaned }) as never };
    await run(optimus1, {}, env);
    expect(new Set(cleaned)).toEqual(new Set([1, 2, 3]));
    expect(cleaned.length).toBeGreaterThanOrEqual(9);
  });

  it("acepta un File ademas de bytes", async () => {
    const file = new File([optimus1 as unknown as BlobPart], "contrato.pdf", { type: "application/pdf" });
    expect((await extractWith(nodeExtractEnv, file)).assets.length).toBeGreaterThan(0);
  });
});

describe("integracion de motores", () => {
  it("firmas e iniciales primero (por confianza), luego logos; ordenado como sortAssets", async () => {
    const result = await run(logos);
    const kinds = result.assets.map((asset) => asset.kind);
    expect(kinds[0]).toBe("signature");
    expect(kinds.filter((kind) => kind === "logo")).toHaveLength(2);
    expect(kinds.indexOf("logo")).toBeGreaterThan(kinds.indexOf("signature"));
    expect(result.assets).toEqual(sortAssets(result.assets));
    expect(new Set(result.assets.map((a) => a.id)).size).toBe(result.assets.length);
  });

  it("pagina escaneada: scannedPages, aviso y la imagen entera sigue siendo una imagen", async () => {
    const result = await run((await makeScannedPage()).bytes);
    expect(result.scannedPages).toEqual([0]);
    expect(result.warnings).toContainEqual({ code: "scanned-page", pageIndex: 0 });
    expect(result.assets.map((a) => a.kind)).toEqual(["image"]);
  });

  it("une las anotaciones (Ink, /Sig, sello) con las imagenes del mismo documento", async () => {
    const mixed = await run(annot("mixed"));
    const sources = new Set(mixed.assets.map((a) => a.source));
    expect(sources.has("ink-annot")).toBe(true);
    expect(sources.has("stamp-annot")).toBe(true);
    expect(sources.has("sig-widget")).toBe(true);
  });

  it("(d) imagen translucida repetida: el clasificador la convierte en marca de agua con el motivo", async () => {
    const result = await run(annot("translucent-image-6"));
    const watermark = result.assets.find((asset) => asset.kind === "watermark");
    expect(watermark).toBeDefined();
    expect(watermark?.source).toBe("xobject");
    expect(watermark?.reasons[0]).toContain("translúcida");
  });

  it("un campo /Sig vacio sale con formats [] (sin descarga) y renderAsset lo rechaza con un codigo claro", async () => {
    const result = await run(annot("sig-widgets"));
    const empty = result.assets.find((asset) => asset.source === "sig-widget" && asset.formats.length === 0);
    expect(empty).toBeDefined();
    await expect(renderWith(nodeExtractEnv, annot("sig-widgets"), empty!)).rejects.toMatchObject({ name: "ExtractRenderError", code: "no-formats" });
  });

  it("avisa de firma digital (/V) y la pasa tal cual", async () => {
    const result = await run(annot("sig-widgets"));
    expect(result.warnings.some((w) => w.code === "digital-signature")).toBe(true);
  });

  it("no hace ninguna peticion de red", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("red prohibida")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await run(logos);
      await run(annot("mixed"));
      await run((await makeVectorSignatures()).bytes);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recall del 100 % de las imagenes incrustadas del corpus de imagenes tras la fusion de motores", async () => {
    for (const entry of await buildImagesCorpus()) {
      const result = await run(entry.bytes);
      expect(result.pageCount, entry.name).toBe(entry.truth.pageCount);
      expect(result.scannedPages, entry.name).toEqual(entry.truth.scannedPages);
      for (const code of entry.truth.warnings) expect(result.warnings.map((w) => w.code), entry.name).toContain(code);
      if (entry.truth.warnings.length > 0) continue;
      for (const image of entry.truth.images) {
        for (const occurrence of image.occurrences) {
          const found = result.assets.some((asset) =>
            asset.occurrences.some((o) => {
              const x0 = Math.max(o.rect.x, occurrence.rect.x);
              const y0 = Math.max(o.rect.y, occurrence.rect.y);
              const x1 = Math.min(o.rect.x + o.rect.width, occurrence.rect.x + occurrence.rect.width);
              const y1 = Math.min(o.rect.y + o.rect.height, occurrence.rect.y + occurrence.rect.height);
              const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
              const union = o.rect.width * o.rect.height + occurrence.rect.width * occurrence.rect.height - inter;
              return o.pageIndex === occurrence.pageIndex && union > 0 && inter / union >= 0.5;
            }),
          );
          expect(found, `${entry.name}: ${image.id} en la pagina ${occurrence.pageIndex}`).toBe(true);
        }
      }
    }
  });
});

describe("renderAsset · por referencia del motor", () => {
  it("imagen: formats[0] es el formato por defecto y el PNG trae alfa (fondo transparente real)", async () => {
    const result = await run(optimus1);
    const signature = result.assets.find((asset) => asset.kind === "signature")!;
    expect(signature.formats[0]).toBe("png");
    const blob = await renderWith(nodeExtractEnv, optimus1, signature);
    expect(blob.type).toBe("image/png");
    const raster = await decodePng(blob);
    let transparent = 0;
    let opaque = 0;
    for (let i = 3; i < raster.data.length; i += 4) {
      if (raster.data[i] === 0) transparent += 1;
      if (raster.data[i] === 255) opaque += 1;
    }
    expect(transparent / (raster.width * raster.height)).toBeGreaterThan(0.5);
    expect(opaque).toBeGreaterThan(50);
    const explicit = await renderWith(nodeExtractEnv, optimus1, signature, "png");
    expect(explicit.size).toBe(blob.size);
  });

  it("JPEG original: los bytes del PDF tal cual", async () => {
    const jpeg = (await buildImagesCorpus()).find((entry) => entry.name === "jpeg")!;
    const result = await run(jpeg.bytes);
    const asset = result.assets.find((a) => a.formats.includes("jpg-original"))!;
    const blob = await renderWith(nodeExtractEnv, jpeg.bytes, asset, "jpg-original");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("anotaciones, capas y marcas de texto se reparten al motor de anotaciones", async () => {
    const ink = (await run(annot("ink-multi"))).assets.find((a) => a.source === "ink-annot")!;
    expect((await renderWith(nodeExtractEnv, annot("ink-multi"), ink, "svg")).type).toContain("svg");
    expect((await renderWith(nodeExtractEnv, annot("ink-multi"), ink)).type).toBe("image/png");
    const ocg = (await run(annot("ocg-watermark"))).assets.find((a) => a.source === "ocg")!;
    expect((await renderWith(nodeExtractEnv, annot("ocg-watermark"), ocg)).type).toBe("image/png");
    const text = (await run(annot("text-watermark-6"))).assets.find((a) => a.source === "text")!;
    expect(await (await renderWith(nodeExtractEnv, annot("text-watermark-6"), text, "txt")).text()).toContain("\n");
    const form = (await run(annot("form-stamps"))).assets.find((a) => a.source === "form")!;
    expect((await renderWith(nodeExtractEnv, annot("form-stamps"), form)).type).toBe("image/png");
  });

  it("una firma vectorial beta se regenera con su propio dibujo (png y svg)", async () => {
    const fixture = (await makeVectorSignatures()).bytes;
    const vector = (await run(fixture)).assets.find((a) => a.source === "vector")!;
    expect((await renderWith(nodeExtractEnv, fixture, vector)).type).toBe("image/png");
    expect(await (await renderWith(nodeExtractEnv, fixture, vector, "svg")).text()).toContain("<path");
  });

  it("un recorte de region se delega en cropRegion (png)", async () => {
    const crop = vi.fn(async () => ({ png: new Blob(["png-de-prueba"], { type: "image/png" }), width: 10, height: 5 }));
    const asset: ExtractedAsset = {
      id: "region-1", kind: "signature", confidence: 1, reasons: [], source: "region", occurrences: [], pixel: { width: 10, height: 5, hasAlpha: true }, formats: ["png"], bytesEstimate: 10, thumb: null,
      ref: { engine: "region", pageIndex: 2, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
    };
    const blob = await renderWith({ ...nodeExtractEnv, cropRegion: crop }, optimus1, asset);
    expect(await blob.text()).toBe("png-de-prueba");
    expect(crop).toHaveBeenCalledWith(optimus1, 2, { x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
    await expect(renderWith({ ...nodeExtractEnv, cropRegion: crop }, optimus1, { ...asset, formats: ["png", "svg"] }, "svg")).rejects.toMatchObject({ code: "unsupported-format" });
  });

  it("errores con codigo: sin formatos, formato no ofrecido, referencia sin motor", async () => {
    const signature = (await run(optimus1)).assets.find((asset) => asset.kind === "signature")!;
    await expect(renderWith(nodeExtractEnv, optimus1, { ...signature, formats: [] })).rejects.toBeInstanceOf(ExtractRenderError);
    await expect(renderWith(nodeExtractEnv, optimus1, signature, "svg")).rejects.toMatchObject({ code: "unsupported-format" });
    await expect(renderWith(nodeExtractEnv, optimus1, { ...signature, ref: { engine: "zzz" } as never })).rejects.toMatchObject({ code: "unsupported-asset" });
  });
});

describe("renderAsset · el documento abierto se reutiliza", () => {
  it("varias descargas seguidas del mismo archivo abren UNA vez; otro archivo cierra el anterior; releaseRenderDocument lo cierra", async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const env: ExtractEnv = {
      ...nodeExtractEnv,
      openDocument: async (bytes) => (opened.push(1), nodeExtractEnv.openDocument(bytes)),
      closeDocument: async (doc) => (closed.push(1), nodeExtractEnv.closeDocument(doc)),
    };
    const result = await run(optimus1);
    for (const asset of result.assets) await renderWith(env, optimus1, asset);
    await renderWith(env, optimus1, result.assets[0]);
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(0);
    const other = (await makeOptimusTwoSigners()).bytes;
    const second = (await run(other)).assets[0];
    await renderWith(env, other, second);
    expect(opened).toHaveLength(2);
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    await releaseRenderDocument();
    expect(closed).toHaveLength(2);
    await releaseRenderDocument();
    expect(closed).toHaveLength(2);
  });

  it("se cierra solo tras el tiempo de espera sin descargas", async () => {
    vi.useFakeTimers();
    const closed: number[] = [];
    const env: ExtractEnv = { ...nodeExtractEnv, closeDocument: async (doc) => (closed.push(1), nodeExtractEnv.closeDocument(doc)) };
    const result = await run(optimus1);
    await renderWith(env, optimus1, result.assets[0]);
    expect(closed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DOCUMENT_IDLE_MS - 1);
    expect(closed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(closed).toHaveLength(1);
    expect(DOCUMENT_IDLE_MS).toBe(15_000);
  });

  it("descargas simultaneas del mismo archivo comparten el documento y no lo cierran a medias", async () => {
    let closed = 0;
    const env: ExtractEnv = { ...nodeExtractEnv, closeDocument: async (doc) => (closed += 1, nodeExtractEnv.closeDocument(doc)) };
    const result = await run(optimus1);
    const blobs = await Promise.all(result.assets.map((asset) => renderWith(env, optimus1, asset)));
    expect(blobs.every((blob) => blob.size > 100)).toBe(true);
    expect(closed).toBe(0);
  });

  it("un archivo que no se puede abrir falla con PdfError y no deja un documento colgado", async () => {
    const env: ExtractEnv = { ...nodeExtractEnv };
    const asset = (await run(optimus1)).assets[0];
    await expectPdfError(renderWith(env, new TextEncoder().encode("basura que no es pdf"), asset), "corrupt");
    // Y el siguiente intento con un archivo bueno funciona.
    expect((await renderWith(env, optimus1, asset)).size).toBeGreaterThan(100);
  });
});

describe("funciones auxiliares", () => {
  it("looksEncrypted mira la cabecera (32 KB) y el final (64 KB), no el medio", () => {
    const needle = new TextEncoder().encode("/Encrypt");
    const make = (size: number, at: number | null): Uint8Array => {
      const bytes = new Uint8Array(size).fill(65);
      if (at !== null) bytes.set(needle, at);
      return bytes;
    };
    expect(looksEncrypted(make(500_000, null))).toBe(false);
    expect(looksEncrypted(make(500_000, 100))).toBe(true);
    expect(looksEncrypted(make(500_000, 32 * 1024 - 8))).toBe(true);
    expect(looksEncrypted(make(500_000, 32 * 1024 + 100))).toBe(false);
    expect(looksEncrypted(make(500_000, 500_000 - 64 * 1024 + 10))).toBe(true);
    expect(looksEncrypted(make(500_000, 500_000 - 64 * 1024 - 100))).toBe(false);
    expect(looksEncrypted(make(500_000, 500_000 - 8))).toBe(true);
    expect(looksEncrypted(new Uint8Array(0))).toBe(false);
    expect(looksEncrypted(new TextEncoder().encode("/Encryp"))).toBe(false);
    expect(looksEncrypted(new TextEncoder().encode("/Encrypx /Encrypt"))).toBe(true);
  });

  it("mergeWarnings: sin repetir (codigo + pagina + detalle); los topes una sola vez", () => {
    const merged = mergeWarnings([
      [{ code: "scanned-page", pageIndex: 1 }, { code: "too-many-pages", detail: "300" }],
      [{ code: "scanned-page", pageIndex: 1 }, { code: "scanned-page", pageIndex: 2 }, { code: "too-many-pages", detail: "se analizaron 300" }, { code: "decode-failed", pageIndex: 1, detail: "a" }, { code: "decode-failed", pageIndex: 1, detail: "b" }],
      [{ code: "too-many-assets", pageIndex: 2 }, { code: "too-many-assets" }],
    ]);
    expect(merged).toEqual([
      { code: "scanned-page", pageIndex: 1 },
      { code: "too-many-pages", detail: "300" },
      { code: "scanned-page", pageIndex: 2 },
      { code: "decode-failed", pageIndex: 1, detail: "a" },
      { code: "decode-failed", pageIndex: 1, detail: "b" },
      { code: "too-many-assets", pageIndex: 2 },
    ]);
  });
});
