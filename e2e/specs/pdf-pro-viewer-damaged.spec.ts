import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { makeViewerPdf } from "../helpers/viewer-pdfs";

/**
 * PDF Pro · visor con PDF grandes DAÑADOS (Wave 9 · lote 2 · D-B4-1), navegador real y headless, build de produccion.
 *
 * Un PDF de >= 16 MB sin `startxref` valido (cortado o dañado) se abria por rangos 4–50 veces mas lento que de golpe
 * (20 MB: 3,4–3,9 s en vez de 0,86 s; 100 MB: 69 s en vez de 1,4 s), porque pdf.js, con el archivo troceado, vuelve a
 * empezar la busqueda de `startxref` por cada trozo que le falta. Ahora el visor mira la cola del archivo y, sin esa marca,
 * abre de siempre (de golpe). Aqui se mide el tiempo hasta pintar la PRIMERA pagina, contra la apertura de siempre forzada
 * sobre el mismo archivo, y que un PDF sano de 100 MB SIGUE abriendose por rangos (sin mandar una copia entera al worker).
 */

const FLAG = "optimuspdf.pro.viewerRangeMinBytes";
const MB = 1024 * 1024;
const WHOLE = String(Number.MAX_SAFE_INTEGER); // umbral inalcanzable: fuerza la apertura de siempre

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(300_000);

const tmp = path.resolve(process.cwd(), ".evidence/pro-viewer-damaged-tmp");
const files: Record<"good20" | "damaged20" | "good100" | "damaged100", string> = {
  good20: "",
  damaged20: "",
  good100: "",
  damaged100: "",
};

/** El mismo PDF cortado justo antes de su ultimo `startxref`: sin tabla de referencias que pdf.js pueda leer. */
function withoutStartXref(bytes: Buffer): Buffer {
  const at = bytes.lastIndexOf("startxref", undefined, "latin1");
  expect(at, "el PDF de prueba lleva startxref").toBeGreaterThan(0);
  return Buffer.concat([bytes.subarray(0, at), Buffer.from("\n%%EOF\n")]);
}

test.beforeAll(async () => {
  mkdirSync(tmp, { recursive: true });
  const small = await makeViewerPdf(120, { noiseKb: 165 });
  const large = await makeViewerPdf(120, { noiseKb: 835 });
  expect(small.length).toBeGreaterThan(17 * MB);
  expect(small.length).toBeLessThan(25 * MB);
  expect(large.length).toBeGreaterThan(95 * MB);
  files.good20 = path.join(tmp, "sano-20.pdf");
  files.damaged20 = path.join(tmp, "danado-20.pdf");
  files.good100 = path.join(tmp, "sano-100.pdf");
  files.damaged100 = path.join(tmp, "danado-100.pdf");
  writeFileSync(files.good20, small);
  writeFileSync(files.damaged20, withoutStartXref(small));
  writeFileSync(files.good100, large);
  writeFileSync(files.damaged100, withoutStartXref(large));
});

type Opened = {
  /** Milisegundos desde que se entrega el archivo hasta que la primera pagina esta dibujada. */
  firstPageMs: number;
  /** Cuantas veces la pagina TRANSFIERE a un worker un buffer de >= el 90 % del archivo (el documento entero). */
  wholeCopies: number;
  /** Bytes transferidos a workers en total. */
  transferred: number;
};

/** Abre `file` en una pagina nueva (con el umbral de rangos de `rangeMin`, o el de siempre si es `null`) y mide la primera pagina. */
async function openAndMeasure(browser: Browser, file: string, rangeMin: string | null): Promise<Opened> {
  const context = await browser.newContext({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
  const page: Page = await context.newPage();
  const wholeBytes = Math.floor(statSync(file).size * 0.9);
  try {
    await page.addInitScript(
      ([key, value, whole]) => {
        if (value !== null) window.localStorage.setItem(key, value);
        let wholeCopies = 0;
        let transferred = 0;
        const original = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function patched(this: Worker, message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
          for (const item of list) {
            if (item instanceof ArrayBuffer) {
              transferred += item.byteLength;
              if (item.byteLength >= (whole as number)) wholeCopies += 1;
            }
          }
          return original.call(this, message, transfer as never);
        };
        (window as unknown as { __moved: () => { wholeCopies: number; transferred: number } }).__moved = () => ({ wholeCopies, transferred });
      },
      [FLAG, rangeMin, wholeBytes] as const,
    );
    await page.goto("/pdf-pro");
    const started = Date.now();
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await expect(page.locator('article[data-page-index="0"][data-state="ready"] img').first()).toBeVisible({ timeout: 120_000 });
    const firstPageMs = Date.now() - started;
    const moved = await page.evaluate(() => (window as unknown as { __moved: () => { wholeCopies: number; transferred: number } }).__moved());
    return { firstPageMs, ...moved };
  } finally {
    await context.close();
  }
}

/** El menor de varios intentos (el tiempo de un arranque en frio mete ruido que no es del visor). */
async function best(browser: Browser, file: string, rangeMin: string | null, attempts = 2): Promise<Opened> {
  let winner: Opened | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await openAndMeasure(browser, file, rangeMin);
    if (!winner || run.firstPageMs < winner.firstPageMs) winner = run;
  }
  return winner as Opened;
}

test.describe("visor · PDF grande sin startxref", () => {
  test("20 MB dañado: la primera pagina sale casi tan rapido como con la apertura de siempre (no por rangos)", async ({ browser }) => {
    const byDefault = await best(browser, files.damaged20, null);
    const whole = await best(browser, files.damaged20, WHOLE);
    console.log(`[pro-viewer-damaged] 20 MB dañado: primera pagina ${byDefault.firstPageMs} ms por defecto, ${whole.firstPageMs} ms con la apertura de siempre forzada; copias enteras al worker ${byDefault.wholeCopies} / ${whole.wholeCopies}`);
    // Se abre de golpe, igual que la apertura de siempre: las mismas copias enteras al worker, no 320 peticiones de rangos.
    expect(whole.wholeCopies).toBeGreaterThanOrEqual(1);
    expect(byDefault.wholeCopies).toBe(whole.wholeCopies);
    expect(byDefault.firstPageMs).toBeLessThanOrEqual(whole.firstPageMs * 1.5 + 300);
  });

  test("100 MB dañado: la primera pagina sale en pocos segundos (antes, ~69 s)", async ({ browser }) => {
    const byDefault = await openAndMeasure(browser, files.damaged100, null);
    const whole = await openAndMeasure(browser, files.damaged100, WHOLE);
    console.log(`[pro-viewer-damaged] 100 MB dañado: primera pagina ${byDefault.firstPageMs} ms por defecto, ${whole.firstPageMs} ms con la apertura de siempre forzada; copias enteras al worker ${byDefault.wholeCopies} / ${whole.wholeCopies}`);
    expect(whole.wholeCopies).toBeGreaterThanOrEqual(1);
    expect(byDefault.wholeCopies).toBe(whole.wholeCopies);
    expect(byDefault.firstPageMs).toBeLessThanOrEqual(whole.firstPageMs * 1.5 + 500);
    expect(byDefault.firstPageMs).toBeLessThan(10_000);
  });

  test("un PDF sano de 100 MB SIGUE abriendose por rangos: una copia entera menos al worker que de siempre, y la primera pagina sale pronto", async ({ browser }) => {
    const ranged = await openAndMeasure(browser, files.good100, null);
    const whole = await openAndMeasure(browser, files.good100, WHOLE);
    console.log(
      `[pro-viewer-damaged] 100 MB sano: primera pagina ${ranged.firstPageMs} ms por rangos (${(ranged.transferred / MB).toFixed(1)} MB al worker, ${ranged.wholeCopies} copias enteras), ${whole.firstPageMs} ms de siempre (${(whole.transferred / MB).toFixed(1)} MB, ${whole.wholeCopies} copias enteras)`,
    );
    expect(ranged.wholeCopies).toBeLessThan(whole.wholeCopies);
    expect(whole.transferred - ranged.transferred).toBeGreaterThan(80 * MB);
    expect(ranged.firstPageMs).toBeLessThan(10_000);
  });

  test("un PDF sano de 20 MB tampoco pierde los rangos (sin penalizar el caso bueno)", async ({ browser }) => {
    const byDefault = await best(browser, files.good20, null);
    const whole = await best(browser, files.good20, WHOLE);
    console.log(`[pro-viewer-damaged] 20 MB sano: primera pagina ${byDefault.firstPageMs} ms por rangos, ${whole.firstPageMs} ms con la apertura de siempre forzada; copias enteras ${byDefault.wholeCopies} / ${whole.wholeCopies}`);
    expect(byDefault.wholeCopies).toBeLessThan(whole.wholeCopies);
    expect(byDefault.firstPageMs).toBeLessThanOrEqual(whole.firstPageMs * 1.5 + 300);
  });
});
