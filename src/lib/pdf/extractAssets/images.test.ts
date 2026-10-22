import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { ExtractedAsset } from "./types";
import { buildImagesCorpus, type CorpusEntry } from "./__fixtures__/images/corpus";
import { evaluateImages } from "./__fixtures__/images/metrics";
import { ImageAssetError, findImageAssets, formatsFor, renderImageAsset } from "./images";
import { blobBytes, decodePng, openLegacy } from "./images.testUtils";

/**
 * Motor de imagenes incrustadas (U7.1) contra el corpus sintetico, con la build «legacy» de pdf.js (en Node pdf.js
 * entrega `{ kind, data }`; el camino del navegador, con `ImageBitmap`, lo cubre `e2e/specs/extract-images.spec.ts`).
 */

let corpus: CorpusEntry[] = [];
const entry = (name: string): CorpusEntry => corpus.find((item) => item.name === name)!;

beforeAll(async () => {
  corpus = await buildImagesCorpus();
});

async function run(name: string, ctx: Parameters<typeof findImageAssets>[1] = {}) {
  const item = entry(name);
  const opened = await openLegacy(item.bytes);
  try {
    // Plazo corto de objetos: si algo se rompiera y un objeto no llegara, la prueba falla en 2 s y no en 20.
    const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes: item.bytes, objectTimeoutMs: 2000, ...ctx });
    return { result, opened, item };
  } catch (error) {
    await opened.close();
    throw error;
  }
}

async function withDoc<T>(name: string, fn: (ctx: Awaited<ReturnType<typeof run>>) => Promise<T>, ctx?: Parameters<typeof findImageAssets>[1]): Promise<T> {
  const state = await run(name, ctx);
  try {
    return await fn(state);
  } finally {
    await state.opened.close();
  }
}

describe("corpus completo contra su verdad", () => {
  const names = [
    "png-alpha", "png-opaque", "jpeg", "logo-repeat", "logo-copies", "inline", "inline-group", "mask-1bit", "form-nested", "smask",
    "scanned", "mosaic-200", "repeat-12", "bomb", "decode-failed", "jpx", "jbig2", "rotated-page", "offset-box", "annotation-image", "no-images",
  ];

  it("el corpus tiene todos los casos esperados", () => {
    expect(corpus.map((item) => item.name)).toEqual(names);
  });

  it.each(names)("%s: recall, agrupacion, cajas (IoU >= 0,9), avisos y paginas escaneadas", async (name) => {
    await withDoc(name, async ({ result, item }) => {
      const metrics = evaluateImages(result, item.truth);
      expect(metrics.problems).toEqual([]);
      expect(metrics.found).toBe(metrics.truthImages);
      expect(metrics.exact).toBe(metrics.truthImages);
      expect(metrics.extra).toBe(0);
      expect(metrics.minIou).toBeGreaterThanOrEqual(0.9);
    });
  });
});

describe("contenido de cada elemento", () => {
  it("todo es `image` de confianza maxima: el motor NO clasifica", async () => {
    await withDoc("png-alpha", async ({ result }) => {
      expect(result.assets).toHaveLength(1);
      const [asset] = result.assets;
      expect(asset.kind).toBe("image");
      expect(asset.confidence).toBe(1);
      expect(asset.ref.engine).toBe("image");
    });
  });

  it("motivos factuales: transparente, repetida en N paginas, JPEG original, en linea, mascara, formulario", async () => {
    await withDoc("logo-repeat", async ({ result }) => {
      expect(result.assets[0].reasons).toEqual(["transparente", "repetida en 5 páginas"]);
      expect(result.assets[0].occurrences.map((o) => o.pageIndex)).toEqual([0, 1, 2, 3, 4]);
    });
    await withDoc("jpeg", async ({ result }) => {
      const rgb = result.assets.find((a) => a.pixel?.width === 64)!;
      expect(rgb.reasons).toEqual(["JPEG original disponible"]);
      expect(rgb.formats).toEqual(["png", "jpg-original"]);
    });
    await withDoc("inline", async ({ result }) => {
      expect(result.assets.find((a) => a.pixel?.width === 8)!.reasons).toEqual(["imagen en línea"]);
      expect(result.assets.find((a) => a.pixel?.width === 8)!.source).toBe("inline");
    });
    await withDoc("mask-1bit", async ({ result }) => {
      expect(result.assets[0].source).toBe("mask");
      expect(result.assets[0].reasons).toEqual(["transparente", "máscara de 1 bit"]);
    });
    await withDoc("form-nested", async ({ result }) => {
      expect(result.assets[0].reasons).toEqual(["repetida en 2 páginas", "dentro de un objeto de formulario"]);
    });
    await withDoc("repeat-12", async ({ result }) => {
      expect(result.assets[0].reasons).toEqual(["aparece 12 veces en la página"]);
      expect(result.assets[0].occurrences).toHaveLength(12);
    });
  });

  it("copias en objetos distintos con los mismos pixeles: un solo elemento con 3 apariciones (por huella de pixeles)", async () => {
    await withDoc("logo-copies", async ({ result }) => {
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].occurrences.map((o) => o.pageIndex)).toEqual([0, 1, 2]);
    });
  });

  it("transparencia: PNG con alfa, SMask y mascara son RGBA; opacas no", async () => {
    await withDoc("png-alpha", async ({ result }) => expect(result.assets[0].pixel).toEqual({ width: 120, height: 48, hasAlpha: true }));
    await withDoc("png-opaque", async ({ result }) => expect(result.assets[0].pixel?.hasAlpha).toBe(false));
    await withDoc("smask", async ({ result }) => expect(result.assets.map((a) => a.pixel?.hasAlpha)).toEqual([true, true]));
    await withDoc("jpeg", async ({ result }) => expect(result.assets.every((a) => a.pixel?.hasAlpha === false)).toBe(true));
  });

  it("miniatura: PNG con alfa de como mucho 256 px y el tamano del archivo estimado", async () => {
    await withDoc("png-alpha", async ({ result }) => {
      const [asset] = result.assets;
      expect(asset.thumb).toBeInstanceOf(Blob);
      expect(asset.thumb!.type).toBe("image/png");
      const thumb = decodePng(await blobBytes(asset.thumb!));
      expect([thumb.width, thumb.height]).toEqual([120, 48]); // ya cabe en 256: no se agranda
      let transparent = 0;
      for (let i = 3; i < thumb.data.length; i += 4) if (thumb.data[i] === 0) transparent += 1;
      expect(transparent).toBeGreaterThan(100); // el fondo sigue transparente
      expect(asset.bytesEstimate).toBeGreaterThan(70);
    });
    await withDoc("scanned", async ({ result }) => {
      const thumb = decodePng(await blobBytes(result.assets[0].thumb!));
      expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(256);
    });
  });

  it("los pixeles completos NO viajan en el resultado (memoria acotada): ningun TypedArray en los elementos", async () => {
    await withDoc("mosaic-200", async ({ result }) => {
      const seen = new Set<unknown>();
      const walk = (value: unknown, path: string): void => {
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new Error(`pixeles retenidos en ${path}`);
        if (value instanceof Blob) {
          expect(value.size).toBeLessThan(2000);
          return;
        }
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      };
      expect(() => walk(result, "result")).not.toThrow();
      expect(result.assets).toHaveLength(200);
    });
  });

  it("ids estables y unicos; el mismo documento da el mismo resultado dos veces", async () => {
    const first = await withDoc("mosaic-200", async ({ result }) => result.assets.map((a) => [a.id, a.ref.engine === "image" ? a.ref.objectId : ""]));
    const second = await withDoc("mosaic-200", async ({ result }) => result.assets.map((a) => [a.id, a.ref.engine === "image" ? a.ref.objectId : ""]));
    expect(second).toEqual(first);
    expect(new Set(first.map((pair) => pair[0])).size).toBe(200);
  });
});

describe("JPEG original sin recomprimir", () => {
  it("devuelve EXACTAMENTE los bytes incrustados (RGB y gris) y no se ofrece para CMYK ni JPEG con SMask", async () => {
    await withDoc("jpeg", async ({ result, opened, item }) => {
      for (const [id, expected] of Object.entries(item.jpegBytes)) {
        const truth = item.truth.images.find((image) => image.id === id)!;
        const asset = result.assets.find((a) => a.pixel?.width === truth.width && a.pixel?.height === truth.height)!;
        const blob = await renderImageAsset(opened.doc, asset, "jpg-original", { bytes: item.bytes });
        expect(blob.type).toBe("image/jpeg");
        expect([...(await blobBytes(blob))]).toEqual([...expected]);
      }
      const cmyk = result.assets.find((a) => a.pixel?.width === 32)!;
      expect(cmyk.formats).toEqual(["png", "jpg"]);
      await expect(renderImageAsset(opened.doc, cmyk, "jpg-original")).rejects.toMatchObject({ code: "format-unavailable" });
    });
    await withDoc("smask", async ({ result }) => {
      for (const asset of result.assets) expect(asset.formats).toEqual(["png"]);
    });
  });

  it("sin pasar los bytes, los lee con doc.getData()", async () => {
    await withDoc("jpeg", async ({ result, opened, item }) => {
      const asset = result.assets.find((a) => a.pixel?.width === 64)!;
      const blob = await renderImageAsset(opened.doc, asset, "jpg-original");
      expect([...(await blobBytes(blob))]).toEqual([...item.jpegBytes["jpeg-rgb"]]);
    }, { bytes: undefined });
  });

  it("con un indice vacio (`jpegIndex: null`) no se ofrece ningun original", async () => {
    await withDoc("jpeg", async ({ result }) => expect(result.assets.every((a) => !a.formats.includes("jpg-original"))).toBe(true), { jpegIndex: null });
  });
});

describe("anotaciones", () => {
  it("por defecto NO se miran las imagenes de la apariencia de una anotacion (son de annotations.ts)", async () => {
    await withDoc("annotation-image", async ({ result }) => {
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].reasons).toEqual([]);
    });
  });

  it("con `includeAnnotations` aparece tambien la del sello, en la caja de su /Rect, y se regenera igual", async () => {
    await withDoc("annotation-image", async ({ result, opened }) => {
      expect(result.assets).toHaveLength(2);
      const stamp = result.assets.find((a) => a.reasons.includes("dentro de una anotación"))!;
      expect(stamp).toBeDefined();
      expect(stamp.occurrences[0].rect.x).toBeCloseTo(150 / 300, 4);
      expect(stamp.occurrences[0].rect.y).toBeCloseTo(1 - 210 / 300, 4);
      expect(stamp.occurrences[0].rect.width).toBeCloseTo(0.2, 4);
      expect(stamp.occurrences[0].rect.height).toBeCloseTo(0.2, 4);
      expect(stamp.ref.engine === "image" && stamp.ref.objectId.endsWith(":a")).toBe(true);
      const png = decodePng(await blobBytes(await renderImageAsset(opened.doc, stamp, "png")));
      expect([png.width, png.height]).toEqual([8, 8]);
      expect([...png.data.subarray(0, 4)]).toEqual([200, 0, 50, 255]);
      expect([...png.data.subarray(7 * 4, 7 * 4 + 4)]).toEqual([200, 140, 50, 255]);
    }, { includeAnnotations: true });
  });
});

describe("formatos ofrecidos", () => {
  it("PNG siempre y primero; con alfa solo PNG; sin alfa, el JPEG original si lo hay y si no `jpg`", () => {
    expect(formatsFor(true, false)).toEqual(["png"]);
    expect(formatsFor(true, true)).toEqual(["png"]);
    expect(formatsFor(false, true)).toEqual(["png", "jpg-original"]);
    expect(formatsFor(false, false)).toEqual(["png", "jpg"]);
  });

  it("en el corpus: opacas sin original -> png + jpg; con original -> png + jpg-original; con alfa -> png", async () => {
    await withDoc("png-opaque", async ({ result }) => expect(result.assets[0].formats).toEqual(["png", "jpg"]));
    await withDoc("scanned", async ({ result }) => expect(result.assets[0].formats).toEqual(["png", "jpg"]));
    await withDoc("png-alpha", async ({ result }) => expect(result.assets[0].formats).toEqual(["png"]));
    await withDoc("mask-1bit", async ({ result }) => expect(result.assets[0].formats).toEqual(["png"]));
    await withDoc("jpeg", async ({ result }) => {
      expect(result.assets.map((a) => a.formats)).toEqual([["png", "jpg-original"], ["png", "jpg-original"], ["png", "jpg"]]);
    });
  });
});

describe("renderImageAsset regenera los pixeles bajo demanda", () => {
  const withPixels = corpusPixelNames();

  function corpusPixelNames(): string[] {
    return ["png-alpha", "png-opaque", "logo-repeat", "logo-copies", "inline", "inline-group", "mask-1bit", "form-nested", "smask", "scanned", "repeat-12", "jpx", "jbig2"];
  }

  it.each(withPixels)("%s: los pixeles del PNG son EXACTOS (RGBA)", async (name) => {
    await withDoc(name, async ({ result, opened, item }) => {
      expect(item.pixels.length).toBeGreaterThan(0);
      for (const expectation of item.pixels) {
        const truth = item.truth.images.find((image) => image.id === expectation.imageId)!;
        const asset = result.assets.find(
          (a) =>
            a.pixel?.width === truth.width &&
            a.pixel?.height === truth.height &&
            a.occurrences[0].pageIndex === truth.occurrences[0].pageIndex &&
            Math.abs(a.occurrences[0].rect.x - truth.occurrences[0].rect.x) < 0.01 &&
            Math.abs(a.occurrences[0].rect.y - truth.occurrences[0].rect.y) < 0.01,
        )!;
        expect(asset, expectation.imageId).toBeDefined();
        const blob = await renderImageAsset(opened.doc, asset, "png");
        expect(blob.type).toBe("image/png");
        const png = decodePng(await blobBytes(blob));
        expect([png.width, png.height]).toEqual([truth.width, truth.height]);
        let wrong = 0;
        for (let y = 0; y < png.height; y += 1) {
          for (let x = 0; x < png.width; x += 1) {
            const expected = expectation.at(x, y);
            const got = png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4);
            if (got[0] !== expected[0] || got[1] !== expected[1] || got[2] !== expected[2] || got[3] !== expected[3]) wrong += 1;
          }
        }
        expect(wrong, `${name}/${expectation.imageId}: pixeles distintos`).toBe(0);
      }
    });
  });

  it("tras volver a abrir el documento, el elemento (ya sin el motor) se regenera igual", async () => {
    const item = entry("inline-group");
    const found = await withDoc("inline-group", async ({ result }) => result.assets);
    // Documento NUEVO: la referencia del elemento basta para regenerarlo.
    const fresh = await openLegacy(item.bytes);
    try {
      for (const asset of found) {
        const png = decodePng(await blobBytes(await renderImageAsset(fresh.doc, asset, "png")));
        expect([png.width, png.height]).toEqual([8, 8]);
      }
    } finally {
      await fresh.close();
    }
  });

  it("llamarla dos veces da el mismo PNG (pixeles) y deja la pagina limpia", async () => {
    await withDoc("png-alpha", async ({ result, opened }) => {
      const a = decodePng(await blobBytes(await renderImageAsset(opened.doc, result.assets[0], "png")));
      const b = decodePng(await blobBytes(await renderImageAsset(opened.doc, result.assets[0], "png")));
      expect([...a.data]).toEqual([...b.data]);
    });
  });

  it("errores tipados: no es de este motor, formato no ofrecido, pintura que ya no esta, `jpg` sin canvas", async () => {
    await withDoc("png-alpha", async ({ result, opened }) => {
      const asset = result.assets[0];
      const foreign: ExtractedAsset = { ...asset, ref: { engine: "text", text: "x" } };
      await expect(renderImageAsset(opened.doc, foreign)).rejects.toBeInstanceOf(ImageAssetError);
      await expect(renderImageAsset(opened.doc, foreign)).rejects.toMatchObject({ code: "not-an-image-asset" });
      await expect(renderImageAsset(opened.doc, asset, "svg")).rejects.toMatchObject({ code: "format-unavailable" });
      await expect(renderImageAsset(opened.doc, asset, "jpg-original")).rejects.toMatchObject({ code: "format-unavailable" });
      const broken: ExtractedAsset = { ...asset, ref: { engine: "image", objectId: "basura", pageIndex: 0 } };
      await expect(renderImageAsset(opened.doc, broken)).rejects.toMatchObject({ code: "not-an-image-asset" });
      const moved: ExtractedAsset = { ...asset, ref: { engine: "image", objectId: "xobject:9999:0:-", pageIndex: 0 } };
      await expect(renderImageAsset(opened.doc, moved)).rejects.toMatchObject({ code: "asset-changed" });
      const swapped: ExtractedAsset = { ...asset, ref: { engine: "image", objectId: asset.ref.engine === "image" ? asset.ref.objectId.replace(/:[^:]+$/, ":999R") : "", pageIndex: 0 } };
      await expect(renderImageAsset(opened.doc, swapped)).rejects.toMatchObject({ code: "asset-changed" });
      // En Node no hay canvas: el JPEG recomprimido avisa en vez de fallar a medias.
      const jpg: ExtractedAsset = { ...asset, formats: ["png", "jpg"] };
      await expect(renderImageAsset(opened.doc, jpg, "jpg")).rejects.toMatchObject({ code: "no-canvas" });
    });
  });

  it("se puede cancelar", async () => {
    await withDoc("png-alpha", async ({ result, opened }) => {
      const controller = new AbortController();
      controller.abort();
      await expect(renderImageAsset(opened.doc, result.assets[0], "png", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});

describe("avisos y limites", () => {
  it("pagina escaneada: solo la que es una imagen sin texto; la de fondo CON texto no", async () => {
    await withDoc("scanned", async ({ result }) => {
      expect(result.scannedPages).toEqual([0]);
      expect(result.warnings).toEqual([{ code: "scanned-page", pageIndex: 0 }]);
    });
  });

  it("imagen de mas de 50 MP (bomba de pixeles): se omite con `image-too-large` y la imagen buena sale", async () => {
    await withDoc("bomb", async ({ result }) => {
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].pixel).toEqual({ width: 10, height: 10, hasAlpha: false });
      expect(result.warnings.find((w) => w.code === "image-too-large")).toMatchObject({ pageIndex: 0, detail: "8000x8000" });
    });
  });

  it("limite de megapixeles configurable: un JPEG demasiado grande solo ofrece su original; un PNG se omite", async () => {
    await withDoc("jpeg", async ({ result, opened, item }) => {
      const big = result.assets.filter((a) => a.formats.length === 1 && a.formats[0] === "jpg-original");
      expect(big).toHaveLength(1);
      expect(big[0].thumb).toBeNull();
      expect(big[0].pixel).toEqual({ width: 64, height: 48, hasAlpha: false });
      expect(big[0].reasons).toContain("demasiado grande para convertirla: solo el original");
      expect(result.warnings.map((w) => w.code)).toEqual(["image-too-large"]);
      // El original se descarga igual.
      const blob = await renderImageAsset(opened.doc, big[0], "jpg-original", { bytes: item.bytes });
      expect([...(await blobBytes(blob))]).toEqual([...item.jpegBytes["jpeg-rgb"]]);
      await expect(renderImageAsset(opened.doc, big[0], "png")).rejects.toMatchObject({ code: "format-unavailable" });
    }, { maxMegapixels: 0.003 });
    await withDoc("png-opaque", async ({ result }) => {
      expect(result.assets).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toEqual(["image-too-large"]);
    }, { maxMegapixels: 0.003 });
  });

  it("una imagen que no se decodifica da `decode-failed` con la pagina y no rompe el resto", async () => {
    await withDoc("decode-failed", async ({ result }) => {
      expect(result.assets).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ code: "decode-failed", pageIndex: 0 });
    });
  });

  it("tope de elementos: 50 de 200, un solo aviso `too-many-assets`", async () => {
    await withDoc("mosaic-200", async ({ result }) => {
      expect(result.assets).toHaveLength(50);
      expect(result.warnings.filter((w) => w.code === "too-many-assets")).toHaveLength(1);
    }, { options: { maxAssets: 50 } });
  });

  it("tope de paginas y rango: solo las pedidas, con aviso `too-many-pages` si se recorto", async () => {
    await withDoc("logo-repeat", async ({ result }) => {
      expect(result.assets[0].occurrences.map((o) => o.pageIndex)).toEqual([0, 1]);
      expect(result.warnings.map((w) => w.code)).toEqual(["too-many-pages"]);
    }, { options: { maxPages: 2 } });
    await withDoc("logo-repeat", async ({ result }) => {
      expect(result.assets[0].occurrences.map((o) => o.pageIndex)).toEqual([2, 3]);
      expect(result.warnings).toEqual([]);
    }, { options: { pageRange: { from: 2, to: 3 } } });
    await withDoc("logo-repeat", async ({ result }) => {
      // Un rango fuera del documento se recorta a sus paginas.
      expect(result.assets[0].occurrences.map((o) => o.pageIndex)).toEqual([4]);
    }, { options: { pageRange: { from: 4, to: 99 } } });
  });

  it("onProgress: una vez por pagina, en orden y con el recuento de elementos hasta ese momento", async () => {
    const calls: Array<[number, number, number]> = [];
    await withDoc("logo-repeat", async () => {
      expect(calls).toEqual([[0, 5, 1], [1, 5, 1], [2, 5, 1], [3, 5, 1], [4, 5, 1]]);
    }, { options: { onProgress: (p) => calls.push([p.pageIndex, p.pageCount, p.assetsSoFar]) } });
  });

  it("cancelacion: ya cancelada al empezar, y a mitad (al primer progreso) -> AbortError", async () => {
    const early = new AbortController();
    early.abort();
    await expect(run("logo-repeat", { options: { signal: early.signal } })).rejects.toMatchObject({ name: "AbortError" });
    const mid = new AbortController();
    await expect(run("logo-repeat", { options: { signal: mid.signal, onProgress: () => mid.abort() } })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("libera cada pagina (page.cleanup) tras procesarla", async () => {
    const item = entry("logo-repeat");
    const opened = await openLegacy(item.bytes);
    try {
      const cleaned: number[] = [];
      const original = opened.doc.getPage.bind(opened.doc);
      opened.doc.getPage = (async (number: number) => {
        const page = await original(number);
        const cleanup = page.cleanup.bind(page);
        page.cleanup = ((...args: Parameters<typeof cleanup>) => {
          cleaned.push(number);
          return cleanup(...args);
        }) as typeof page.cleanup;
        return page;
      }) as typeof opened.doc.getPage;
      await findImageAssets(opened.doc, { ops: opened.ops, bytes: item.bytes });
      expect(cleaned).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await opened.close();
    }
  });

  it("nunca pide nada a la red", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("red prohibida"));
    try {
      for (const name of ["png-alpha", "jpeg", "jpx", "scanned"]) await withDoc(name, async ({ result }) => expect(result.assets.length).toBeGreaterThan(0));
    } finally {
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }
  });
});

describe("casos que el corpus no cubre", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const close of closers) await close();
  });

  it("mas de 500 apariciones de una imagen: se guardan 500 y el motivo cuenta todas", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([612, 792]);
    const ref = doc.context.register(
      doc.context.flateStream(new Uint8Array(4 * 4 * 3).fill(120), { Type: "XObject", Subtype: "Image", Width: 4, Height: 4, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }),
    );
    page.node.setXObject(doc.context.obj("Im") as never, ref);
    let content = "";
    for (let i = 0; i < 600; i += 1) content += `q 10 0 0 10 ${(i % 50) * 11} ${Math.floor(i / 50) * 11} cm /Im Do Q\n`;
    page.node.addContentStream(doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
    const bytes = await doc.save({ useObjectStreams: false });
    const opened = await openLegacy(bytes);
    closers.push(opened.close);
    const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].occurrences).toHaveLength(500);
    expect(result.assets[0].reasons).toContain("aparece 600 veces en la página");
  });
});
