import type { Page } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import { expect, openTool, runButton, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import {
  MB,
  embeddedImages,
  makePhotoSet,
  qualityAgainstOriginal,
  removePhotoSet,
  startRssSampler,
  type RssReport,
  type PhotoSet,
} from "../helpers/photo-set";

/**
 * Imagenes a PDF · optimizacion de tamano con un lote como el del caso real: ~40 fotos de movil (12 MP con alguna de 24 y
 * 48 MP) con orientacion EXIF mezclada. Navegador real y headless (Chromium y WebKit/iPad), build de produccion.
 *
 * Comprueba, por calidad: tamano final frente a las fotos, 40 paginas con la orientacion correcta, que «Original» incrusta
 * EXACTAMENTE los bytes de cada foto, PSNR/SSIM de lo incrustado frente al original reducido, que no sale ninguna
 * peticion de red, que el hilo principal no se bloquea mas de 100 ms seguidos, la memoria del navegador y el tiempo.
 * Ademas: progreso real foto a foto, cancelar, recordar la calidad elegida y el «Antes → Despues» del resultado.
 */

test.use({ locale: "es-ES" });

const CI = !!process.env.CI;
/** Holgura de tiempo absoluto solo en CI (runner de GitHub ~2,5x mas lento). */
const SLACK = CI ? 2.5 : 1;
const PHOTOS = 40;

/** 12 MP casi todas (vertical y horizontal), tres de 24 MP y una de 48 MP: lo que haria un iPhone con varios modos. */
const SIZES: Array<[number, number]> = [
  [4000, 3000],
  [3000, 4000],
  [4000, 3000],
  [4000, 3000],
  [3000, 4000],
  [5712, 4284],
];
function sizeOf(index: number): { width: number; height: number } {
  if (index === 20) return { width: 8064, height: 6048 };
  if (index === 5 || index === 11 || index === 30) return { width: 5712, height: 4284 };
  const [width, height] = SIZES[index % 5];
  return { width, height };
}

let set: PhotoSet;
test.beforeAll(async () => {
  test.setTimeout(240_000);
  set = await makePhotoSet({ name: "forty", count: PHOTOS, size: sizeOf, distinct: 6 });
});
test.afterAll(() => removePhotoSet(set));

/** `max`: hueco mas largo del hilo principal en toda la generacion; `optimizing`: hasta empezar la ultima foto (sin guardar el PDF). */
type Jank = { max: number; longMax: number; optimizing: number };

/** Mide cuanto se bloquea el hilo principal: huecos entre temporizadores de 25 ms y, si existe, tareas largas (Chromium). */
async function installJankMonitor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { max: 0, longMax: 0, optimizing: -1, armed: false };
    (window as unknown as { __jank: typeof state }).__jank = state;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (state.armed) state.max = Math.max(state.max, now - last - 25);
      last = now;
    }, 25);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (state.armed) state.longMax = Math.max(state.longMax, entry.duration);
      }).observe({ type: "longtask" });
    } catch {
      /* WebKit no tiene longtask */
    }
    // El hueco mas largo hasta que empieza la ULTIMA foto: lo que viene despues es guardar el PDF (pdf-lib, una sola operacion).
    const watch = (): void => {
      const text = document.querySelector("[data-processing-overlay]")?.textContent ?? "";
      if (state.armed && state.optimizing < 0 && /foto 40 de 40/.test(text)) state.optimizing = state.max;
    };
    new MutationObserver(watch).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
const arm = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as { __jank: { max: number; longMax: number; optimizing: number; armed: boolean } }).__jank;
  state.max = 0;
  state.longMax = 0;
  state.optimizing = -1;
  state.armed = true;
});
const readJank = (page: Page): Promise<Jank> => page.evaluate(() => {
  const state = (window as unknown as { __jank: { max: number; longMax: number; optimizing: number; armed: boolean } }).__jank;
  state.armed = false;
  return { max: state.max, longMax: state.longMax, optimizing: state.optimizing < 0 ? state.max : state.optimizing };
});

async function gotoWithPhotos(page: Page): Promise<void> {
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths);
  await expect(page.locator("[data-image-quality]")).toBeVisible({ timeout: 60_000 });
  // Las miniaturas se hacen en cola tras subir (unos segundos): se espera a que acaben para medir solo el procesado.
  await expect(page.getByAltText(/^Imagen \d+$/)).toHaveCount(PHOTOS, { timeout: 120_000 });
}

async function pickQuality(page: Page, name: "Original" | "Alta" | "Equilibrada" | "Compacta"): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
}

type Run = { bytes: Buffer; seconds: number; summary: string; notices: string; jank: Jank; rss: RssReport; external: string[] };

/** Genera con la calidad ya elegida y descarga; mide tiempo, bloqueo del hilo, memoria y peticiones externas. */
async function generate(page: Page): Promise<Run> {
  const external: string[] = [];
  const origin = new URL(page.url()).origin;
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) external.push(url);
  });
  await arm(page);
  const sampler = startRssSampler({ webkit: test.info().project.name.startsWith("webkit") });
  const started = Date.now();
  await runButton(page).click();
  const download = page.getByRole("button", { name: "Descargar", exact: true });
  await expect(download).toBeVisible({ timeout: 240_000 });
  const seconds = (Date.now() - started) / 1000;
  const rss = sampler.stop();
  const jank = await readJank(page);
  const summary = (await page.locator("[data-download-summary]").textContent()) ?? "";
  const notices = (await page.locator("[data-download-notices]").allTextContents()).join(" ");
  const { bytes } = await downloadFile(page, () => download.click());
  return { bytes, seconds, summary, notices, jank, rss, external };
}

/** Orientaciones esperadas de la pagina: foto vista vertical (EXIF 6/8 sobre una horizontal, o vertical sin giro) o apaisada. */
function expectedLandscape(index: number): boolean {
  const { width, height } = set.specs[index];
  const rotated = set.specs[index].orientation === 6 || set.specs[index].orientation === 8;
  const landscape = width > height;
  return rotated ? !landscape : landscape;
}

async function checkPages(bytes: Buffer): Promise<PDFDocument> {
  const document = await PDFDocument.load(bytes);
  expect(document.getPageCount()).toBe(PHOTOS);
  for (let index = 0; index < PHOTOS; index += 1) {
    const { width, height } = document.getPage(index).getSize();
    expect(width > height, `pagina ${index + 1}: apaisada=${expectedLandscape(index)}`).toBe(expectedLandscape(index));
  }
  return document;
}

const report: string[] = [];
test.afterAll(() => {
  console.log(`\n[image-optimize] ${test.info().project.name}\n${report.join("\n")}\n`);
});

const sizesByPreset: Record<string, number> = {};

for (const preset of [
  { id: "Original" as const, key: "original" },
  { id: "Alta" as const, key: "high" },
  { id: "Equilibrada" as const, key: "balanced" },
  { id: "Compacta" as const, key: "compact" },
]) {
  test(`40 fotos con «${preset.id}»: tamano, 40 paginas con su orientacion, calidad medida, sin red, hilo libre y memoria`, async ({ page }) => {
    test.setTimeout(480_000);
    await installJankMonitor(page);
    await gotoWithPhotos(page);
    await pickQuality(page, preset.id);
    const run = await generate(page);
    const document = await checkPages(run.bytes);
    expect(document.getPageCount()).toBe(PHOTOS);
    sizesByPreset[preset.key] = run.bytes.length;

    const images = await embeddedImages(run.bytes);
    expect(images).toHaveLength(PHOTOS);

    // Calidad: PSNR y SSIM frente al original reducido al mismo tamano en una muestra (12, 24 y 48 MP).
    const quality: string[] = [];
    if (preset.key === "original") {
      // Cada foto incrustada son EXACTAMENTE los bytes del archivo.
      for (let index = 0; index < PHOTOS; index += 1) {
        expect(images[index].bytes.length).toBe(set.buffers[index].length);
        expect(Buffer.compare(Buffer.from(images[index].bytes), set.buffers[index]), `foto ${index + 1} identica`).toBe(0);
      }
      expect(run.bytes.length).toBeGreaterThan(set.totalBytes);
      expect(run.bytes.length).toBeLessThan(set.totalBytes * 1.02);
    } else {
      const longSide: Record<string, number> = { high: 4096, balanced: 3000, compact: 2200 };
      for (const image of images) expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(longSide[preset.key]);
      // «Alta» solo reduce las fotos que pasan de 4096 px o que ahorran >= 15 % (un JPEG de 12 MP a calidad 92 ya esta cerca
      // de lo que da «Alta»): el PDF nunca pesa mas que las fotos. Las demas calidades las reducen casi todas.
      expect(run.bytes.length).toBeLessThan(set.totalBytes * (preset.key === "high" ? 0.99 : 0.6));
      for (const index of [0, 1, 5, 20]) {
        const measured = await qualityAgainstOriginal(images[index].bytes, set.buffers[index]);
        quality.push(`foto ${index + 1} (${set.specs[index].width}x${set.specs[index].height}, EXIF ${set.specs[index].orientation}): ${measured.width}x${measured.height} PSNR ${measured.psnr.toFixed(1)} dB SSIM ${measured.ssim.toFixed(4)}`);
        if (preset.key !== "compact") {
          expect(measured.psnr, `PSNR foto ${index + 1}`).toBeGreaterThanOrEqual(38);
          expect(measured.ssim, `SSIM foto ${index + 1}`).toBeGreaterThanOrEqual(0.97);
        } else {
          expect(measured.psnr).toBeGreaterThanOrEqual(34);
          expect(measured.ssim).toBeGreaterThanOrEqual(0.93);
        }
      }
    }

    // Aviso honesto si el PDF sigue pesando mas de ~25 MB (limite habitual del correo) o ~100 MB.
    if (run.bytes.length > 100 * MB) expect(run.notices).toContain("más de 100 MB");
    else if (run.bytes.length > 25 * MB) expect(run.notices).toMatch(/más de 25 MB.*Compacta/);
    else expect(run.notices).toBe("");

    // «Antes → Despues» en el resultado.
    expect(run.summary).toContain("→");
    expect(run.summary).toMatch(/PDF: /);

    // Local: ninguna peticion a otro origen. Hilo principal: sin bloqueos largos. Tiempo y memoria.
    expect(run.external, "peticiones a otros origenes").toEqual([]);
    const isWebKit = test.info().project.name.startsWith("webkit");
    const timeLimit = (isWebKit ? 60 : 20) * SLACK;
    const jankLimit = 100 * SLACK;
    report.push(
      `${preset.id}: ${(run.bytes.length / MB).toFixed(1)} MB frente a ${(set.totalBytes / MB).toFixed(1)} MB (${Math.round((1 - run.bytes.length / set.totalBytes) * 100)} % menos), ${run.seconds.toFixed(1)} s, hilo principal: hueco max ${run.jank.optimizing.toFixed(0)} ms optimizando / ${run.jank.max.toFixed(0)} ms con el guardado del PDF (longtask ${run.jank.longMax.toFixed(0)} ms), memoria navegador base ${run.rss.baseline.toFixed(0)} MB pico ${run.rss.peak.toFixed(0)} MB (+${(run.rss.peak - run.rss.baseline).toFixed(0)} MB; proceso de la pagina +${run.rss.webDelta.toFixed(0)} MB, GPU +${run.rss.gpuDelta.toFixed(0)} MB, resto +${run.rss.otherDelta.toFixed(0)} MB) [${run.rss.detail.sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 3).join(" | ")}]\n   ${quality.join("\n   ")}`,
    );
    expect(run.seconds, `tiempo de ${preset.id}`).toBeLessThan(timeLimit);
    // Optimizar las fotos no bloquea el hilo principal; guardar el PDF (pdf-lib, una sola operacion sincrona) si puede tardar
    // mas con un PDF de decenas de MB: se acota aparte (nunca mas de ~1 s).
    expect(run.jank.optimizing, `hueco mas largo del hilo principal optimizando con ${preset.id}`).toBeLessThan(jankLimit);
    expect(run.jank.max, `hueco mas largo con el guardado del PDF con ${preset.id}`).toBeLessThan(1000 * SLACK);

    // Memoria. Chromium: el proceso de la PAGINA (donde corren nuestro codigo y el worker) sube menos de 400 MB con las
    // calidades que optimizan. WebKit (macOS, el de Playwright): decodificar y codificar una foto de 12 MP deja una meseta de
    // ~350 MB entre el proceso de la pagina y el de GPU (el codificador JPEG y los lienzos aceleradas de WebKit retienen los
    // bufer unas fotos mas), y el PDF final suma ~3 copias de su peso: sube menos de 400 MB solo con «Compacta» y menos de
    // 650 MB con las otras; el aumento TOTAL del navegador (pagina + GPU + red, que guarda copias de la descarga) se acota aparte. «Original» conserva ~92 MB de
    // fotos y el PDF de ~92 MB (bytes de las fotos + documento + archivo guardado + Blob): su pico es ~4-5 veces lo que
    // pesan las fotos, inevitable con pdf-lib.
    const total = run.rss.webDelta + run.rss.gpuDelta + run.rss.otherDelta;
    if (preset.key === "original") {
      expect(total, "memoria pico del navegador").toBeLessThan((set.totalBytes / MB) * 5.5);
    } else {
      const webLimit = isWebKit && preset.key !== "compact" ? 650 : 400;
      expect(run.rss.webDelta, "aumento del proceso de la pagina").toBeLessThan(webLimit);
      expect(total, "aumento total del navegador").toBeLessThan(isWebKit ? 1300 : 900);
    }
  });
}

test("el orden de pesos es coherente (original > alta > equilibrada > compacta)", () => {
  test.skip(Object.keys(sizesByPreset).length < 4, "depende de las cuatro pruebas anteriores");
  expect(sizesByPreset.original).toBeGreaterThan(sizesByPreset.high);
  expect(sizesByPreset.high).toBeGreaterThan(sizesByPreset.balanced);
  expect(sizesByPreset.balanced).toBeGreaterThan(sizesByPreset.compact);
});

test("por defecto la calidad es «Equilibrada» (recomendada), con su descripcion y una estimacion con «≈»", async ({ page }) => {
  await gotoWithPhotos(page);
  await expect(page.getByRole("tab", { name: "Equilibrada", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-image-quality-description]")).toContainText("Recomendada: se ve igual y pesa mucho menos.");
  const estimate = page.locator("[data-image-quality-estimate]");
  await expect(estimate).toContainText("≈", { timeout: 30_000 });
  await expect(estimate).toContainText("sin optimizar");
  const text = (await estimate.textContent()) ?? "";
  const numbers = [...text.matchAll(/≈\s*([\d.,]+)\s*(KB|MB|GB)/g)].map((match) => Number(match[1].replace(",", ".")) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as "KB" | "MB" | "GB"]));
  expect(numbers).toHaveLength(2);
  // La estimacion con la calidad recomendada es mucho menor que la de «sin optimizar» (~ el peso de las fotos).
  expect(numbers[0]).toBeLessThan(numbers[1] * 0.6);
  expect(numbers[1] * MB).toBeGreaterThan(set.totalBytes * 0.9);
  expect(numbers[1] * MB).toBeLessThan(set.totalBytes * 1.1);
  await page.getByRole("tab", { name: "Original", exact: true }).click();
  await expect(estimate).toContainText("lo que pesan tus fotos");
  await page.getByRole("tab", { name: "Compacta", exact: true }).click();
  await expect(estimate).toContainText("sin optimizar");
});

test("progreso real foto a foto («Optimizando foto N de 40») y cancelar sin descargar nada", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoWithPhotos(page);
  await runButton(page).click();
  const overlay = page.locator("[data-processing-overlay]");
  await expect(overlay).toContainText(/Optimizando foto \d+ de 40/, { timeout: 60_000 });
  const seen = new Set<number>();
  await expect
    .poll(async () => {
      const match = /Optimizando foto (\d+) de 40/.exec((await overlay.textContent()) ?? "");
      if (match) seen.add(Number(match[1]));
      return seen.size;
    }, { timeout: 120_000, intervals: [100] })
    .toBeGreaterThanOrEqual(3);
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await overlay.getByRole("button", { name: "Cancelar" }).click();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: /cancel/i }).first()).toBeVisible();
  await expect(runButton(page)).toBeEnabled();
  await page.waitForTimeout(1500);
  expect(downloaded).toBe(false);
  // La pagina sigue viva: se puede volver a generar con otra calidad.
  await pickQualityAndRunFast(page);
});

async function pickQualityAndRunFast(page: Page): Promise<void> {
  await pickQuality(page, "Original");
  await runButton(page).click();
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 240_000 });
  await expect(page.locator("[data-download-summary]")).toContainText("→");
}

test("la ultima calidad elegida se recuerda en este dispositivo (y los originales no se tocan)", async ({ page }) => {
  await openTool(page, "jpg-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(set.paths.slice(0, 3));
  await expect(page.locator("[data-image-quality]")).toBeVisible();
  await pickQuality(page, "Compacta");
  expect(await page.evaluate(() => localStorage.getItem("optimuspdf.imageQuality"))).toBe("compact");
  await page.reload();
  await page.locator('input[type="file"]').first().setInputFiles(set.paths.slice(0, 3));
  await expect(page.getByRole("tab", { name: "Compacta", exact: true })).toHaveAttribute("aria-selected", "true");
  // Los archivos originales siguen intactos en disco (la herramienta solo lee).
  const { readFileSync } = await import("node:fs");
  expect(Buffer.compare(readFileSync(set.paths[0]), set.buffers[0])).toBe(0);
});
