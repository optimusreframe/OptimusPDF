/* eslint-disable @typescript-eslint/no-explicit-any -- el codigo de `page.evaluate` se ejecuta en el navegador sobre `window.__lab` (motor empaquetado), sin tipos en este lado */
import { expect, test, type Page } from "@playwright/test";
import { buildScanFixtures, type PhotoFixture } from "../helpers/scan-engine-fixtures";
import { openLab as openLabWith, trackRequests } from "../helpers/scan-engine-lab";
import { quadIoU } from "../../src/lib/scan/geometry";
import { getPageCount, getTextItems } from "../helpers/pdf-inspection";
import { engineOf } from "../helpers/engine";

/**
 * Motor del Escaner (E1) en un NAVEGADOR REAL y headless, sin la interfaz definitiva: el motor real (`realEngine`) con su
 * cola de procesado (Web Worker + OffscreenCanvas, con respaldo al hilo principal), fotos SINTETICAS generadas aqui y un OCR de
 * mentira (sin red). Mide lo que Node no puede: decodificar y procesar de verdad, el tiempo capturar -> miniatura, las tareas
 * largas del hilo principal, la memoria y la cancelacion.
 *
 * PATRON (igual que `extract-images.spec.ts`; sin pagina de pruebas en el producto): `e2e/helpers/scan-engine-entry.ts` se
 * empaqueta con Vite y se inyecta en `/privacy` con su CSP real; el worker se arranca desde un `blob:`.
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad` (build con
 * `CSP_SKIP_UPGRADE_INSECURE=1`).
 */

test.setTimeout(240_000);
const SLACK = process.env.CI ? 2.5 : 1;

let fixtures: Record<string, PhotoFixture> = {};
const openLab = (page: Page, options: { worker: boolean } = { worker: true }) => openLabWith(page, fixtures, options);

test.beforeAll(async () => {
  fixtures = buildScanFixtures();
});

test.describe("motor del Escaner · navegador real", () => {
  test("createPage: detecta la hoja (IoU), saca la miniatura de 360 px, deja el original intacto y tarda < 300 ms por pagina", async ({ page }) => {
    const requests = trackRequests(page);
    await openLab(page);
    const ids = ["text0", "text90", "text180", "text270", "blur", "formA", "dupA"];
    const result = await page.evaluate(async (list) => {
      const lab = (window as unknown as { __lab: any }).__lab;
      // Calentamiento: la primera pagina descarga el chunk de scanic y arranca el worker (la interfaz lo adelanta al abrir la camara).
      const t0 = performance.now();
      await lab.make("text0");
      const warmup = performance.now() - t0;
      const rows = [];
      for (const id of list) {
        const originalHash = await lab.sha(lab.blobOf(id));
        const start = performance.now();
        const created = await lab.make(id);
        const ms = performance.now() - start;
        rows.push({
          id,
          ms,
          corners: created.corners,
          thumb: created.thumb ? await lab.dims(created.thumb) : null,
          thumbType: created.thumb?.type,
          flags: created.flags,
          sameOriginal: (await lab.sha(created.original)) === originalHash,
          originalSize: { width: created.originalWidth, height: created.originalHeight },
        });
      }
      return { warmup, rows, stats: lab.L.renderStats() };
    }, ids);
    let slowest = 0;
    const times: number[] = [];
    for (const row of result.rows) {
      const fixture = fixtures[row.id];
      expect(row.corners, row.id).not.toBeNull();
      expect(quadIoU(row.corners, fixture.quad!), `${row.id} IoU`).toBeGreaterThanOrEqual(0.9);
      expect(row.thumb, row.id).not.toBeNull();
      expect(Math.max(row.thumb!.width, row.thumb!.height), row.id).toBe(360);
      expect(row.thumbType).toBe("image/jpeg");
      expect(row.sameOriginal, `${row.id}: el original no se toca`).toBe(true);
      expect(row.originalSize).toEqual({ width: fixture.width, height: fixture.height });
      expect(row.flags.noDocument).toBeUndefined();
      times.push(row.ms);
      slowest = Math.max(slowest, row.ms);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`[scan-engine] ${engineOf(page)} createPage: primera ${result.warmup.toFixed(0)} ms, mediana ${median.toFixed(0)} ms, peor ${slowest.toFixed(0)} ms, worker=${result.stats.worker} main=${result.stats.main}`);
    expect(median).toBeLessThan(300 * SLACK);
    expect(slowest).toBeLessThan(600 * SLACK);
    expect(result.stats.worker).toBeGreaterThan(0);
    expect(requests.external, requests.external.join("\n")).toEqual([]);
    expect(requests.nonGet).toEqual([]);
  });

  test("marca la hoja borrosa, el brillo y la hoja en blanco al crearla; una foto de dano no se recorta ni se marca borrosa", async ({ page }) => {
    await openLab(page);
    const flags = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const out: Record<string, unknown> = {};
      for (const id of ["text0", "blur", "glare", "blank"]) out[id] = (await lab.make(id)).flags;
      const photo = await lab.make("photo", "photo");
      out.photo = { flags: photo.flags, corners: photo.corners };
      return out;
    });
    expect(flags.text0).toEqual({});
    expect((flags.blur as { blurry?: boolean }).blurry).toBe(true);
    expect((flags.glare as { glare?: boolean }).glare).toBe(true);
    expect((flags.blank as { blank?: boolean }).blank).toBe(true);
    expect((flags.photo as { corners: unknown }).corners).toBeNull();
    expect((flags.photo as { flags: Record<string, unknown> }).flags.blurry).toBeUndefined();
    expect((flags.photo as { flags: Record<string, unknown> }).flags.noDocument).toBeUndefined();
  });

  test("renderPage: resultado completo desde el original, filtros y ajustes distintos, el original nunca cambia", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const created = await lab.make("text0");
      const originalHash = await lab.sha(created.original);
      const render = async (patch: Record<string, unknown>) => {
        const next = await lab.L.realEngine.renderPage({ ...created, ...patch });
        const p = await lab.pixels(next.processed);
        return { next, p };
      };
      const enhance = await render({ filter: "enhance" });
      const bw = await render({ filter: "bw" });
      const original = await render({ filter: "original" });
      const gray = await render({ filter: "grayscale" });
      const auto = await render({ filter: "auto" });
      const bright = await render({ filter: "color", adjust: { brightness: 0.5, contrast: 0 } });
      const dark = await render({ filter: "color", adjust: { brightness: -0.5, contrast: 0 } });
      const rotated = await render({ filter: "color", rotation: 90 });
      const thumbOnly = await lab.L.realEngine.renderPage(created, { maxSide: 360 });
      const isGrayish = (p: any) => { let diff = 0; for (let i = 0; i < p.data.length; i += 4) diff = Math.max(diff, Math.abs(p.data[i] - p.data[i + 1]), Math.abs(p.data[i + 1] - p.data[i + 2])); return diff <= 3; };
      const w = enhance.p.width; const h = enhance.p.height;
      return {
        sizes: { enhance: [w, h], rotated: [rotated.p.width, rotated.p.height], max: Math.max(w, h) },
        processedSize: enhance.next.processedSize,
        paperEnhance: lab.meanLuma(enhance.p, Math.round(w * 0.05), Math.round(h * 0.93), Math.round(w * 0.95), Math.round(h * 0.97)),
        paperOriginal: lab.meanLuma(original.p, Math.round(w * 0.05), Math.round(h * 0.93), Math.round(w * 0.95), Math.round(h * 0.97)),
        bwGray: isGrayish(bw.p), grayGray: isGrayish(gray.p), originalGray: isGrayish(original.p),
        autoMatchesEnhance: auto.next.processed.size === enhance.next.processed.size,
        brightDelta: lab.meanLuma(bright.p, 0, 0, bright.p.width, bright.p.height) - lab.meanLuma(dark.p, 0, 0, dark.p.width, dark.p.height),
        thumbOnly: { processed: thumbOnly.processed, thumb: !!thumbOnly.thumb },
        sameOriginal: (await lab.sha(created.original)) === originalHash && enhance.next.original === created.original,
        mime: enhance.next.processed.type,
      };
    });
    expect(out.sizes.max).toBeLessThanOrEqual(3508);
    expect(out.sizes.rotated[0]).toBe(out.sizes.enhance[1]);
    expect(out.processedSize).toEqual({ width: out.sizes.enhance[0], height: out.sizes.enhance[1] });
    expect(out.paperEnhance).toBeGreaterThan(240);
    expect(out.bwGray && out.grayGray).toBe(true);
    expect(out.originalGray).toBe(false);
    expect(out.autoMatchesEnhance).toBe(true);
    expect(out.brightDelta).toBeGreaterThan(40);
    expect(out.thumbOnly).toEqual({ processed: null, thumb: true });
    expect(out.sameOriginal).toBe(true);
    expect(out.mime).toBe("image/jpeg");
  });

  test("EXIF: una foto con orientacion 6 queda enderezada en el original guardado y en la miniatura", async ({ page }) => {
    await openLab(page);
    const { makeExifJpeg } = await import("../helpers/exif-jpeg");
    const jpeg = makeExifJpeg({ width: 400, height: 240, orientation: 6 }).toString("base64");
    const out = await page.evaluate(async (b64) => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const created = await lab.L.realEngine.createPage(new Blob([bytes], { type: "image/jpeg" }), { source: "library", mode: "photo", settings: lab.settings("photo") });
      const original = await lab.pixels(created.original);
      const thumb = await lab.pixels(created.thumb);
      const topLeft = (p: any) => [p.data[0], p.data[1], p.data[2]];
      return { original: { w: original.width, h: original.height, top: topLeft(original) }, thumb: { w: thumb.width, h: thumb.height, top: topLeft(thumb) }, size: [created.originalWidth, created.originalHeight] };
    }, jpeg);
    // 6 = girada 90° a la derecha: el rojo (mitad izquierda guardada) queda ARRIBA y la foto pasa a ser vertical (240 x 400).
    expect(out.size).toEqual([240, 400]);
    expect(out.original.w).toBe(240);
    expect(out.original.h).toBe(400);
    expect(out.original.top[0]).toBeGreaterThan(200);
    expect(out.original.top[2]).toBeLessThan(60);
    expect(out.thumb.h).toBeGreaterThan(out.thumb.w);
    expect(out.thumb.top[0]).toBeGreaterThan(200);
  });

  test("analyzeSession: marca la hoja en blanco y la repetida, y NO el mismo formulario con otros datos", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const ids = ["text0", "dupA", "blank", "dupB", "formA", "formB", "other"];
      const pages = [];
      for (const id of ids) pages.push(await lab.make(id));
      const flags = await lab.L.realEngine.analyzeSession(pages);
      return { ids: pages.map((p: any) => p.id), flags };
    });
    const flagOf = (index: number) => out.flags[out.ids[index]];
    expect(flagOf(2).blank).toBe(true);
    expect(flagOf(3).duplicateOf).toBe(out.ids[1]);
    expect(flagOf(0).duplicateOf).toBeUndefined();
    expect(flagOf(1).duplicateOf).toBeUndefined();
    expect(flagOf(4).duplicateOf).toBeUndefined();
    expect(flagOf(5).duplicateOf, "mismo formulario con otros datos").toBeUndefined();
    expect(flagOf(6).duplicateOf).toBeUndefined();
  });

  test("detectOrientation: gira solo lo que esta de lado o cabeza abajo y no opina de una hoja en blanco", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const res: Record<string, number | null> = {};
      for (const id of ["text0", "text90", "text180", "text270", "blank"]) res[id] = await lab.L.realEngine.detectOrientation(await lab.make(id));
      return res;
    });
    for (const id of ["text0", "text90", "text180", "text270"]) expect(out[id], id).toBe(fixtures[id].neededRotation);
    expect(out.blank).toBeNull();
  });

  test("modo libro: splitSpread da DOS paginas partidas por el lomo; tarjeta con proporcion de carnet", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const book = await lab.make("book", "book");
      const [left, right] = await lab.L.realEngine.splitSpread(book);
      const card = await lab.make("id", "id-card");
      const full = await lab.L.realEngine.renderPage(card);
      return {
        ids: [left.id !== right.id, left.id !== book.id],
        sameOriginal: left.original === book.original,
        leftQuad: left.corners,
        rightQuad: right.corners,
        leftThumb: await lab.dims(left.thumb),
        cardSize: await lab.dims(full.processed),
      };
    });
    expect(out.ids).toEqual([true, true]);
    expect(out.sameOriginal).toBe(true);
    // La esquina superior derecha de la izquierda es la superior izquierda de la derecha: el lomo.
    expect(Math.abs(out.leftQuad.topRight.x - out.rightQuad.topLeft.x)).toBeLessThan(1e-6);
    expect(Math.abs(out.leftQuad.bottomRight.x - out.rightQuad.bottomLeft.x)).toBeLessThan(1e-6);
    const truth = fixtures.book.quad!;
    const spineX = (out.leftQuad.topRight.x + out.leftQuad.bottomRight.x) / 2;
    const midX = (truth.topLeft.x + truth.topRight.x + truth.bottomLeft.x + truth.bottomRight.x) / 4;
    expect(Math.abs(spineX - midX)).toBeLessThan(0.035);
    expect(Math.abs(out.cardSize.width / out.cardSize.height - 85.6 / 53.98)).toBeLessThan(0.02);
  });

  test("tareas largas: crear 8 paginas y procesar 4 a resolucion completa no bloquea el hilo principal mas de 100 ms", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      await lab.make("text0");
      const beat = lab.heartbeat();
      const pages = [];
      for (const id of ["text0", "text90", "formA", "other", "dupA", "dupB", "text180", "big"]) pages.push(await lab.make(id));
      for (const created of pages.slice(4, 8)) await lab.L.realEngine.renderPage({ ...created, filter: "enhance" });
      return { ...beat.stop(), stats: lab.L.renderStats() };
    });
    console.log(`[scan-engine] ${engineOf(page)} mayor pausa del hilo principal ${out.maxGap.toFixed(0)} ms; tareas largas ${JSON.stringify(out.longTasks)}`);
    expect(out.maxGap).toBeLessThan(100 * SLACK + 20);
    for (const duration of out.longTasks) expect(duration).toBeLessThanOrEqual(100 * SLACK + 20);
    expect(out.stats.worker).toBeGreaterThan(0);
  });

  test("sin Web Worker el motor sigue funcionando en el hilo principal (cediendo el hilo) y da la misma miniatura", async ({ page }) => {
    await openLab(page, { worker: false });
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const created = await lab.make("text0");
      const full = await lab.L.realEngine.renderPage({ ...created, filter: "enhance" });
      return { corners: !!created.corners, thumb: await lab.dims(created.thumb), processed: await lab.dims(full.processed), stats: lab.L.renderStats() };
    });
    expect(out.corners).toBe(true);
    expect(Math.max(out.thumb.width, out.thumb.height)).toBe(360);
    expect(Math.max(out.processed.width, out.processed.height)).toBeGreaterThan(500);
    expect(out.stats.worker).toBe(0);
    expect(out.stats.main).toBeGreaterThan(0);
  });

  test("cancelar: un AbortSignal aborta el procesado en curso y la cola sigue sirviendo", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const created = await lab.make("big");
      const controller = new AbortController();
      const started = performance.now();
      const pending = lab.L.realEngine.renderPage({ ...created, filter: "enhance" }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 15);
      let name = "";
      try {
        await pending;
      } catch (error) {
        name = (error as Error).name;
      }
      const afterAbort = performance.now() - started;
      // Ya abortado de antemano: ni empieza.
      const early = new AbortController();
      early.abort();
      let earlyName = "";
      try {
        await lab.L.realEngine.renderPage(created, { signal: early.signal });
      } catch (error) {
        earlyName = (error as Error).name;
      }
      const next = await lab.L.realEngine.renderPage(created, { maxSide: 360 });
      return { name, earlyName, afterAbort, thumb: !!next.thumb };
    });
    expect(out.name).toBe("AbortError");
    expect(out.earlyName).toBe("AbortError");
    expect(out.thumb).toBe(true);
  });

  test("100 paginas seguidas: sin acumular memoria (Chromium: heap de JS < 400 MB y sin crecer entre la mitad y el final)", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const ids = ["text0", "text90", "formA", "other", "dupA", "dupB", "text180", "blank"];
      let peak = 0;
      const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
      const sampler = setInterval(() => { peak = Math.max(peak, heap()); }, 25);
      const pages = [];
      let mid = 0;
      for (let i = 0; i < 100; i += 1) {
        const created = await lab.make(ids[i % ids.length]);
        // Como la interfaz: de la pagina solo se conserva lo pequeno; el original va a IndexedDB (aqui se descarta).
        pages.push({ id: created.id, thumb: created.thumb });
        if (i === 49) mid = heap();
      }
      await new Promise((r) => setTimeout(r, 200));
      clearInterval(sampler);
      return { peak, mid, end: heap(), count: pages.length };
    });
    console.log(`[scan-engine] ${engineOf(page)} 100 paginas: pico ${(out.peak / 1e6).toFixed(0)} MB, mitad ${(out.mid / 1e6).toFixed(0)} MB, final ${(out.end / 1e6).toFixed(0)} MB`);
    expect(out.count).toBe(100);
    expect(out.peak).toBeLessThan(400 * 1024 * 1024);
    // Sin fuga: la segunda mitad no dispara el uso (margen holgado: el recolector no corre a horas fijas).
    expect(out.end).toBeLessThan(out.mid + 120 * 1024 * 1024);
  });

  test("analyzeFrame en vivo: la captura automatica espera >= 700 ms de quietud, y no se dispara con una hoja borrosa ni con brillo", async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const frameOf = async (id: string, shiftPx = 0) => {
        const bitmap = await createImageBitmap(lab.blobOf(id));
        const scale = 320 / Math.max(bitmap.width, bitmap.height);
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(bitmap, shiftPx, 0, w, h);
        bitmap.close();
        return ctx.getImageData(0, 0, w, h);
      };
      const run = async (id: string, steps: number, shake = false) => {
        const tracker = lab.L.createFrameTracker();
        let previous: any;
        const verdicts = [];
        for (let i = 0; i < steps; i += 1) {
          const now = 10_000 + i * 150;
          const verdict = lab.L.analyzeLiveFrame(await frameOf(id, shake ? (i % 2) * 14 : 0), tracker, previous, now);
          previous = { quad: verdict.quad, at: now };
          verdicts.push({ t: i * 150, hint: verdict.hint, stableMs: verdict.stableMs, auto: verdict.shouldAutoCapture });
        }
        return verdicts;
      };
      return { good: await run("text0", 8), shaky: await run("text0", 8, true), blur: await run("blur", 8), glare: await run("glare", 8), none: await run("photo", 4) };
    });
    // Quieto: no dispara antes de 700 ms y si despues.
    const early = out.good.filter((v: { stableMs: number }) => v.stableMs < 700);
    expect(early.every((v: { auto: boolean }) => !v.auto)).toBe(true);
    expect(out.good.some((v: { auto: boolean }) => v.auto)).toBe(true);
    expect(out.good[0].hint).toBe("hold_steady");
    expect(out.good.at(-1)!.hint).toBe("ok");
    expect(out.shaky.some((v: { auto: boolean }) => v.auto)).toBe(false);
    expect(out.blur.some((v: { auto: boolean }) => v.auto)).toBe(false);
    expect(out.blur.at(-1)!.hint).toBe("hold_steady");
    expect(out.glare.some((v: { auto: boolean }) => v.auto)).toBe(false);
    expect(out.glare.at(-1)!.hint).toBe("glare");
  });

  test("buildPdf: una pagina por hoja con A4/Carta/Ajustar, presets y texto buscable (OCR de mentira) alineado y cancelable", async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => {
      const lab = (window as unknown as { __lab: any }).__lab;
      // Reconocedor de mentira: dos palabras con cajas conocidas (sin red: el real descarga el idioma de la CDN).
      lab.L.setOcrRecognizerFactory(async () => ({
        recognize: async (image: { width: number; height: number }) => ({
          text: "Contrato servicio",
          width: image.width,
          height: image.height,
          lines: [{ text: "Contrato servicio", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, words: [
            // Cajas con la proporcion natural de la palabra (ancho ~ 3,4 x alto): asi el texto invisible sale sin separar letras.
            { text: "Contrato", confidence: 92, bbox: { x0: image.width * 0.1, y0: image.height * 0.1, x1: image.width * 0.1 + image.height * 0.03 * 3.6, y1: image.height * 0.13 } },
            { text: "servicio", confidence: 92, bbox: { x0: image.width * 0.5, y0: image.height * 0.1, x1: image.width * 0.5 + image.height * 0.03 * 3.3, y1: image.height * 0.13 } },
          ] }],
        }),
        dispose: async () => {},
      }));
    });
    const run = async (searchable: boolean, pageSize: string, preset: string) => {
      const out = await page.evaluate(
        async (arg) => {
          const lab = (window as unknown as { __lab: any }).__lab;
          const pages = [];
          for (const id of ["text0", "formA", "blank"]) pages.push(await lab.make(id));
          const progress: number[][] = [];
          const blob = await lab.L.realEngine.buildPdf(
            { id: "sc-test-0001", createdAt: "", updatedAt: "", name: "t", pages, settings: lab.settings("document", { searchable: arg.searchable }) },
            { preset: arg.preset, pageSize: arg.pageSize, margin: "small", onProgress: (d: number, t: number) => progress.push([d, t]) },
          );
          return { b64: await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.readAsDataURL(blob); }), progress, type: blob.type, estimate: lab.L.realEngine.estimateSize(pages, { preset: arg.preset, searchable: arg.searchable }) };
        },
        { searchable, pageSize, preset },
      );
      return { bytes: Buffer.from(out.b64, "base64"), progress: out.progress, estimate: out.estimate };
    };
    const plain = await run(false, "a4", "balanced");
    expect(await getPageCount(plain.bytes)).toBe(3);
    expect(plain.progress.at(-1)).toEqual([6, 6]);
    expect(plain.progress.every(([d, t], i) => t === 6 && (i === 0 || d >= plain.progress[i - 1][0]))).toBe(true);
    expect((await getTextItems(plain.bytes, 1)).length).toBe(0);
    const searchable = await run(true, "a4", "balanced");
    expect(await getPageCount(searchable.bytes)).toBe(3);
    expect(searchable.progress.at(-1)).toEqual([9, 9]);
    const items = await getTextItems(searchable.bytes, 1);
    expect(items.map((item) => item.str).join(" ")).toContain("Contrato");
    expect(items.map((item) => item.str).join(" ")).toContain("servicio");
    const word = items.find((item) => item.str.includes("Contrato"))!;
    // Pagina A4 (595 x 842): la palabra cae en el 10-14 % superior de la imagen centrada, no fuera de la hoja.
    expect(word.x).toBeGreaterThan(0);
    expect(word.x).toBeLessThan(300);
    expect(word.y).toBeGreaterThan(842 * 0.6);
    const compact = await run(false, "fit", "compact");
    const original = await run(false, "fit", "original");
    expect(await getPageCount(compact.bytes)).toBe(3);
    expect(compact.bytes.length).toBeLessThanOrEqual(original.bytes.length);
    // La estimacion es de orden de magnitud correcto: entre 1/3 y 3 veces el peso real.
    expect(plain.estimate.bytes).toBeGreaterThan(plain.bytes.length / 3);
    expect(plain.estimate.bytes).toBeLessThan(plain.bytes.length * 3);
    expect(plain.estimate.low).toBeLessThan(plain.estimate.high);
    // Cancelar a mitad de camino.
    const cancelled = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const pages = [await lab.make("text0"), await lab.make("formA"), await lab.make("other")];
      const controller = new AbortController();
      try {
        await lab.L.realEngine.buildPdf(
          { id: "sc-test-0002", createdAt: "", updatedAt: "", name: "t", pages, settings: lab.settings("document", { searchable: true }) },
          { preset: "balanced", pageSize: "a4", margin: "none", signal: controller.signal, onProgress: (done: number) => { if (done >= 2) controller.abort(); } },
        );
        return "finished";
      } catch (error) {
        return (error as { code?: string }).code ?? (error as Error).name;
      }
    });
    expect(cancelled).toBe("cancelled");
  });

  test("suggestName: titulo del primer texto (OCR de mentira) + fecha; sin OCR, «Escaneo AAAA-MM-DD HH.mm»; nada de red", async ({ page }) => {
    const requests = trackRequests(page);
    await openLab(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const created = await lab.make("text0");
      lab.L.setOcrRecognizerFactory(async () => ({
        recognize: async (image: { width: number; height: number }) => ({
          text: "AJUSTADORES DEL NORTE\nCONTRATO DE SERVICIO\nFecha: 12 de marzo de 2026",
          width: image.width,
          height: image.height,
          lines: [
            { text: "AJUSTADORES DEL NORTE", confidence: 90, bbox: { x0: 10, y0: 10, x1: 300, y1: 30 }, words: [{ text: "AJUSTADORES", confidence: 90, bbox: { x0: 10, y0: 10, x1: 150, y1: 30 } }, { text: "DEL", confidence: 90, bbox: { x0: 160, y0: 10, x1: 200, y1: 30 } }, { text: "NORTE", confidence: 90, bbox: { x0: 210, y0: 10, x1: 300, y1: 30 } }] },
            { text: "CONTRATO DE SERVICIO", confidence: 90, bbox: { x0: 10, y0: 60, x1: 400, y1: 110 }, words: [{ text: "CONTRATO", confidence: 90, bbox: { x0: 10, y0: 60, x1: 180, y1: 110 } }, { text: "DE", confidence: 90, bbox: { x0: 190, y0: 60, x1: 230, y1: 110 } }, { text: "SERVICIO", confidence: 90, bbox: { x0: 240, y0: 60, x1: 400, y1: 110 } }] },
          ],
        }),
        dispose: async () => {},
      }));
      const withOcr = await lab.L.realEngine.suggestName([created], "es");
      lab.L.setOcrRecognizerFactory(async () => { throw new Error("sin red para el idioma"); });
      const without = await lab.L.realEngine.suggestName([created], "es");
      return { withOcr, without };
    });
    expect(out.withOcr.title).toBe("Contrato de servicio");
    expect(out.withOcr.source).toBe("ocr");
    expect(out.withOcr.name).toMatch(/^Contrato de servicio · \d{4}-\d{2}-\d{2}$/);
    expect(out.without.title).toBeNull();
    expect(out.without.source).toBe("date");
    expect(out.without.name).toMatch(/^Escaneo \d{4}-\d{2}-\d{2} \d{2}\.\d{2}$/);
    expect(requests.external, requests.external.join("\n")).toEqual([]);
  });
});

