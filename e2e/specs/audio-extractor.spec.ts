import { expect, test, type Page } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import {
  audioContext,
  describeViolations,
  frequencyOf,
  makeWav,
  measureOverflow,
  readWav,
  recordWebm,
  rmsOf,
  runAxe,
  type Language,
  type Theme,
} from "../helpers/audio-flow";

/**
 * Extraer audio de un video (OptimusTOOLS · W-AUDIO), en Chromium headless con codecs reales. Los videos los graba la
 * propia prueba con `MediaRecorder` (WebM real: seno de 440 Hz y/o lienzo que cambia de color). Un MP4 sintetico no se
 * puede grabar aqui (MediaRecorder de Chromium headless no escribe MP4); el lector de MP4 se prueba en unitarias con
 * archivos construidos a mano y con el M4A que crea el propio codificador (ver `audio-converter-engine.spec.ts`).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(120_000);

const input = (page: Page) => page.locator('input[type="file"]').first();
const run = (page: Page) => page.getByRole("button", { name: /^(Procesar|Process)$/ }).first();
const download = (page: Page) => page.getByRole("button", { name: /^(Descargar|Download)$/ });

async function open(page: Page) {
  // «networkidle»: el HTML sale del servidor antes de hidratar; un archivo antes de eso se perderia.
  await page.goto("/audio-extractor", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: /Extraer audio|Extract audio/ })).toBeVisible();
}

test.describe("Extraer audio", () => {
  test("un WebM real con video y sonido -> WAV: dura lo que el video, suena el tono de 440 Hz y el video no se toca", async ({ page }) => {
    await open(page);
    const webm = await recordWebm(page, { audio: true, video: true, ms: 1600 });
    await input(page).setInputFiles({ name: "clip.webm", mimeType: "video/webm", buffer: webm });
    await expect(page.getByText("clip.webm", { exact: true })).toBeVisible();
    // La comprobacion de la subida termina (peso visible, sin «Comprobando…») y «Procesar» se activa.
    await expect(page.getByText(/^\d[\d,.]* KB$/)).toBeVisible();
    await expect(run(page)).toBeEnabled();
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    await expect(download(page)).toBeFocused();
    await expect(page.getByText("Audio extraído del video.")).toBeVisible();
    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("clip.wav");
    const wav = readWav(bytes);
    expect(wav.sampleRate).toBe(48000);
    expect(wav.durationSec).toBeGreaterThan(1.1);
    expect(wav.durationSec).toBeLessThan(2.3);
    const mid = Math.floor(wav.frames / 2);
    expect(rmsOf(wav.samples[0], mid - 4800, mid + 4800)).toBeGreaterThan(0.15);
    const tone = frequencyOf(wav.samples[0], wav.sampleRate, mid - 9600, mid + 9600);
    expect(tone).toBeGreaterThan(425);
    expect(tone).toBeLessThan(455);
  });

  test("a Opus: el archivo es Ogg Opus y el navegador lo decodifica con una duracion parecida a la del video", async ({ page }) => {
    await open(page);
    const webm = await recordWebm(page, { audio: true, video: true, ms: 1200 });
    await input(page).setInputFiles({ name: "escena.webm", mimeType: "video/webm", buffer: webm });
    await expect(page.getByText("escena.webm", { exact: true })).toBeVisible();
    await expect(page.getByText(/Comprobando qué formatos/)).toBeHidden({ timeout: 10_000 });
    const opus = page.locator('[role="radio"][data-format="opus"]');
    test.skip((await opus.getAttribute("aria-disabled")) === "true", "este navegador no crea Opus");
    await opus.click();
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("escena.opus");
    expect(bytes.toString("ascii", 0, 4)).toBe("OggS");
    const decoded = await page.evaluate(async (base64) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const buffer = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(data.buffer);
      return { duration: buffer.duration, rate: buffer.sampleRate };
    }, bytes.toString("base64"));
    expect(decoded.rate).toBe(48000);
    expect(decoded.duration).toBeGreaterThan(0.9);
    expect(decoded.duration).toBeLessThan(2.0);
  });

  test("un video SIN pista de audio se explica en la lista y «Procesar» queda desactivado con el motivo", async ({ page }) => {
    await open(page);
    const mute = await recordWebm(page, { audio: false, video: true, ms: 900 });
    await input(page).setInputFiles({ name: "mudo.webm", mimeType: "video/webm", buffer: mute });
    await expect(page.getByText("mudo.webm", { exact: true })).toBeVisible();
    await expect(page.getByText("Este video no tiene pista de audio: no hay nada que extraer.")).toBeVisible();
    await expect(run(page)).toBeDisabled();
    await expect(page.locator("[data-run-reason]").first()).toContainText(/pista de audio/);
    // Quitarlo devuelve la zona de carga con el foco en su boton.
    await page.getByRole("button", { name: "Quitar mudo.webm" }).click();
    await expect(page.getByRole("heading", { name: "Suelta tu video aquí" })).toBeVisible();
  });

  test("solo admite UN video a la vez y un audio se descarta con aviso", async ({ page }) => {
    await open(page);
    expect(await input(page).evaluate((element) => (element as HTMLInputElement).multiple)).toBe(false);
    await expect(page.getByText(/hasta 2,0 GB/)).toBeVisible();
    const webm = await recordWebm(page, { audio: true, video: true, ms: 600 });
    // El selector de un solo archivo no admite varios; arrastrando si podrian llegar: aqui, uno que no es video.
    await input(page).setInputFiles({ name: "cancion.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.2, sampleRate: 8000, channels: 1 }) });
    await expect(page.getByText(/No se añadió porque no es un video: cancion\.wav/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Suelta tu video aquí" })).toBeVisible();
    await input(page).setInputFiles({ name: "bien.webm", mimeType: "video/webm", buffer: webm });
    await expect(page.getByText("bien.webm", { exact: true })).toBeVisible();
  });

  test("ingles y teclado: se llega a «Process» con Tab y se descarga", async ({ browser }) => {
    const context = await audioContext(browser, { width: 1280, language: "en" });
    const page = await context.newPage();
    try {
      await open(page);
      const webm = await recordWebm(page, { audio: true, video: true, ms: 700 });
      await expect(page.getByRole("heading", { name: "Drop your video here" })).toBeVisible();
      await input(page).setInputFiles({ name: "short.webm", mimeType: "video/webm", buffer: webm });
      await expect(page.getByText("short.webm", { exact: true })).toBeVisible();
      await expect(run(page)).toBeEnabled();
      let reached = false;
      for (let i = 0; i < 40 && !reached; i += 1) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Process");
      }
      expect(reached, "Tab reaches Process").toBe(true);
      await page.keyboard.press("Enter");
      await expect(download(page)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Audio extracted from the video.")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

const MATRIX: Array<{ width: number; theme: Theme; language: Language; wide: boolean }> = [
  { width: 1280, theme: "light", language: "es", wide: false },
  { width: 375, theme: "dark", language: "en", wide: true },
  { width: 320, theme: "light", language: "es", wide: true },
];

test.describe("Extraer audio · accesibilidad y maquetacion", () => {
  for (const cell of MATRIX) {
    test(`axe 0 y sin desborde: ${cell.width}px · ${cell.theme} · ${cell.language}${cell.wide ? " · tipografia ancha" : ""}`, async ({ browser }) => {
      const context = await audioContext(browser, { ...cell, touch: cell.width < 600 });
      const page = await context.newPage();
      try {
        await open(page);
        const empty = await runAxe(page);
        expect(empty, `vacio\n${describeViolations(empty)}`).toEqual([]);
        expect((await measureOverflow(page)).overflow, "vacio").toBeLessThanOrEqual(1);
        const webm = await recordWebm(page, { audio: false, video: true, ms: 600 });
        await input(page).setInputFiles({ name: "video-sin-sonido-con-un-nombre-muy-largo-para-probar-el-corte.webm", mimeType: "video/webm", buffer: webm });
        await expect(page.getByText(/video-sin-sonido/)).toBeVisible();
        await expect(page.getByText(/no tiene pista de audio|has no audio track/)).toBeVisible();
        const withFile = await runAxe(page);
        expect(withFile, `con archivo\n${describeViolations(withFile)}`).toEqual([]);
        const measured = await measureOverflow(page);
        expect(measured.overflow, JSON.stringify(measured.offenders)).toBeLessThanOrEqual(1);
        expect(measured.offenders).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
