import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import { computeFingerprintWith } from "../../src/lib/docLibrary/fingerprintEngine";
import { hammingDistance } from "../../src/lib/docLibrary/fingerprintCore";
import { nodeEnv } from "../../src/lib/docLibrary/testing/nodeEnv";
import {
  buildContractModel,
  changeParagraph,
  encryptWithPassword,
  makeContractPdf,
  makeManyPagesPdf,
  makeScannedPdf,
  renderContract,
  reorderObjects,
  resave,
  truncate,
} from "../../src/lib/docLibrary/testing/syntheticContracts";

/**
 * Huella y almacén de la biblioteca de documentos (U2.1) en un NAVEGADOR REAL y headless (Chromium y WebKit iPad): lo
 * que Vitest/Node no puede probar: pdf.js dentro de un Web Worker (sin DOM), OffscreenCanvas, IndexedDB y
 * BroadcastChannel de verdad, rendimiento y tareas largas del hilo principal.
 *
 * PATRON (sin pagina de pruebas en el producto, igual que `ink-extract.spec.ts`): `e2e/helpers/doc-library-entry.ts` y
 * `fingerprint.worker.ts` se empaquetan al vuelo con Vite (IIFE, en memoria) y se inyectan en una pagina CUALQUIERA de la
 * app (`/privacy`, con su CSP real). El worker se crea desde un Blob; pdf.js sigue sirviendo su propio worker desde
 * `/pdf.worker.min.mjs` (el real de `public/`). Los PDF son SINTETICOS (pdf-lib) y se generan en Node.
 */

test.setTimeout(180_000);

let mainBundle = "";
let workerBundle = "";

async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: path.resolve(process.cwd(), entry), name, formats: ["iife"], fileName: () => `${name}.js` },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`no se pudo empaquetar ${entry}`);
  return chunk.code;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Fixtures = Record<string, string>;
const fixtures: Fixtures = {};
let nodeFingerprint: Awaited<ReturnType<typeof computeFingerprintWith>>;
let nodeScanFingerprint: Awaited<ReturnType<typeof computeFingerprintWith>>;

test.beforeAll(async () => {
  mainBundle = await bundle("e2e/helpers/doc-library-entry.ts", "DocLib");
  workerBundle = await bundle("src/lib/docLibrary/fingerprint.worker.ts", "FpWorker");

  const model = buildContractModel({ seed: 1, pages: 6, shareCommon: true });
  const contract = await renderContract(model);
  const changed = changeParagraph(changeParagraph(changeParagraph(model, 2, 0, 71), 2, 1, 72), 2, 2, 73);
  const other = await makeContractPdf({ seed: 2, pages: 6, shareCommon: true });
  const scan = await makeScannedPdf({ seed: 5, pages: 2 });
  fixtures.contract = b64(contract);
  fixtures.resaved = b64(await resave(contract));
  fixtures.objectStreams = b64(await resave(contract, { useObjectStreams: true }));
  fixtures.reordered = b64(await reorderObjects(contract));
  fixtures.changedPage = b64(await renderContract(changed));
  fixtures.other = b64(other);
  fixtures.scan = b64(scan);
  fixtures.scanNoisy = b64(await makeScannedPdf({ seed: 5, pages: 2, noise: 8, shift: { x: 2, y: 2 }, quality: 60 }));
  fixtures.encrypted = b64(await encryptWithPassword(await makeContractPdf({ seed: 3, pages: 2 }), "secreto"));
  fixtures.truncated = b64(truncate(contract, 0.4));
  fixtures.notPdf = b64(new TextEncoder().encode("esto no es un pdf"));
  fixtures.many201 = b64(await makeManyPagesPdf(201));
  // 100 páginas con la densidad de un contrato real (5 párrafos por página ≈ 330 palabras).
  fixtures.hundred = b64(await renderContract(buildContractModel({ seed: 9, pages: 100 })));
  fixtures.scan6 = b64(await makeScannedPdf({ seed: 7, pages: 6 }));
  nodeFingerprint = await computeFingerprintWith(contract, nodeEnv());
  nodeScanFingerprint = await computeFingerprintWith(scan, nodeEnv());
});

async function prepare(page: Page): Promise<void> {
  await page.goto("/privacy");
  await page.addScriptTag({ content: mainBundle });
  await page.evaluate(
    ({ code, files }) => {
      const w = window as unknown as Record<string, unknown> & { DocLib: { setFingerprintWorkerFactory(f: () => Worker): void } };
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      let created = 0;
      w.__workersCreated = () => created;
      w.DocLib.setFingerprintWorkerFactory(() => {
        created += 1;
        return new Worker(url);
      });
      const bytes = (name: string): Uint8Array => Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
      w.__bytes = bytes;
    },
    { code: workerBundle, files: fixtures },
  );
}

/** Tipos mínimos de lo que la página expone (el bundle real vive solo en el navegador). */
type Mode = "always" | "never";

async function fingerprints(page: Page, names: string[], worker: Mode) {
  return page.evaluate(
    async ({ names: list, worker: mode }) => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const out: Record<string, unknown> = {};
      for (const name of list) out[name] = await w.DocLib.computeFingerprint(w.__bytes(name), { worker: mode });
      return out;
    },
    { names, worker },
  );
}

test.describe("huella en el navegador", () => {
  test.beforeEach(async ({ page }) => {
    await prepare(page);
  });

  for (const mode of ["always", "never"] as const) {
    test(`texto: ${mode === "always" ? "en worker" : "en el hilo principal"} da la MISMA huella que Node`, async ({ page }) => {
      const out = (await fingerprints(page, ["contract"], mode)) as { contract: typeof nodeFingerprint };
      const used = await page.evaluate(() => (window as unknown as { __workersCreated: () => number }).__workersCreated());
      expect(used).toBe(mode === "always" ? 1 : 0);
      expect(out.contract.exact).toBe(nodeFingerprint.exact);
      expect(out.contract.pageCount).toBe(6);
      expect(out.contract.pageSizes).toEqual(nodeFingerprint.pageSizes);
      expect(out.contract.pages.map((p) => p.textHash)).toEqual(nodeFingerprint.pages.map((p) => p.textHash));
      expect(out.contract.pages.map((p) => p.minhash)).toEqual(nodeFingerprint.pages.map((p) => p.minhash));
    });

    test(`escaneado: ${mode === "always" ? "en worker (OffscreenCanvas)" : "en el hilo principal"} ≤ 10 bits de Node y con ruido+2 px ≤ 10 bits`, async ({ page }) => {
      const out = (await fingerprints(page, ["scan", "scanNoisy"], mode)) as Record<"scan" | "scanNoisy", typeof nodeScanFingerprint>;
      for (const [index, pageFp] of out.scan.pages.entries()) {
        expect(pageFp.textHash).toBe("");
        expect(pageFp.dhash).toMatch(/^[0-9a-f]{16}$/);
        expect(hammingDistance(pageFp.dhash!, nodeScanFingerprint.pages[index].dhash!)).toBeLessThanOrEqual(10);
        expect(hammingDistance(pageFp.dhash!, out.scanNoisy.pages[index].dhash!)).toBeLessThanOrEqual(10);
      }
    });
  }

  test("worker y hilo principal dan resultados idénticos", async ({ page }) => {
    const worker = await fingerprints(page, ["contract", "changedPage", "scan"], "always");
    const main = await fingerprints(page, ["contract", "changedPage", "scan"], "never");
    expect(worker.contract).toEqual(main.contract);
    expect(worker.changedPage).toEqual(main.changedPage);
    expect(worker.scan).toEqual(main.scan);
  });

  test("auto: usa el worker y, si no puede arrancar, cae al hilo principal con el mismo resultado", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => unknown>; __bytes: (n: string) => Uint8Array; __workersCreated: () => number };
      const viaWorker = await (w.DocLib.computeFingerprint(w.__bytes("contract")) as Promise<unknown>);
      const created = w.__workersCreated();
      w.DocLib.setFingerprintWorkerFactory(() => {
        throw new Error("sin workers");
      });
      const fallback = await (w.DocLib.computeFingerprint(w.__bytes("contract")) as Promise<unknown>);
      w.DocLib.setFingerprintWorkerFactory(() => new Worker(URL.createObjectURL(new Blob(["throw new Error('no arranca')"]))));
      const broken = await (w.DocLib.computeFingerprint(w.__bytes("contract")) as Promise<unknown>);
      let strict = "no falló";
      try {
        await (w.DocLib.computeFingerprint(w.__bytes("contract"), { worker: "always" }) as Promise<unknown>);
      } catch (error) {
        strict = (error as { code?: string }).code ?? String(error);
      }
      return { created, same: JSON.stringify(viaWorker) === JSON.stringify(fallback) && JSON.stringify(viaWorker) === JSON.stringify(broken), strict };
    });
    expect(result.created).toBe(1);
    expect(result.same).toBe(true);
    expect(result.strict).toBe("unavailable");
  });

  test("re-exportaciones coinciden; otro contrato no; una página cambiada se señala", async ({ page }) => {
    const names = ["contract", "resaved", "objectStreams", "reordered", "changedPage", "other"];
    const out = (await page.evaluate(
      async ({ list }) => {
        const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => unknown>; __bytes: (n: string) => Uint8Array };
        const fps: Record<string, unknown> = {};
        for (const name of list) fps[name] = await (w.DocLib.computeFingerprint(w.__bytes(name)) as Promise<unknown>);
        const compare = (name: string) => w.DocLib.compareFingerprints(fps[name], fps.contract) as { level: string; percent: number; reviewPages: number[]; mappedPages: Array<number | null> };
        return { exactSelf: (w.DocLib.compareFingerprints(fps.contract, fps.contract) as { level: string }).level, resaved: compare("resaved"), objectStreams: compare("objectStreams"), reordered: compare("reordered"), changedPage: compare("changedPage"), other: compare("other") };
      },
      { list: names },
    )) as Record<string, { level: string; percent: number; reviewPages: number[]; mappedPages: Array<number | null> } | string>;
    expect(out.exactSelf).toBe("exact");
    for (const name of ["resaved", "objectStreams", "reordered"]) {
      expect(out[name]).toMatchObject({ level: "match", percent: 100, reviewPages: [] });
    }
    expect(out.changedPage).toMatchObject({ level: "similar", reviewPages: [2], mappedPages: [0, 1, null, 3, 4, 5] });
    expect(out.other).toMatchObject({ level: "none" });
  });

  test("errores claros: cifrado, dañado, no es PDF y vacío (en worker y en el hilo principal)", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const codes: Record<string, string> = {};
      for (const mode of ["always", "never"]) {
        for (const name of ["encrypted", "truncated", "notPdf", "empty"]) {
          try {
            await w.DocLib.computeFingerprint(name === "empty" ? new Uint8Array() : w.__bytes(name), { worker: mode });
            codes[`${mode}:${name}`] = "sin error";
          } catch (error) {
            codes[`${mode}:${name}`] = `${(error as { code?: string }).code}|${(error as Error).message}`;
          }
        }
      }
      return codes;
    });
    for (const mode of ["always", "never"]) {
      expect(out[`${mode}:encrypted`]).toMatch(/^encrypted\|.*contraseña/);
      expect(out[`${mode}:truncated`]).toMatch(/^corrupt\|/);
      expect(out[`${mode}:notPdf`]).toMatch(/^corrupt\|/);
      expect(out[`${mode}:empty`]).toMatch(/^empty\|/);
    }
  });

  test("más de 200 páginas: huella parcial (solo exact + pageCount)", async ({ page }) => {
    for (const mode of ["always", "never"] as const) {
      const out = (await fingerprints(page, ["many201"], mode)) as { many201: { partial?: string; pageCount: number; pages: unknown[]; exact: string } };
      expect(out.many201).toMatchObject({ partial: "tooManyPages", pageCount: 201, pages: [] });
      expect(out.many201.exact).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("cancelable: abortar a mitad termina el worker y rechaza con «aborted» sin dejar la página colgada", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const results: Record<string, string> = {};
      for (const mode of ["always", "never"]) {
        const controller = new AbortController();
        const started = performance.now();
        const promise = w.DocLib.computeFingerprint(w.__bytes("hundred"), {
          worker: mode,
          signal: controller.signal,
          onProgress: (done: number) => {
            if (done >= 3) controller.abort();
          },
        });
        try {
          await promise;
          results[mode] = "terminó";
        } catch (error) {
          results[mode] = `${(error as { code?: string }).code}@${Math.round(performance.now() - started)}`;
        }
      }
      const pre = new AbortController();
      pre.abort();
      try {
        await w.DocLib.computeFingerprint(w.__bytes("hundred"), { signal: pre.signal });
      } catch (error) {
        results.pre = (error as { code?: string }).code ?? "?";
      }
      return results;
    });
    expect(out.always).toMatch(/^aborted@/);
    expect(out.never).toMatch(/^aborted@/);
    expect(out.pre).toBe("aborted");
  });

  test("rendimiento: 6 páginas < 400 ms y 100 páginas < 5 s; sin tareas largas > 100 ms en el hilo principal", async ({ page }, testInfo) => {
    const out = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const timeIt = async (name: string, mode: string) => {
        const t0 = performance.now();
        await w.DocLib.computeFingerprint(w.__bytes(name), { worker: mode });
        return Math.round(performance.now() - t0);
      };
      /** Mayor hueco entre ticks de 10 ms mientras se ejecuta `fn`: lo que vería la persona como la página «congelada». */
      const withTicker = async (fn: () => Promise<unknown>) => {
        let last = performance.now();
        let worst = 0;
        const long: number[] = [];
        let observer: PerformanceObserver | null = null;
        try {
          observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => long.push(entry.duration)));
          observer.observe({ type: "longtask", buffered: false });
        } catch {
          observer = null; // WebKit no tiene longtask
        }
        const timer = setInterval(() => {
          const now = performance.now();
          worst = Math.max(worst, now - last - 10);
          last = now;
        }, 10);
        await fn();
        clearInterval(timer);
        observer?.disconnect();
        return { worstGap: Math.round(worst), longTasks: long.map(Math.round), hasLongTask: observer !== null };
      };
      const result: Record<string, unknown> = {};
      for (const mode of ["always", "never"]) {
        const scan6 = await timeIt("scan6", mode);
        const cold6 = await timeIt("contract", mode);
        const warm6 = [await timeIt("contract", mode), await timeIt("contract", mode), await timeIt("contract", mode)];
        let hundred = 0;
        const gap = await withTicker(async () => {
          hundred = await timeIt("hundred", mode);
        });
        result[mode] = { cold6, warm6, hundred, scan6, ...gap };
      }
      return result;
    });
    testInfo.annotations.push({ type: "rendimiento", description: JSON.stringify(out) });
    console.info(`[doc-fingerprint] ${testInfo.project.name} ${JSON.stringify(out)}`);
    for (const mode of ["always", "never"] as const) {
      const m = out[mode] as { warm6: number[]; hundred: number; scan6: number; worstGap: number; longTasks: number[] };
      expect(m.scan6, `6 páginas escaneadas (${mode})`).toBeLessThan(3000);
      expect(Math.min(...m.warm6), `6 páginas (${mode})`).toBeLessThan(400);
      expect(m.hundred, `100 páginas (${mode})`).toBeLessThan(5000);
      expect(m.worstGap, `mayor hueco del hilo principal (${mode})`).toBeLessThan(100);
      expect(Math.max(0, ...m.longTasks), `tareas largas (${mode})`).toBeLessThan(100);
    }
  });
});

test.describe("almacén en el navegador", () => {
  test.beforeEach(async ({ page }) => {
    await prepare(page);
    await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>> };
      await w.DocLib.clearLibrary();
    });
  });

  test("guardar, recargar y reconocer el mismo contrato re-exportado", async ({ page }) => {
    const saved = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const bytes = w.__bytes("contract");
      const fingerprint = (await w.DocLib.computeFingerprint(bytes)) as { pageCount: number; pageSizes: unknown[] };
      const entry = (await w.DocLib.putDocument(
        { id: "contrato-1", name: "Contrato de servicio", docType: "contrato", fileName: "contrato.pdf", pageCount: fingerprint.pageCount, pageSizes: fingerprint.pageSizes, fingerprint, templateIds: [] },
        bytes,
      )) as { rev: number; byteLength: number };
      const persistence = await w.DocLib.requestPersistence();
      return { rev: entry.rev, byteLength: entry.byteLength, persistence };
    });
    expect(saved.rev).toBe(1);
    expect(saved.byteLength).toBeGreaterThan(1000);
    expect(typeof (saved.persistence as { supported: boolean }).supported).toBe("boolean");

    await prepare(page); // «recargar»: página nueva, mismo origen
    const after = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const listed = (await w.DocLib.listDocuments()) as { available: boolean; documents: Array<{ id: string; fingerprint: unknown; updatedAt: string }>; skipped: unknown[] };
      const stored = await w.DocLib.getDocumentBytes("contrato-1");
      const original = w.__bytes("contract");
      const same = stored instanceof Uint8Array && stored.length === original.length && stored.every((v, i) => v === original[i]);
      const reexported = await w.DocLib.computeFingerprint(w.__bytes("resaved"));
      const best = (await w.DocLib.findBestMatch(
        reexported,
        listed.documents.map((d) => ({ id: d.id, fingerprint: d.fingerprint, updatedAt: d.updatedAt })),
      )) as { level: string; candidateId: string; ambiguous: boolean; reviewPages: number[] } | null;
      const meta = (await w.DocLib.getLibraryMeta()) as { persistence: { supported: boolean } | null };
      const usage = (await w.DocLib.estimateUsage()) as { documents: number; bytes: number };
      return { available: listed.available, count: listed.documents.length, skipped: listed.skipped.length, same, best, rememberedPersistence: meta.persistence !== null, usage };
    });
    expect(after).toMatchObject({ available: true, count: 1, skipped: 0, same: true, rememberedPersistence: true });
    expect(after.best).toMatchObject({ level: "match", candidateId: "contrato-1", ambiguous: false, reviewPages: [] });
    expect(after.usage.documents).toBe(1);
  });

  test("dos pestañas: la de la versión vieja recibe «conflict» y la otra se entera por BroadcastChannel", async ({ page, context }) => {
    await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const fingerprint = (await w.DocLib.computeFingerprint(w.__bytes("contract"))) as { pageCount: number; pageSizes: unknown[] };
      await w.DocLib.putDocument({ id: "compartido", name: "Original", docType: "", fileName: "c.pdf", pageCount: fingerprint.pageCount, pageSizes: fingerprint.pageSizes, fingerprint, templateIds: [] }, w.__bytes("contract"));
      (window as unknown as { __notified: number }).__notified = 0;
      w.DocLib.subscribeToLibrary(() => {
        (window as unknown as { __notified: number }).__notified += 1;
      });
    });
    const second = await context.newPage();
    await prepare(second);
    const fromSecond = await second.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>> };
      const entry = (await w.DocLib.getDocument("compartido")) as { rev: number };
      await w.DocLib.renameDocument("compartido", "Nombre de la segunda pestaña", { expectedRev: entry.rev });
      return entry.rev;
    });
    expect(fromSecond).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __notified: number }).__notified)).toBeGreaterThan(0);
    const firstResult = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>> };
      try {
        await w.DocLib.renameDocument("compartido", "Nombre de la primera", { expectedRev: 1 });
        return "pisó";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(firstResult).toBe("conflict");
    const final = await page.evaluate(async () => ((await (window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>> }).DocLib.getDocument("compartido")) as { name: string; rev: number }));
    expect(final).toMatchObject({ name: "Nombre de la segunda pestaña", rev: 2 });
    await second.close();
  });

  test("límites en el navegador: 100 MiB + 1 es «tooBig» y la biblioteca sigue vacía", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const w = window as unknown as { DocLib: Record<string, (...args: unknown[]) => Promise<unknown>>; __bytes: (n: string) => Uint8Array };
      const fingerprint = (await w.DocLib.computeFingerprint(w.__bytes("contract"))) as { pageCount: number; pageSizes: unknown[] };
      try {
        await w.DocLib.putDocument(
          { id: "enorme", name: "Enorme", docType: "", fileName: "e.pdf", pageCount: fingerprint.pageCount, pageSizes: fingerprint.pageSizes, fingerprint, templateIds: [] },
          new Uint8Array(100 * 1024 * 1024 + 1),
        );
        return { code: "sin error", count: -1 };
      } catch (error) {
        const listed = (await w.DocLib.listDocuments()) as { documents: unknown[] };
        return { code: (error as { code?: string }).code, count: listed.documents.length };
      }
    });
    expect(out).toEqual({ code: "tooBig", count: 0 });
  });
});
