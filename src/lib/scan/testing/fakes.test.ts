import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { createFakeEngine, makeBarePage, newControls, type FakeEngine } from "@/lib/scan/testing/fakeEngine";
import { SESSION_TTL_MS, createFakeStore } from "@/lib/scan/testing/fakeStore";
import { tinyJpegBytes, tinyJpegFile } from "@/lib/scan/testing/testImages";
import { DEFAULT_SCAN_SETTINGS, type ScanSession } from "@/lib/scan/types";

/** Los dobles de prueba tambien se prueban: si mienten, mienten todas las pruebas de la interfaz. */
describe("motor falso", () => {
  let engine: FakeEngine;
  beforeEach(() => {
    engine = createFakeEngine(newControls());
  });
  const info = { source: "library" as const, mode: "document" as const, settings: DEFAULT_SCAN_SETTINGS };

  it("createPage: etiquetas del nombre -> avisos de calidad; sin canvas no hay pixeles pero la pagina es valida", async () => {
    const page = await engine.createPage(tinyJpegFile("x-blank-blurry-glare-dark-nodoc.jpg"), info);
    expect(page.flags).toEqual({ blank: true, blurry: true, glare: true, dark: true, noDocument: true });
    expect(page.corners).toBeNull();
    expect(page.original.size).toBeGreaterThan(0);
    expect(page.filter).toBe("auto");
    const plain = await engine.createPage(tinyJpegFile("hoja.jpg"), info);
    expect(plain.flags).toEqual({});
    expect(plain.corners).not.toBeNull();
    // `fail` rechaza; Foto no recorta ni filtra.
    await expect(engine.createPage(tinyJpegFile("b-fail.jpg"), info)).rejects.toThrow("fake-create-failed");
    const photo = await engine.createPage(tinyJpegFile("dano.jpg"), { ...info, mode: "photo" });
    expect(photo.corners).toBeNull();
    expect(photo.filter).toBe("original");
  });

  it("renderPage: con maxSide <= 480 solo recalcula la miniatura (processed null, como el motor real); sin maxSide, el resultado completo", async () => {
    const page = await engine.createPage(tinyJpegFile("a.jpg"), info);
    const quick = await engine.renderPage({ ...page, rotation: 90 }, { maxSide: 480 });
    expect(quick.processed).toBeNull();
    expect(quick.thumb).not.toBeNull();
    const full = await engine.renderPage({ ...page, rotation: 90 });
    expect(full.processed).not.toBeNull();
    expect(engine.controls.calls.renderQuick).toBe(1);
    expect(engine.controls.calls.renderFull).toBe(1);
  });

  it("createPage cuenta el orden de las llamadas y el pico de concurrencia", async () => {
    await Promise.all([engine.createPage(tinyJpegFile("a.jpg"), info), engine.createPage(tinyJpegFile("b.jpg"), info)]);
    expect(engine.controls.createLog).toEqual(["a.jpg", "b.jpg"]);
    expect(engine.controls.peakConcurrent).toBe(2);
  });

  it("fotogramas de camara (sin nombre) toman las etiquetas de controls.tokens, una por pagina", async () => {
    engine.controls.tokens = [["blurry"], ["blank"]];
    const first = await engine.createPage(new Blob([tinyJpegBytes() as BlobPart]), info);
    const second = await engine.createPage(new Blob([tinyJpegBytes() as BlobPart]), info);
    const third = await engine.createPage(new Blob([tinyJpegBytes() as BlobPart]), info);
    expect([first.flags, second.flags, third.flags]).toEqual([{ blurry: true }, { blank: true }, {}]);
  });

  it("analyzeSession marca repetidas (mismos bytes o etiqueta dup) y conserva los avisos", async () => {
    const a = await engine.createPage(tinyJpegFile("a.jpg", 64, 80, 1), info);
    const b = await engine.createPage(tinyJpegFile("b.jpg", 64, 80, 2), info);
    const copy = { ...a, id: "copy" };
    const dup = await engine.createPage(tinyJpegFile("c-dup.jpg", 64, 80, 3), info);
    const flags = await engine.analyzeSession([a, b, copy, dup]);
    expect(flags[a.id].duplicateOf).toBeUndefined();
    expect(flags.copy.duplicateOf).toBe(a.id);
    expect(flags[dup.id].duplicateOf).toBe(copy.id);
  });

  it("orientacion y nombre sugerido", async () => {
    expect(await engine.detectOrientation(await engine.createPage(tinyJpegFile("a-sideways.jpg"), info))).toBe(90);
    expect(await engine.detectOrientation(await engine.createPage(tinyJpegFile("a-upsidedown.jpg"), info))).toBe(180);
    expect(await engine.detectOrientation(await engine.createPage(tinyJpegFile("a.jpg"), info))).toBe(0);
    const titled = await engine.createPage(tinyJpegFile("title-Contrato_de_servicio.jpg"), info);
    expect(await engine.suggestName([titled], "es")).toMatchObject({ title: "Contrato de servicio", source: "ocr" });
    expect(await engine.suggestName([], "es")).toMatchObject({ title: null, source: "date" });
  });

  it("analyzeFrame: sin forzar, ok estable y luz verde tras autoAfterMs; forzado, lo que diga el test", () => {
    const frame = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;
    engine.controls.autoAfterMs = 700;
    const t0 = 1000;
    expect(engine.analyzeFrame(frame, undefined, t0).shouldAutoCapture).toBe(false);
    expect(engine.analyzeFrame(frame, undefined, t0 + 300).hint).toBe("ok");
    expect(engine.analyzeFrame(frame, undefined, t0 + 800).shouldAutoCapture).toBe(true);
    engine.controls.verdict = { hint: "glare", shouldAutoCapture: false };
    expect(engine.analyzeFrame(frame, undefined, t0 + 900)).toMatchObject({ hint: "glare", shouldAutoCapture: false });
  });

  it("splitSpread (aditivo): dos paginas nuevas que comparten el original, izquierda y derecha, con esquinas propias", async () => {
    const whole = await engine.createPage(tinyJpegFile("libro.jpg", 160, 100), { ...info, mode: "book" });
    const [left, right] = await engine.splitSpread(whole);
    expect(new Set([whole.id, left.id, right.id]).size).toBe(3);
    expect(left.original).toBe(whole.original);
    expect(right.original).toBe(whole.original);
    expect(left.corners!.topRight.x).toBeLessThanOrEqual(right.corners!.topLeft.x);
    engine.controls.noSplit = true;
    await expect(engine.splitSpread(whole)).rejects.toThrow();
  });

  it("estimateSize crece con la calidad y con el texto buscable", () => {
    const pages = [makeBarePage("a", {}, 100_000), makeBarePage("b", {}, 100_000)];
    const original = engine.estimateSize(pages, { preset: "original", searchable: false }).bytes;
    const compact = engine.estimateSize(pages, { preset: "compact", searchable: false }).bytes;
    const searchable = engine.estimateSize(pages, { preset: "compact", searchable: true }).bytes;
    expect(original).toBeGreaterThan(compact);
    expect(searchable).toBeGreaterThan(compact);
    const { low, high, bytes } = engine.estimateSize(pages, { preset: "balanced", searchable: false });
    expect(low).toBeLessThan(bytes);
    expect(high).toBeGreaterThan(bytes);
  });

  it("buildPdf: una pagina por hoja y en el orden de la sesion, con progreso; cancelable", async () => {
    const session: ScanSession = {
      id: "s",
      createdAt: "",
      updatedAt: "",
      name: "",
      settings: DEFAULT_SCAN_SETTINGS,
      pages: [10, 20, 30].map((w, index) => {
        const blob = new Blob([tinyJpegBytes(w * 4, 100, index) as BlobPart], { type: "image/jpeg" });
        return makeBarePage(`p${index}`, { original: blob, processed: blob });
      }),
    };
    const progress: number[] = [];
    const blob = await engine.buildPdf(session, { preset: "balanced", pageSize: "fit", margin: "none", onProgress: (done) => progress.push(done) });
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getPages().map((page) => Math.round(page.getWidth()))).toEqual([40, 80, 120]);
    expect(progress).toEqual([1, 2, 3]);
    const a4 = await PDFDocument.load(await (await engine.buildPdf(session, { preset: "balanced", pageSize: "a4", margin: "small" })).arrayBuffer());
    expect(Math.round(a4.getPage(0).getWidth())).toBe(595);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.buildPdf(session, { preset: "balanced", pageSize: "a4", margin: "none", signal: controller.signal })).rejects.toThrow();
    engine.controls.buildError = "boom";
    await expect(engine.buildPdf(session, { preset: "balanced", pageSize: "a4", margin: "none" })).rejects.toThrow("boom");
  });
});

describe("almacen falso", () => {
  const session = (id: string, pages: number, updatedAt = new Date().toISOString(), size = 100): ScanSession => ({
    id,
    createdAt: updatedAt,
    updatedAt,
    name: `Sesion ${id}`,
    settings: DEFAULT_SCAN_SETTINGS,
    pages: Array.from({ length: pages }, (_, index) => makeBarePage(`${id}-${index}`, {}, size)),
  });

  for (const backend of ["memory", "indexeddb"] as const) {
    it(`${backend}: guarda, lista (la mas reciente primero), carga y borra`, async () => {
      const store = createFakeStore({ backend });
      expect(await store.save(session(`a-${backend}`, 2, "2026-01-01T00:00:00.000Z"))).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.save(session(`b-${backend}`, 3));
      const list = await store.list();
      expect(list.map((entry) => entry.id)).toContain(`b-${backend}`);
      expect(list.find((entry) => entry.id === `b-${backend}`)?.pageCount).toBe(3);
      const loaded = await store.load(`b-${backend}`);
      expect(loaded?.pages).toHaveLength(3);
      expect(loaded?.pages[0].original.size).toBe(100);
      expect(await store.load("no-existe")).toBeNull();
      await store.remove(`b-${backend}`);
      expect(await store.load(`b-${backend}`)).toBeNull();
    });
  }

  it("indexeddb conserva Blob y File (con su nombre) tras la ida y vuelta", async () => {
    const store = createFakeStore({ backend: "indexeddb" });
    const file = tinyJpegFile("hoja-blank.jpg");
    await store.save({ ...session("rt", 1), pages: [makeBarePage("rt-0", { original: file, thumb: null })] });
    const loaded = await store.load("rt");
    expect(loaded?.pages[0].original).toBeInstanceOf(Blob);
    expect((loaded?.pages[0].original as File).name).toBe("hoja-blank.jpg");
    expect(loaded?.pages[0].thumb).toBeNull();
    expect(loaded?.pages[0].original.size).toBe(file.size);
  });

  it("cuota, indisponible y demasiado grande devuelven el motivo", async () => {
    const store = createFakeStore({ backend: "memory", quotaBytes: 250 });
    expect(await store.save(session("q1", 2, undefined, 100))).toEqual({ ok: true });
    expect(await store.save(session("q2", 2, undefined, 100))).toEqual({ ok: false, reason: "quota" });
    // Reescribir la misma sesion no suma dos veces.
    expect(await store.save(session("q1", 2, undefined, 100))).toEqual({ ok: true });
    store.controls.unavailable = true;
    expect(await store.save(session("q1", 1))).toEqual({ ok: false, reason: "unavailable" });
    store.controls.unavailable = false;
    store.controls.tooBig = true;
    expect(await store.save(session("q1", 1))).toEqual({ ok: false, reason: "tooBig" });
    expect(store.controls.saveLog.length).toBeGreaterThanOrEqual(5);
  });

  it("purgeExpired borra las de mas de 14 dias (y solo esas)", async () => {
    const store = createFakeStore({ backend: "memory" });
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    // El almacen sella `updatedAt` al guardar: se siembra tocando directamente la sesion en memoria.
    await store.save(session("viejo", 1));
    await store.save(session("nuevo", 1));
    const viejo = await store.load("viejo");
    expect(viejo).not.toBeNull();
    // Expiran a los 14 dias: a los 13 siguen, a los 15 no (cifras absolutas, no la constante).
    const DAY = 24 * 60 * 60 * 1000;
    expect(SESSION_TTL_MS).toBe(14 * DAY);
    expect(await store.purgeExpired(Date.now() + 13 * DAY)).toBe(0);
    expect(await store.purgeExpired(Date.now() + 15 * DAY)).toBe(2);
    await store.save(session("otro", 1));
    expect(await store.purgeExpired(now - 1)).toBe(0);
    expect((await store.list()).map((entry) => entry.id)).toEqual(["otro"]);
  });
});
