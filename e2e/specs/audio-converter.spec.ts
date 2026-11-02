import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";
import { downloadFile } from "../helpers/downloads";
import {
  audioContext,
  describeViolations,
  frequencyOf,
  makeWav,
  measureOverflow,
  readWav,
  rmsOf,
  runAxe,
  type Language,
  type Theme,
} from "../helpers/audio-flow";

/**
 * Convertidor de audio (OptimusTOOLS · W-AUDIO), en Chromium headless con codecs reales:
 *  - lote de dos WAV con otra frecuencia y mono -> ZIP, cabeceras y duraciones correctas, tamano antes y despues;
 *  - Opus y M4A segun lo que el navegador sepa crear (y si no, desactivados con el motivo);
 *  - MP3 desactivado con el motivo de la licencia;
 *  - un archivo roto no tira el lote (informe de fallos parciales);
 *  - todo con teclado, en ES y EN, axe 0, sin desborde a 375/320 px ni con tipografia ancha;
 *  - ningun byte sale de la pagina (ninguna peticion fuera de localhost ni con cuerpo).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(120_000);

const input = (page: Page) => page.locator('input[type="file"]').first();
const run = (page: Page) => page.getByRole("button", { name: /^(Procesar|Process)$/ }).first();
const download = (page: Page) => page.getByRole("button", { name: /^(Descargar|Download)$/ });

/** Peticiones de la pagina: todas al propio servidor y ninguna con cuerpo. */
function watchNetwork(page: Page) {
  const foreign: string[] = [];
  const bodies: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.hostname !== "localhost") foreign.push(request.url());
    if (request.postData()) bodies.push(`${request.method()} ${url.pathname}`);
  });
  return { foreign, bodies };
}

async function open(page: Page) {
  // «networkidle»: el HTML sale del servidor antes de hidratar; un clic o un archivo antes de eso se perderia.
  await page.goto("/audio-converter", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: /Convertidor de audio|Audio Converter/ })).toBeVisible();
}

test.describe("Convertidor de audio", () => {
  test("lote de dos WAV -> WAV 22,05 kHz mono en un ZIP: nombres, cabeceras, duraciones, tono y tamano antes y despues", async ({ page }) => {
    const network = watchNetwork(page);
    await open(page);
    await input(page).setInputFiles([
      { name: "uno.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: 44100, channels: 2, frequency: 440 }) },
      { name: "dos.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: 48000, channels: 1, frequency: 880 }) },
    ]);
    await expect(page.getByText("uno.wav", { exact: true })).toBeVisible();
    await expect(page.getByText(/172 KB · 1 s/)).toBeVisible();
    await expect(page.getByText(/46,9 KB · 0,5 s/)).toBeVisible();

    await page.getByLabel("Frecuencia de muestreo").selectOption("22050");
    await page.getByRole("radio", { name: "Mono" }).click();
    await expect(run(page)).toBeEnabled();
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    await expect(download(page)).toBeFocused();
    await expect(page.getByText("2 audios convertidos y reunidos en un ZIP.")).toBeVisible();
    await expect(page.getByText(/172 KB → 43,1 KB/)).toBeVisible();

    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("audios-convertidos.zip");
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["dos-convertido.wav", "uno-convertido.wav"]);
    const uno = readWav(Buffer.from(await zip.files["uno-convertido.wav"].async("uint8array")));
    const dos = readWav(Buffer.from(await zip.files["dos-convertido.wav"].async("uint8array")));
    for (const wav of [uno, dos]) {
      expect(wav.sampleRate).toBe(22050);
      expect(wav.channels).toBe(1);
    }
    expect(uno.durationSec).toBeCloseTo(1, 2);
    expect(dos.durationSec).toBeCloseTo(0.5, 2);
    expect(frequencyOf(uno.samples[0], 22050, 2000, 20000)).toBeGreaterThan(432);
    expect(frequencyOf(uno.samples[0], 22050, 2000, 20000)).toBeLessThan(448);
    expect(frequencyOf(dos.samples[0], 22050, 1000, 10000)).toBeGreaterThan(868);
    expect(frequencyOf(dos.samples[0], 22050, 1000, 10000)).toBeLessThan(892);
    expect(rmsOf(uno.samples[0])).toBeGreaterThan(0.3); // 0,5 de amplitud => 0,354
    expect(network.foreign).toEqual([]);
    expect(network.bodies).toEqual([]);
  });

  test("Opus y M4A: se crean si el navegador sabe, con archivos que el navegador (Opus) o nuestro lector (M4A) leen; si no, aparecen desactivados con su motivo", async ({ page }) => {
    await open(page);
    await expect(page.getByText(/Comprobando qué formatos/)).toBeHidden({ timeout: 10_000 });
    for (const format of ["opus", "m4a"] as const) {
      const radio = page.locator(`[role="radio"][data-format="${format}"]`);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await input(page).setInputFiles({ name: "voz.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1.2, sampleRate: 44100, channels: 2, frequency: 523 }) });
      await expect(page.getByText("voz.wav", { exact: true })).toBeVisible();
      await expect(page.getByText(/Comprobando qué formatos/)).toBeHidden({ timeout: 10_000 });
      if ((await radio.getAttribute("aria-disabled")) === "true") {
        const reasonId = await radio.getAttribute("aria-describedby");
        await expect(page.locator(`[id="${reasonId}"]`)).toContainText(/navegador/);
        test.info().annotations.push({ type: format, description: "desactivado por el navegador, con motivo visible" });
        continue;
      }
      await radio.click();
      await expect(radio).toHaveAttribute("aria-checked", "true");
      await run(page).click();
      await expect(download(page)).toBeVisible({ timeout: 60_000 });
      const { bytes, filename } = await downloadFile(page, () => download(page).click());
      if (format === "opus") {
        expect(filename).toBe("voz.opus");
        expect(bytes.toString("ascii", 0, 4)).toBe("OggS");
        expect(bytes.toString("ascii", 28, 36)).toBe("OpusHead");
        // Lo decodifica el navegador de verdad.
        const decoded = await page.evaluate(async (base64) => {
          const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const buffer = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(data.buffer);
          return { duration: buffer.duration, channels: buffer.numberOfChannels, rate: buffer.sampleRate };
        }, bytes.toString("base64"));
        expect(decoded.duration).toBeGreaterThan(1.15);
        expect(decoded.duration).toBeLessThan(1.3);
        expect(decoded).toMatchObject({ channels: 2, rate: 48000 });
      } else {
        expect(filename).toBe("voz.m4a");
        expect(bytes.toString("ascii", 4, 12)).toBe("ftypM4A ");
        expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
      }
      test.info().annotations.push({ type: format, description: `creado: ${filename} (${bytes.length} B)` });
    }
  });

  test("MP3 se ofrece DESACTIVADO con el motivo de la licencia y no se puede elegir (ni con teclado)", async ({ page }) => {
    await open(page);
    await input(page).setInputFiles({ name: "a.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.3, sampleRate: 8000, channels: 1 }) });
    const mp3 = page.locator('[role="radio"][data-format="mp3"]');
    await expect(mp3).toHaveAttribute("aria-disabled", "true");
    await expect(mp3).toHaveAttribute("aria-checked", "false");
    const reasonId = await mp3.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${reasonId}"]`)).toContainText(/LGPL/);
    await mp3.click({ force: true });
    await mp3.focus();
    await page.keyboard.press("Enter");
    await expect(mp3).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[role="radio"][data-format="wav"]')).toHaveAttribute("aria-checked", "true");
  });

  test("un archivo roto no tira el lote: el bueno se convierte y el informe dice cual fallo y por que", async ({ page }) => {
    await open(page);
    await input(page).setInputFiles([
      { name: "bueno.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: 16000, channels: 1 }) },
      { name: "roto.wav", mimeType: "audio/wav", buffer: Buffer.from("esto no es un audio, solo texto") },
    ]);
    await expect(page.getByText("roto.wav", { exact: true })).toBeVisible();
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    const report = page.getByTestId("audio-failure-report");
    await expect(report).toContainText("No se pudo convertir");
    await expect(report).toContainText("roto.wav");
    await expect(report).toContainText(/no parece un archivo de audio|dañado/i);
    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("bueno-convertido.wav");
    expect(readWav(bytes).sampleRate).toBe(16000);
  });

  test("si NINGUN archivo se puede convertir, el aviso explica el motivo concreto y los archivos siguen en la lista", async ({ page }) => {
    await open(page);
    await input(page).setInputFiles({ name: "roto.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("tampoco soy audio") });
    await run(page).click();
    const alert = page.locator("[data-error-banner]");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/No se pudo completar/);
    await expect(alert).toContainText(/audio|dañado/);
    await expect(page.getByText("roto.mp3", { exact: true })).toBeVisible();
    await expect(alert).toBeFocused();
  });

  test("solo con teclado: elegir archivos con Intro, recorrer con Tab hasta «Procesar» y descargar", async ({ page }) => {
    await open(page);
    const choose = page.locator("button", { hasText: "Elegir audios" });
    await choose.focus();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
    await chooser.setFiles({ name: "teclado.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.4, sampleRate: 8000, channels: 1 }) });
    await expect(page.getByText("teclado.wav", { exact: true })).toBeVisible();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Procesar");
    }
    expect(reached, "Tab alcanza «Procesar»").toBe(true);
    await page.keyboard.press("Enter");
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    await expect(download(page)).toBeFocused();
  });

  test("ingles: titulos, opciones y resultado salen en ingles", async ({ browser }) => {
    const context = await audioContext(browser, { width: 1280, language: "en" });
    const page = await context.newPage();
    try {
      await open(page);
      await expect(page.getByRole("heading", { name: "Drop your audio files here" })).toBeVisible();
      await input(page).setInputFiles({ name: "one.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.3, sampleRate: 8000, channels: 1 }) });
      await expect(page.getByText("Output format")).toBeVisible();
      await expect(page.getByText("Sample rate")).toBeVisible();
      await run(page).click();
      await expect(download(page)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("1 audio file converted.")).toBeVisible();
      await expect(page.getByText("Size before and after")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

const MATRIX: Array<{ width: number; theme: Theme; language: Language; wide: boolean }> = [
  { width: 1280, theme: "dark", language: "es", wide: false },
  { width: 1280, theme: "light", language: "en", wide: false },
  { width: 375, theme: "dark", language: "es", wide: true },
  { width: 375, theme: "light", language: "en", wide: false },
  { width: 320, theme: "light", language: "es", wide: true },
  { width: 320, theme: "dark", language: "en", wide: true },
];

test.describe("Convertidor de audio · accesibilidad y maquetacion", () => {
  for (const cell of MATRIX) {
    test(`axe 0 y sin desborde: ${cell.width}px · ${cell.theme} · ${cell.language}${cell.wide ? " · tipografia ancha" : ""}`, async ({ browser }) => {
      const context = await audioContext(browser, { ...cell, touch: cell.width < 600 });
      const page = await context.newPage();
      try {
        await open(page);
        const empty = await runAxe(page);
        expect(empty, `vacio\n${describeViolations(empty)}`).toEqual([]);
        expect((await measureOverflow(page)).overflow, "vacio").toBeLessThanOrEqual(1);

        await input(page).setInputFiles([
          { name: "grabacion-con-un-nombre-bastante-largo-para-probar-el-corte-de-texto.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: 8000, channels: 1 }) },
          { name: "roto.wav", mimeType: "audio/wav", buffer: Buffer.from("no soy audio") },
        ]);
        await expect(page.getByText(/grabacion-con-un-nombre/)).toBeVisible();
        const withFiles = await runAxe(page);
        expect(withFiles, `con archivos\n${describeViolations(withFiles)}`).toEqual([]);
        const measured = await measureOverflow(page);
        expect(measured.overflow, `con archivos: ${JSON.stringify(measured.offenders)}`).toBeLessThanOrEqual(1);
        expect(measured.offenders).toEqual([]);

        if (cell.width < 768) {
          await page.getByRole("button", { name: /^(Opciones|Options)$/ }).click();
          const sheet = page.getByRole("dialog");
          await expect(sheet).toBeVisible();
          await expect(sheet.getByText(/Formato de salida|Output format/)).toBeVisible();
          const open1 = await runAxe(page);
          expect(open1, `hoja de opciones\n${describeViolations(open1)}`).toEqual([]);
          const sheetMeasure = await measureOverflow(page);
          expect(sheetMeasure.overflow, `hoja: ${JSON.stringify(sheetMeasure.offenders)}`).toBeLessThanOrEqual(1);
          await page.keyboard.press("Escape");
          await expect(sheet).toBeHidden();
        }

        // Objetivos tactiles de 44 px en los controles principales (con puntero grueso).
        if (cell.width < 600) {
          const small = await page.evaluate(() => {
            const bad: string[] = [];
            for (const element of document.querySelectorAll<HTMLElement>("main button, main [role=radio], main select, main input[type=file] + *, main a")) {
              const rect = element.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              if (rect.height < 43.5) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}" ${Math.round(rect.height)}px`);
            }
            return bad;
          });
          expect(small, "controles de menos de 44 px").toEqual([]);
        }
      } finally {
        await context.close();
      }
    });
  }
});
