import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, test } from "../helpers/tool-flow";
import { downloadBytes } from "../helpers/downloads";
import { makeViewerPdf } from "../helpers/viewer-pdfs";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · memoria y escritura con documentos grandes (Wave 9), navegador real y headless, build de produccion.
 *
 *  - Bytes escritos: con un PDF de ~40 MB, cada paso del historial y del borrador se guarda TROCEADO por contenido y
 *    solo se escribe lo que cambio (~7 % del documento), no 40 MB por paso.
 *  - Borrador en el peor momento: recargar justo despues de aplicar un cambio (mientras el borrador se escribe) NUNCA deja
 *    un borrador roto: lo que se retoma es el paso anterior o el nuevo, entero y legible.
 *  - Cuota agotada a mitad del historial: el documento avisa, no pierde ningun paso y se deshace EXACTO hasta el original.
 *  - Visor por rangos: un PDF grande se abre sin copiarlo entero al worker de pdf.js y se pinta igual que con la apertura
 *    de siempre.
 */

const S = PRO_STRINGS.es;
const FLAGS = { hot: "optimuspdf.pro.historyHotBytes", range: "optimuspdf.pro.viewerRangeMinBytes" };
const HISTORY_PREFIX = "optimuspdf-pro-history-";
const DRAFTS_DB = "optimuspdf-pro-drafts";
const MB = 1024 * 1024;

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(240_000);

const tmp = path.resolve(process.cwd(), ".evidence/pro-memory-tmp");
let bigFile = "";
let bigBytes: Buffer;

test.beforeAll(async () => {
  mkdirSync(tmp, { recursive: true });
  bigBytes = await makeViewerPdf(120, { noiseKb: 330 });
  expect(bigBytes.length).toBeGreaterThan(38 * MB);
  bigFile = path.join(tmp, "grande.pdf");
  writeFileSync(bigFile, bigBytes);
});

/** Cuenta los bytes que la aplicacion le pide escribir a IndexedDB, por base (api: `put` y `add`). */
async function countIdbWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: Record<string, number> = {};
    const sizeOf = (value: unknown, depth = 0): number => {
      if (value == null) return 0;
      if (value instanceof Blob) return value.size;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (depth < 3 && typeof value === "object") return Object.values(value as object).reduce<number>((sum, item) => sum + sizeOf(item, depth + 1), 0);
      return 0;
    };
    for (const method of ["put", "add"] as const) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function patched(this: IDBObjectStore, ...args: Parameters<typeof original>) {
        try {
          const db = this.transaction.db.name.replace(/-[0-9a-f-]{8,}$/, "-*");
          writes[db] = (writes[db] ?? 0) + sizeOf(args[0]);
        } catch {
          /* solo medida */
        }
        return original.apply(this, args as never);
      } as typeof original;
    }
    (window as unknown as { __idbWrites: () => Record<string, number> }).__idbWrites = () => ({ ...writes });
  });
}

const idbWrites = (page: Page) => page.evaluate(() => (window as unknown as { __idbWrites: () => Record<string, number> }).__idbWrites());

async function expectNewAnnouncement(page: Page, action: () => Promise<void>, pattern: RegExp): Promise<string> {
  await page.evaluate(() => {
    const span = document.querySelector('[role="status"] span') as (HTMLElement & { __seen?: boolean }) | null;
    if (span) span.__seen = true;
  });
  await action();
  let text = "";
  await expect
    .poll(
      async () => {
        text = await page.evaluate(() => {
          const span = document.querySelector('[role="status"] span') as (HTMLElement & { __seen?: boolean }) | null;
          return span && !span.__seen ? (span.textContent ?? "") : "";
        });
        return pattern.test(text);
      },
      { timeout: 120_000, intervals: [50] },
    )
    .toBe(true);
  return text;
}

async function openBig(page: Page): Promise<void> {
  await page.goto("/pdf-pro");
  await page.locator('input[type="file"]').first().setInputFiles(bigFile);
  await expect(page.getByRole("heading", { level: 1, name: /grande\.pdf/ })).toBeVisible();
  await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 120_000 });
  await page.locator('[role="tab"][data-tab="home"]').click();
}

async function rotateOnce(page: Page, pattern: RegExp = /^Aplicado:/): Promise<void> {
  await expectNewAnnouncement(page, () => page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click(), pattern);
}

/** Pasos (`steps`) y tamaño del borrador guardado, y si es troceado (manifiesto `~m:`), leidos de la base real. */
async function draftInfo(page: Page): Promise<{ steps: number; size: number; chunked: boolean; chunks: number }[]> {
  return page.evaluate(
    (name) =>
      new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("draftMeta")) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction(["draftMeta", "draftFiles"], "readonly");
          const metas = tx.objectStore("draftMeta").getAll();
          const keys = tx.objectStore("draftFiles").getAllKeys();
          tx.oncomplete = () => {
            db.close();
            const all = keys.result as string[];
            resolve(
              (metas.result as { id: string; steps: number; fileSize: number }[]).map((meta) => ({
                steps: meta.steps,
                size: meta.fileSize,
                chunked: all.includes(`~m:${meta.id}`),
                chunks: all.filter((key) => key.startsWith("~c:")).length,
              })),
            );
          };
        };
      }),
    DRAFTS_DB,
  );
}

/** Rotacion de la primera pagina del PDF descargado (el documento ACTUAL). */
async function downloadedFirstRotation(page: Page): Promise<{ rotation: number; bytes: Buffer }> {
  const bytes = await downloadBytes(page, () => page.getByRole("button", { name: S.suite.download, exact: true }).click());
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return { rotation: document.getPage(0).getRotation().angle, bytes };
}

test.describe.serial("PDF Pro · documentos grandes", () => {
  test("escritura: cada paso de un PDF de 40 MB escribe solo lo que cambia (borrador e historial), y todo se recupera exacto", async ({ page }) => {
    await countIdbWrites(page);
    // Ventana caliente a 0: todo lo que no sea el actual y el anterior se vuelca a disco (aqui se mide ese volcado).
    await page.addInitScript((key) => window.localStorage.setItem(key, "0"), FLAGS.hot);
    await openBig(page);
    for (let i = 1; i <= 4; i += 1) {
      await rotateOnce(page);
      // El autoguardado (600 ms de calma + plan de trozos + escritura) llega a escribir cada paso.
      await expect.poll(async () => (await draftInfo(page))[0]?.steps, { timeout: 60_000 }).toBe(i);
    }
    const written = await idbWrites(page);
    const draftMb = (written[DRAFTS_DB] ?? 0) / MB;
    const historyMb = (written[`${HISTORY_PREFIX}*`] ?? 0) / MB;
    // Sin trocear serian 4 pasos × ~40 MB = 160 MB solo de borrador (y otro tanto de historial).
    expect(draftMb, `borrador: ${draftMb.toFixed(1)} MB escritos`).toBeLessThan(80);
    expect(draftMb).toBeGreaterThan(30); // la primera vez si se escribe entero
    const [draft] = await draftInfo(page);
    expect(draft.chunked).toBe(true);
    expect(draft.size).toBeGreaterThan(38 * MB);
    // El historial: el original + 2 volcados mas (4 pasos de 5 con la ventana de 2) son ~40 MB la primera vez y poco mas despues.
    expect(historyMb, `historial: ${historyMb.toFixed(1)} MB escritos`).toBeLessThan(80);
    console.log(`[pro-memory] borrador ${draftMb.toFixed(1)} MB, historial ${historyMb.toFixed(1)} MB para 4 pasos de un PDF de ${(bigBytes.length / MB).toFixed(1)} MB`);

    // Deshacer hasta el original y rehacer hasta el final: cada extremo es EXACTO.
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    for (let i = 4; i >= 1; i -= 1) {
      await expectNewAnnouncement(page, () => page.keyboard.press("Control+z"), /^Deshecho:/);
      await expect(page.locator(`[data-history-index="${i - 1}"]`)).toHaveAttribute("aria-current", "step");
    }
    const original = await downloadedFirstRotation(page);
    expect(original.rotation).toBe(0);
    // El documento original vuelve idéntico (mismo contenido, byte a byte) tras pasar por disco.
    expect(createHash("sha256").update(original.bytes).digest("hex")).toBe(createHash("sha256").update(bigBytes).digest("hex"));
    for (let i = 1; i <= 4; i += 1) await expectNewAnnouncement(page, () => page.keyboard.press("Control+Shift+z"), /^Rehecho:/);
    expect((await downloadedFirstRotation(page)).rotation).toBe(0); // 4 × 90° = 360° ≡ 0°
  });

  test("deshacer y rehacer EN FRIO (PDF de 40 MB): leen de disco solo los trozos que cambian y cada paso vuelve EXACTO", async ({ page }) => {
    // Ventana caliente a 0: solo el actual y el anterior estan en RAM; saltar y rehacer son siempre lecturas de disco.
    await page.addInitScript(
      ([hotKey, prefix]) => {
        window.localStorage.setItem(hotKey, "0");
        const counter = { chunkGets: 0 };
        const original = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function patched(this: IDBObjectStore, ...args: Parameters<typeof original>) {
          const key = args[0];
          if (this.transaction.db.name.startsWith(prefix) && typeof key === "string" && key.startsWith("~c:")) counter.chunkGets += 1;
          return original.apply(this, args as never);
        } as typeof original;
        (window as unknown as { __chunkReads: (reset?: boolean) => number }).__chunkReads = (reset) => {
          const value = counter.chunkGets;
          if (reset) counter.chunkGets = 0;
          return value;
        };
      },
      [FLAGS.hot, HISTORY_PREFIX] as const,
    );
    const chunkReads = (reset = true) => page.evaluate((flag) => (window as unknown as { __chunkReads: (reset?: boolean) => number }).__chunkReads(flag), reset);
    await openBig(page);
    for (let i = 1; i <= 4; i += 1) await rotateOnce(page);
    // El plan de trozos de cada paso se calcula en reposo (como tarde 1,5 s tras nacer) y el volcado a disco lo necesita.
    await page.waitForTimeout(5000);
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    await chunkReads();

    // Salto en frio al original: sin copiar de la RAM serian TODOS los trozos del documento (~800 de ~48 KB).
    await expectNewAnnouncement(page, () => page.locator('[data-history-index="0"]').click(), /^(Deshecho|Vuelto a):/);
    await expect(page.locator('[data-history-index="0"]')).toHaveAttribute("aria-current", "step");
    const jumpReads = await chunkReads();
    console.log(`[pro-memory] salto en frio al original: ${jumpReads} trozos leidos de disco`);
    expect(jumpReads, "el salto lee de disco solo lo que difiere de lo que hay en RAM").toBeLessThan(300);
    const original = await downloadedFirstRotation(page);
    expect(original.rotation).toBe(0);
    expect(createHash("sha256").update(original.bytes).digest("hex")).toBe(createHash("sha256").update(bigBytes).digest("hex"));
    await chunkReads();

    // Rehacer paso a paso: cada uno es en frio y vuelve exacto (la rotacion de la primera pagina es la del paso).
    for (let step = 1; step <= 4; step += 1) {
      await expectNewAnnouncement(page, () => page.keyboard.press("Control+Shift+z"), /^Rehecho:/);
      await expect(page.locator(`[data-history-index="${step}"]`)).toHaveAttribute("aria-current", "step");
      const reads = await chunkReads();
      expect(reads, `rehacer al paso ${step}: ${reads} trozos leidos`).toBeLessThan(300);
      const here = await downloadedFirstRotation(page);
      expect(here.rotation, `paso ${step}`).toBe((step * 90) % 360);
      expect((await PDFDocument.load(here.bytes, { updateMetadata: false })).getPageCount()).toBe(120);
      await chunkReads();
      // Dejar que el reequilibrio termine antes del siguiente (el siguiente rehacer vuelve a ser en frio).
      await page.waitForTimeout(800);
    }
  });

  test("una operacion sobre un PDF de 40 MB no crea ningun Blob del tamaño del documento ni lee uno de vuelta (bytes de punta a punta)", async ({ page }) => {
    // Cuenta (en la pagina) los Blob/File que se construyen con >= 30 MB y las lecturas `blob.arrayBuffer()` de ese tamaño.
    await page.addInitScript(() => {
      const BIG = 30 * 1024 * 1024;
      const state = { constructed: 0, readBack: 0, resets: 0 };
      const sizeOfParts = (parts: unknown): number => {
        if (!Array.isArray(parts)) return 0;
        let total = 0;
        for (const part of parts) {
          if (ArrayBuffer.isView(part)) total += part.byteLength;
          else if (part instanceof ArrayBuffer) total += part.byteLength;
          else if (part instanceof Blob) total += part.size;
        }
        return total;
      };
      for (const name of ["Blob", "File"] as const) {
        const Original = window[name] as typeof Blob;
        (window as unknown as Record<string, unknown>)[name] = new Proxy(Original, {
          construct(target, args, newTarget) {
            if (sizeOfParts(args[0]) >= BIG) state.constructed += 1;
            return Reflect.construct(target, args, newTarget === (window as unknown as Record<string, unknown>)[name] ? target : newTarget);
          },
        });
      }
      const originalArrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function patched(this: Blob) {
        if (this.size >= BIG) state.readBack += 1;
        return originalArrayBuffer.apply(this);
      };
      (window as unknown as { __bigBlobs: (reset?: boolean) => { constructed: number; readBack: number } }).__bigBlobs = (reset) => {
        const copy = { constructed: state.constructed, readBack: state.readBack };
        if (reset) {
          state.constructed = 0;
          state.readBack = 0;
        }
        return copy;
      };
    });
    const bigBlobs = (reset = true) => page.evaluate((flag) => (window as unknown as { __bigBlobs: (reset?: boolean) => { constructed: number; readBack: number } }).__bigBlobs(flag), reset);
    await openBig(page);
    await page.waitForTimeout(1500);
    await bigBlobs(); // lo que costo abrir el archivo no cuenta
    await rotateOnce(page);
    const afterRotate = await bigBlobs();
    // Antes: `savePdfToBlob` construia un Blob de ~39 MB y `blobToBytes` lo leia de vuelta (2 copias enteras por operacion).
    expect(afterRotate, "girar todo: sin Blob del tamaño del documento ni lectura de vuelta").toEqual({ constructed: 0, readBack: 0 });
    // El resultado es el correcto (una rotacion de 90° de la primera pagina) y se puede descargar.
    expect((await downloadedFirstRotation(page)).rotation).toBe(90);
  });

  test("borrador en el peor momento: recargar justo tras aplicar un cambio nunca deja un borrador roto", async ({ page }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    for (const delay of [0, 500, 1200, 4000]) {
      await page.goto("/pdf-pro");
      await page.evaluate(
        (name) => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); }),
        DRAFTS_DB,
      );
      await openBig(page);
      await rotateOnce(page);
      await expect.poll(async () => (await draftInfo(page))[0]?.steps, { timeout: 60_000 }).toBe(1);
      await rotateOnce(page);
      await page.waitForTimeout(delay);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: S.session.openLast })).toBeVisible({ timeout: 30_000 });
      const [draft] = await draftInfo(page);
      // O el paso 1 (el cambio aun no se habia escrito) o el 2: entero, troceado y legible; nunca nada a medias.
      expect([1, 2], `recarga a los ${delay} ms: borrador de ${draft?.steps} pasos`).toContain(draft?.steps);
      expect(draft.chunked).toBe(true);
      expect(draft.size).toBeGreaterThan(38 * MB);
      await page.getByRole("button", { name: S.session.openLast }).click();
      await expect(page.getByRole("heading", { level: 1, name: /grande\.pdf/ })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 120_000 });
      const restored = await downloadedFirstRotation(page);
      expect(restored.rotation, `recarga a los ${delay} ms`).toBe(draft.steps * 90);
      const parsed = await PDFDocument.load(restored.bytes, { updateMetadata: false });
      expect(parsed.getPageCount()).toBe(120);
      if (delay >= 4000) expect(draft.steps).toBe(2); // con calma el ultimo cambio SI esta a salvo
    }
  });

  test("cuota agotada a mitad del historial: avisa, no pierde ningun paso y se deshace EXACTO hasta el original", async ({ page }) => {
    await page.addInitScript(
      ([hotKey, prefix]) => {
        window.localStorage.setItem(hotKey, "0");
        // Tras el primer snapshot completo (~800 trozos de ~48 KB) y un paso mas, el disco se llena.
        let chunkPuts = 0;
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, ...args: Parameters<typeof original>) {
          const value = args[0] as { id?: string } | undefined;
          if (this.transaction.db.name.startsWith(prefix) && typeof value?.id === "string" && value.id.startsWith("~c:")) {
            chunkPuts += 1;
            if (chunkPuts > 850) throw new DOMException("sin espacio", "QuotaExceededError");
          }
          return original.apply(this, args as never);
        } as typeof original;
      },
      [FLAGS.hot, HISTORY_PREFIX] as const,
    );
    await openBig(page);
    // Al fallar el disco el anuncio del volcado puede pisar al «Aplicado»: ambos valen como respuesta al paso.
    for (let i = 1; i <= 4; i += 1) await rotateOnce(page, new RegExp(`^(Aplicado:|${S.announce.historyOffloadFailed.slice(0, 30)})`));
    await expect(page.locator("[data-pro-limits]")).toContainText(S.warnings.historyOffloadUnavailable, { timeout: 60_000 });
    await expect(page.getByRole("status")).toBeAttached();
    // Los 5 pasos siguen en la lista (un PDF de 40 MB cabe en el presupuesto por bytes de lo residente).
    const items = page.getByRole("list", { name: S.suite.historyTitle }).getByRole("listitem");
    await expect(items).toHaveCount(5);
    await page.locator("body").click({ position: { x: 4, y: 4 } });
    for (let i = 4; i >= 1; i -= 1) {
      await expectNewAnnouncement(page, () => page.keyboard.press("Control+z"), /^Deshecho:/);
      await expect(page.locator(`[data-history-index="${i - 1}"]`)).toHaveAttribute("aria-current", "step");
    }
    const original = await downloadedFirstRotation(page);
    expect(original.rotation).toBe(0);
    expect(createHash("sha256").update(original.bytes).digest("hex")).toBe(createHash("sha256").update(bigBytes).digest("hex"));
  });

  test("visor por rangos: un PDF grande se abre sin mandar una copia ENTERA mas al worker de pdf.js, y se ve", async ({ browser }) => {
    /** Cuantas veces la pagina TRANSFIERE a un worker un buffer de >= 30 MB (el documento entero) al abrir y mirar paginas. */
    const run = async (rangeMin: string | null) => {
      const context = await browser.newContext({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.addInitScript(
        ([key, value]) => {
          if (value !== null) window.localStorage.setItem(key, value);
          let wholeCopies = 0;
          let total = 0;
          const original = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function patched(this: Worker, message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
            const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
            for (const item of list) {
              if (item instanceof ArrayBuffer) {
                total += item.byteLength;
                if (item.byteLength >= 30 * 1024 * 1024) wholeCopies += 1;
              }
            }
            return original.call(this, message, transfer as never);
          };
          (window as unknown as { __transfers: () => { wholeCopies: number; total: number } }).__transfers = () => ({ wholeCopies, total });
        },
        [FLAGS.range, rangeMin] as const,
      );
      await openBig(page);
      await page.getByRole("textbox", { name: S.viewer.pageInputLabel }).fill("60");
      await page.getByRole("textbox", { name: S.viewer.pageInputLabel }).press("Enter");
      await expect(page.locator('article[data-page-index="59"][data-state="ready"]')).toBeVisible({ timeout: 60_000 });
      const moved = await page.evaluate(() => (window as unknown as { __transfers: () => { wholeCopies: number; total: number } }).__transfers());
      await context.close();
      return moved;
    };
    const ranged = await run(null); // por defecto: >= 16 MB abre por rangos
    const whole = await run(String(Number.MAX_SAFE_INTEGER)); // forzando la apertura de siempre (copia entera)
    console.log(`[pro-memory] copias enteras al worker: por rangos ${ranged.wholeCopies} (${(ranged.total / MB).toFixed(1)} MB en total), de siempre ${whole.wholeCopies} (${(whole.total / MB).toFixed(1)} MB)`);
    expect(whole.wholeCopies).toBeGreaterThan(ranged.wholeCopies);
    expect(whole.total - ranged.total).toBeGreaterThan(20 * MB); // la copia entera (~38,7 MB) menos los rangos que si se piden
  });

  test("la apertura por rangos pinta las paginas IDENTICAS a la apertura de siempre (el mismo PDF de 40 MB, dos modos)", async ({ page }) => {
    const render = async (rangeMin: string | null, pageIndex: number): Promise<string> => {
      await page.goto("/pdf-pro");
      await page.evaluate(([key, value]) => (value === null ? window.localStorage.removeItem(key) : window.localStorage.setItem(key, value)), [FLAGS.range, rangeMin] as const);
      await page.reload();
      await page.locator('input[type="file"]').first().setInputFiles(bigFile);
      await expect(page.getByRole("heading", { level: 1, name: /grande\.pdf/ })).toBeVisible();
      if (pageIndex > 0) {
        await page.getByRole("textbox", { name: S.viewer.pageInputLabel }).fill(String(pageIndex + 1));
        await page.getByRole("textbox", { name: S.viewer.pageInputLabel }).press("Enter");
      }
      const ready = page.locator(`article[data-page-index="${pageIndex}"][data-state="ready"] img`);
      await expect(ready.first()).toBeVisible({ timeout: 90_000 });
      // Los pixeles de la imagen dibujada (por lienzo: la CSP de la pagina no deja hacer `fetch` a un `blob:`).
      return page.evaluate(async (index) => {
        const img = document.querySelector(`article[data-page-index="${index}"][data-state="ready"] img`) as HTMLImageElement;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = await crypto.subtle.digest("SHA-256", pixels);
        return `${canvas.width}x${canvas.height}:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      }, pageIndex);
    };
    for (const pageIndex of [0, 77]) {
      const ranged = await render(null, pageIndex); // por defecto: >= 16 MB abre por rangos
      const whole = await render(String(Number.MAX_SAFE_INTEGER), pageIndex); // la apertura de siempre
      expect(ranged, `pagina ${pageIndex + 1}`).toBe(whole);
    }
  });
});
