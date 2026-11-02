import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { build } from "vite";
import { downloadBytes } from "../helpers/downloads";
import { smallTargets } from "../helpers/touch-measure";
import { STRINGS } from "../../src/app/video-converter/strings";

/**
 * Convertidor de video · de punta a punta en Chromium sin ventana.
 *
 * Los videos NO se guardan en el repositorio: se generan DENTRO de la prueba (`video-converter.fixture-entry.ts`, empaquetado con
 * Vite y ejecutado en la pagina con los codificadores del propio navegador) y se vuelven a abrir tal cual con un `<video>` real,
 * que es la comprobacion independiente de que el resultado se reproduce (medidas, duracion y un fotograma con color).
 *
 * Que NO se puede probar aqui y lo hace una persona en Safari/iPhone/iPad: ver `docs/PLAN-OPTIMUSTOOLS.md` (Video Converter).
 * Si el Chromium de esta maquina no codifica H.264/AAC (un Linux sin codecs propietarios), las partes de MP4 se omiten y se anota.
 */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const ES = STRINGS.es;
const EN = STRINGS.en;

type Language = "es" | "en";
type Theme = "light" | "dark";

type FixtureSpec = {
  container: "mp4" | "webm" | "mov";
  codec: "avc" | "vp9" | "vp8";
  width: number;
  height: number;
  fps: number;
  seconds: number;
  rotation?: 0 | 90 | 180 | 270;
  noise?: boolean;
  bitrate?: number;
  audio: "aac" | "opus" | null;
  audioOnly?: boolean;
};

let fixtureCode = "";

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    build: {
      write: false,
      minify: false,
      target: "es2022",
      rollupOptions: { output: { inlineDynamicImports: true } },
      lib: {
        entry: path.resolve(process.cwd(), "e2e/specs/video-converter.fixture-entry.ts"),
        name: "VideoFixture",
        formats: ["iife"],
        fileName: () => "video-fixture.js",
      },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el generador de videos");
  fixtureCode = chunk.code;
});

async function newContext(
  browser: Browser,
  options: { width?: number; height?: number; language?: Language; theme?: Theme; touch?: boolean; wide?: boolean; noWebCodecs?: boolean } = {},
): Promise<BrowserContext> {
  const { width = 1280, height = 900, language = "es", theme = "light", touch = false, wide = false, noWebCodecs = false } = options;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    hasTouch: touch,
    isMobile: touch && width < 768,
    deviceScaleFactor: touch ? 2 : 1,
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([themeValue, languageValue, wideCss, removeCodecs]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", themeValue as string);
        window.localStorage.setItem("optimuspdf.language", languageValue as string);
      } catch {
        /* almacenamiento bloqueado */
      }
      if (wideCss) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(wideCss as string);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      if (removeCodecs) {
        // Un navegador sin WebCodecs (Firefox/Safari antiguos): la API simplemente no existe.
        for (const name of ["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder"]) delete (window as unknown as Record<string, unknown>)[name];
      }
    },
    [
      theme,
      language,
      wide ? `html *, html *::before, html *::after { font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important; letter-spacing: 0.06em !important; }` : "",
      noWebCodecs,
    ],
  );
  return context;
}

async function open(page: Page): Promise<void> {
  await page.goto("/video-converter", { waitUntil: "networkidle" });
}

/** Lo que este Chromium puede codificar (decide si hay parte de MP4 en las pruebas). */
async function codecSupport(page: Page): Promise<{ mp4: boolean }> {
  return page.evaluate(async () => {
    const video = await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 }).then((r) => !!r.supported, () => false);
    const audio = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 }).then((r) => !!r.supported, () => false);
    return { mp4: video && audio };
  });
}

async function makeFixture(page: Page, spec: FixtureSpec): Promise<Buffer> {
  if (!(await page.evaluate(() => "VideoFixture" in window))) await page.addScriptTag({ content: fixtureCode });
  const base64 = await page.evaluate((fixture) => (window as unknown as { VideoFixture: { makeVideo: (s: unknown) => Promise<string> } }).VideoFixture.makeVideo(fixture), spec);
  return Buffer.from(base64, "base64");
}

type Playback = { ok: boolean; width: number; height: number; duration: number; mean: number };

/** Abre los bytes en un `<video>` real: medidas, duracion y el brillo medio de un fotograma del medio (no negro). */
async function play(page: Page, bytes: Buffer, mime: string): Promise<Playback> {
  return page.evaluate(
    async ({ base64, type }) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([data], { type }));
      const loaded = await new Promise<boolean>((resolve) => {
        video.onloadeddata = () => resolve(true);
        video.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 10_000);
      });
      if (!loaded) return { ok: false, width: 0, height: 0, duration: 0, mean: 0 };
      video.currentTime = video.duration / 2;
      await new Promise((resolve) => (video.onseeked = resolve));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
      URL.revokeObjectURL(video.src);
      return { ok: true, width: video.videoWidth, height: video.videoHeight, duration: video.duration, mean: sum / (pixels.length / 4) / 3 };
    },
    { base64: bytes.toString("base64"), type: mime },
  );
}

/**
 * Genera el video y lo entrega a la zona de carga SIN salir de la pagina: los pesados (ruido aleatorio, decenas de MB) no caben
 * en `setInputFiles` con un `Buffer` (tope de 50 MB) ni tiene sentido pasarlos por Node.
 */
async function chooseGenerated(page: Page, spec: FixtureSpec, name: string): Promise<void> {
  if (!(await page.evaluate(() => "VideoFixture" in window))) await page.addScriptTag({ content: fixtureCode });
  await page.evaluate(
    async ({ fixture, fileName }) => {
      const file = await (window as unknown as { VideoFixture: { makeVideoFile: (s: unknown, n: string) => Promise<File> } }).VideoFixture.makeVideoFile(fixture, fileName);
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { fixture: spec, fileName: name },
  );
}

async function chooseFile(page: Page, bytes: Buffer, name: string, mime: string): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: mime, buffer: bytes });
}

async function waitForOptions(page: Page, language: Language = "es"): Promise<void> {
  await expect(page.getByRole("heading", { name: (language === "es" ? ES : EN).estimateTitle })).toBeVisible({ timeout: 30_000 });
}

/**
 * Espera a que `selector` y todo lo que lleva dentro (y sus ancestros) terminen su animacion de entrada (opacidad 1): axe mide el
 * contraste con el texto ya opaco, no a medio fundido (WebKit tarda mas en asentarlas que Chromium).
 */
async function expectOpaque(page: Page, selector: string, deep = true): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ query, inner }) => {
          const root = document.querySelector(query);
          if (!root) return false;
          for (let el: Element | null = root; el; el = el.parentElement) if (getComputedStyle(el).opacity !== "1") return false;
          // `inner: false` para el dialogo de progreso: su indicador giratorio tiene aspas con opacidad parcial A PROPOSITO.
          return !inner || [...root.querySelectorAll("*")].every((el) => getComputedStyle(el).opacity === "1");
        },
        { query: selector, inner: deep },
      ),
    )
    .toBe(true);
}

/** Pulsa «Convertir» y devuelve el archivo descargado cuando termina. */
async function convertAndDownload(page: Page, checkA11y = false): Promise<{ bytes: Buffer; summary: string }> {
  await page.getByRole("button", { name: ES.run, exact: true }).click();
  const download = page.getByRole("button", { name: "Descargar", exact: true });
  await expect(download).toBeVisible({ timeout: 120_000 });
  const summary = (await page.locator("[data-download-summary]").innerText()).trim();
  if (checkA11y) {
    await expectOpaque(page, '[aria-labelledby="download-title"]');
    expect(await runAxe(page), "axe en la pantalla de resultado").toEqual([]);
  }
  const bytes = await downloadBytes(page, () => download.click());
  return { bytes, summary };
}

const pickFormat = (page: Page, name: "MP4" | "WebM") => page.getByRole("tab", { name, exact: true }).click();
const pickResolution = (page: Page, name: string) => page.getByRole("tab", { name, exact: true }).click();
const pickQuality = (page: Page, name: string) => page.getByRole("radio", { name }).click();

test.describe.configure({ mode: "serial" });

test("convierte entre MP4 y WebM con resolucion y calidad, en un worker y sin ninguna peticion con el video", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  const requests: Array<{ method: string; url: string }> = [];
  const workers: string[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  page.on("worker", (worker) => workers.push(worker.url()));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await open(page);
  const { mp4 } = await codecSupport(page);
  test.info().annotations.push({ type: "H.264+AAC", description: mp4 ? "disponible: se prueba MP4 completo" : "NO disponible en este Chromium: MP4 omitido" });
  const source = mp4
    ? { bytes: await makeFixture(page, { container: "mp4", codec: "avc", width: 1280, height: 720, fps: 30, seconds: 2, audio: "aac" }), name: "origen.mp4", mime: "video/mp4" }
    : { bytes: await makeFixture(page, { container: "webm", codec: "vp9", width: 1280, height: 720, fps: 30, seconds: 2, audio: "opus" }), name: "origen.webm", mime: "video/webm" };

  await chooseFile(page, source.bytes, source.name, source.mime);
  await waitForOptions(page);
  const card = page.locator("[data-video-card]");
  await expect(card).toContainText("1280 × 720");
  await expect(card).toContainText("0:02");
  await expect(card).toContainText(mp4 ? "H.264" : "VP9");

  // A WebM, 480p, calidad equilibrada: se recodifica y cambia de medidas.
  await pickFormat(page, "WebM");
  await pickResolution(page, "480p");
  await pickQuality(page, ES.qualityBalanced);
  const webm = await convertAndDownload(page, true);
  expect(webm.summary).toContain("WebM");
  expect(webm.summary).toContain("854 × 480");
  const playedWebm = await play(page, webm.bytes, "video/webm");
  expect(playedWebm.ok, "el WebM resultante debe abrirse en un <video> real").toBe(true);
  expect([playedWebm.width, playedWebm.height]).toEqual([854, 480]);
  expect(playedWebm.duration).toBeGreaterThan(1.7);
  expect(playedWebm.duration).toBeLessThan(2.5);
  expect(playedWebm.mean, "el fotograma del medio no debe ser negro").toBeGreaterThan(15);

  // Otra vez desde cero: a MP4 con «Conservar» (si el origen ya es H.264 se copia sin recodificar).
  await page.getByRole("button", { name: "Empezar de nuevo" }).click();
  await chooseFile(page, source.bytes, source.name, source.mime);
  await waitForOptions(page);
  if (mp4) {
    // El estimado ya lo dice antes de convertir.
    await expect(page.locator("[data-video-estimate]")).toContainText("Sin recodificar");
    const copy = await convertAndDownload(page);
    expect(copy.summary).toContain("Sin recodificar");
    const playedMp4 = await play(page, copy.bytes, "video/mp4");
    expect(playedMp4.ok, "el MP4 resultante debe abrirse en un <video> real").toBe(true);
    expect([playedMp4.width, playedMp4.height]).toEqual([1280, 720]);
    expect(playedMp4.duration).toBeGreaterThan(1.7);
    expect(playedMp4.mean).toBeGreaterThan(15);

    // Y recodificado a MP4 pequeno: pesa menos que la copia.
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await chooseFile(page, source.bytes, source.name, source.mime);
    await waitForOptions(page);
    await pickQuality(page, ES.qualitySmall);
    await pickResolution(page, "480p");
    const small = await convertAndDownload(page);
    expect(small.bytes.length).toBeLessThan(copy.bytes.length);
    const playedSmall = await play(page, small.bytes, "video/mp4");
    expect([playedSmall.width, playedSmall.height]).toEqual([854, 480]);
  } else {
    await pickFormat(page, "WebM");
    const copy = await convertAndDownload(page);
    expect(copy.summary).toContain("Sin recodificar");
  }

  expect(workers.length, "la conversion corre en un Web Worker").toBeGreaterThan(0);
  const outside = requests.filter((request) => !/^(http:\/\/localhost:\d+\/|blob:|data:)/.test(request.url));
  expect(outside, "ninguna peticion sale de localhost").toEqual([]);
  expect(requests.filter((request) => request.method !== "GET" && !request.url.startsWith("blob:")), "ninguna peticion de escritura").toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test("respeta la rotacion del movil, redondea medidas impares, baja los fotogramas y quita el audio", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  await open(page);
  const { mp4 } = await codecSupport(page);

  if (mp4) {
    // Como un video de iPhone en vertical: se graba apaisado (640 x 360) y lleva «girar 90°».
    const rotated = await makeFixture(page, { container: "mp4", codec: "avc", width: 640, height: 360, fps: 30, seconds: 2, rotation: 90, audio: "aac" });
    await chooseFile(page, rotated, "iphone.mp4", "video/mp4");
    await waitForOptions(page);
    const card = page.locator("[data-video-card]");
    await expect(card).toContainText("360 × 640");
    await expect(card).toContainText("girado 90°");

    // MP4 con «Conservar»: se copia y la rotacion queda como dato (el navegador la aplica al reproducir).
    const asMp4 = await convertAndDownload(page);
    const playedMp4 = await play(page, asMp4.bytes, "video/mp4");
    expect([playedMp4.width, playedMp4.height], "el MP4 sigue en vertical").toEqual([360, 640]);

    // WebM no guarda rotacion: se gira la imagen de verdad y el resultado tambien sale en vertical.
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await chooseFile(page, rotated, "iphone.mp4", "video/mp4");
    await waitForOptions(page);
    await pickFormat(page, "WebM");
    await expect(page.locator("[data-issue='rotationBaked']")).toBeVisible();
    const asWebm = await convertAndDownload(page);
    const playedWebm = await play(page, asWebm.bytes, "video/webm");
    expect([playedWebm.width, playedWebm.height], "el WebM sale en vertical con la rotacion aplicada").toEqual([360, 640]);
    expect(playedWebm.mean).toBeGreaterThan(15);
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
  }

  // Medidas impares (481 x 271): el resultado recodificado sale con medidas pares.
  const odd = await makeFixture(page, { container: "webm", codec: "vp9", width: 481, height: 271, fps: 25, seconds: 2, audio: "opus" });
  await chooseFile(page, odd, "impar.webm", "video/webm");
  await waitForOptions(page);
  await pickQuality(page, ES.qualityBalanced);
  const evened = await convertAndDownload(page);
  const playedEven = await play(page, evened.bytes, "video/webm");
  expect(playedEven.ok).toBe(true);
  expect(playedEven.width % 2).toBe(0);
  expect(playedEven.height % 2).toBe(0);
  expect(Math.abs(playedEven.width - 481)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Empezar de nuevo" }).click();

  // 60 fps con audio -> tope de 30 fps y sin audio. El resultado se vuelve a abrir en la propia herramienta para leerlo.
  const fast = await makeFixture(page, { container: "webm", codec: "vp9", width: 640, height: 360, fps: 60, seconds: 2, audio: "opus" });
  await chooseFile(page, fast, "rapido.webm", "video/webm");
  await waitForOptions(page);
  await expect(page.locator("[data-video-card]")).toContainText("60 fps");
  await pickFormat(page, "WebM");
  await page.getByRole("tab", { name: "30 fps", exact: true }).click();
  await page.getByRole("switch", { name: ES.removeAudio }).click();
  const reduced = await convertAndDownload(page);
  await page.getByRole("button", { name: "Empezar de nuevo" }).click();
  await chooseFile(page, reduced.bytes, "resultado.webm", "video/webm");
  await waitForOptions(page);
  const info = page.locator("[data-video-info]");
  await expect(info).toContainText("30 fps");
  await expect(info).toContainText(ES.noAudio);
  await context.close();
});

test("cancelar a medias no deja nada a medias y se puede convertir despues", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  const workers: Array<{ url: string; closed: boolean }> = [];
  page.on("worker", (worker) => {
    const entry = { url: worker.url(), closed: false };
    workers.push(entry);
    worker.on("close", () => (entry.closed = true));
  });
  await open(page);
  const { mp4 } = await codecSupport(page);
  // Ruido aleatorio: el codificador no puede ir rapido y la conversion dura varios segundos.
  await chooseGenerated(
    page,
    mp4
      ? { container: "mp4", codec: "avc", width: 1280, height: 720, fps: 30, seconds: 15, noise: true, bitrate: 8_000_000, audio: "aac" }
      : { container: "webm", codec: "vp9", width: 1280, height: 720, fps: 30, seconds: 15, noise: true, bitrate: 8_000_000, audio: "opus" },
    mp4 ? "pesado.mp4" : "pesado.webm",
  );
  await waitForOptions(page);
  await pickQuality(page, ES.qualityBalanced);
  await page.getByRole("button", { name: ES.run, exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Progreso REAL: sube por encima de 0 antes de cancelar.
  await expect.poll(async () => Number(await dialog.getByRole("progressbar").getAttribute("aria-valuenow")), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toHaveCount(0);
  await expectOpaque(page, '[role="dialog"]', false);
  expect(await runAxe(page), "axe con el progreso a la vista").toEqual([]);
  await dialog.getByRole("button", { name: "Cancelar" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: ES.cancelled })).toBeVisible();
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: ES.run, exact: true })).toBeFocused();
  expect(workers.length).toBeGreaterThan(0);
  await expect.poll(() => workers.every((worker) => worker.closed), { message: "el worker se termina al cancelar" }).toBe(true);

  // Sigue usable: la misma pagina convierte despues (mas pequeno para que sea rapido).
  await pickQuality(page, ES.qualitySmall);
  await pickResolution(page, "480p");
  await page.getByRole("button", { name: ES.run, exact: true }).click();
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("status").filter({ hasText: ES.cancelled })).toHaveCount(0);
  await context.close();
});

test("dice la verdad cuando el archivo no sirve: ilegible, sin imagen o que no es un video", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  await open(page);

  await chooseFile(page, Buffer.from("esto no es un video, es texto ".repeat(60)), "roto.mp4", "video/mp4");
  const banner = page.getByRole("alert").filter({ hasText: ES.errors.unreadable.title });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(ES.errors.unreadable.message);
  await expect(banner).toContainText("roto.mp4");
  await expect(page.getByRole("button", { name: ES.run, exact: true })).toHaveCount(0);

  // «Quitar archivo» vuelve a la zona de carga.
  await banner.getByRole("button", { name: ES.removeFile }).click();
  await expect(page.locator("button", { hasText: "Seleccionar archivo" })).toBeVisible();

  // Un audio dentro de un MP4: es un contenedor valido, pero no hay imagen. Ofrece el convertidor de audio.
  const { mp4 } = await codecSupport(page);
  if (mp4) {
    const audioOnly = await makeFixture(page, { container: "mp4", codec: "avc", width: 16, height: 16, fps: 1, seconds: 2, audio: "aac", audioOnly: true });
    await chooseFile(page, audioOnly, "solo-audio.mp4", "video/mp4");
    const noPicture = page.getByRole("alert").filter({ hasText: ES.errors.noVideoTrack.title });
    await expect(noPicture).toBeVisible({ timeout: 30_000 });
    await expect(noPicture.getByRole("link", { name: ES.openAudioConverter })).toHaveAttribute("href", "/audio-converter");
    await noPicture.getByRole("button", { name: ES.removeFile }).click();
  }

  // Un archivo que no es un video ni por la extension: lo rechaza la zona de carga.
  await chooseFile(page, Buffer.from("hola"), "notas.txt", "text/plain");
  await expect(page.getByRole("alert").filter({ hasText: ES.invalidType.title })).toBeVisible();
  await context.close();
});

test("un navegador sin WebCodecs ve una pagina informativa, no un error ni una zona de carga", async ({ browser }) => {
  const context = await newContext(browser, { noWebCodecs: true });
  const page = await context.newPage();
  await open(page);
  const view = page.locator("[data-video-unsupported]");
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute("data-video-unsupported", "no-video-encoder");
  await expect(view.getByRole("heading", { name: ES.unsupportedTitle })).toBeVisible();
  await expect(view).toContainText(ES.unsupported["no-video-encoder"]);
  await expect(page.locator("[data-error-banner]")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(await runAxe(page)).toEqual([]);
  await context.close();

  const english = await newContext(browser, { noWebCodecs: true, language: "en" });
  const englishPage = await english.newPage();
  await open(englishPage);
  await expect(englishPage.getByRole("heading", { name: EN.unsupportedTitle })).toBeVisible();
  await english.close();
});

test("si el navegador no deja crear workers, convierte igualmente en el hilo principal", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await newContext(browser);
  await context.addInitScript(() => {
    // Un entorno que prohibe los Web Workers (politica del navegador, modo restringido): crear uno falla.
    window.Worker = class {
      constructor() {
        throw new Error("Web Workers no disponibles");
      }
    } as unknown as typeof Worker;
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  const source = await makeFixture(page, { container: "webm", codec: "vp9", width: 640, height: 360, fps: 30, seconds: 1, audio: "opus" });
  await chooseFile(page, source, "sin-worker.webm", "video/webm");
  await waitForOptions(page);
  await pickQuality(page, ES.qualityBalanced);
  const result = await convertAndDownload(page);
  const played = await play(page, result.bytes, "video/webm");
  expect(played.ok).toBe(true);
  expect([played.width, played.height]).toEqual([640, 360]);
  expect(errors).toEqual([]);
  await context.close();
});

test("en un iPhone avisa de los limites mas bajos y de mantener la pestana abierta", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    hasTouch: true,
    isMobile: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await context.addInitScript(() => window.localStorage.setItem("optimuspdf.language", "es"));
  const page = await context.newPage();
  await open(page);
  const note = page.locator("[data-video-constrained]");
  await expect(note).toBeVisible();
  await expect(note).toContainText(ES.constrainedNote);
  // Los limites mostrados son los de dispositivos con poca memoria (200 MB / 1 GB / 30 min), no los de escritorio.
  // Con un espacio duro entre el numero y la unidad (no se parte en dos lineas): `\\s` lo admite.
  await expect(page.getByText(/200\sMB/)).toBeVisible();
  await expect(page.getByText(/0:30:00|30:00/)).toBeVisible();
  await context.close();

  const desktop = await newContext(browser);
  const desktopPage = await desktop.newPage();
  await open(desktopPage);
  await expect(desktopPage.getByRole("heading", { name: ES.idleTitle })).toBeVisible();
  await expect(desktopPage.locator("[data-video-constrained]")).toHaveCount(0);
  await desktop.close();
});

async function runAxe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`);
  });
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

const CELLS: Array<{ width: number; language: Language; theme: Theme; wide: boolean }> = [
  { width: 320, language: "es", theme: "light", wide: true },
  { width: 320, language: "en", theme: "dark", wide: false },
  { width: 375, language: "es", theme: "dark", wide: false },
  { width: 375, language: "en", theme: "light", wide: true },
  { width: 1280, language: "es", theme: "light", wide: false },
  { width: 1280, language: "en", theme: "dark", wide: true },
];

test.describe("accesibilidad y diseno adaptable", () => {
  let small: Buffer;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await newContext(browser);
    const page = await context.newPage();
    await open(page);
    small = await makeFixture(page, { container: "webm", codec: "vp9", width: 1280, height: 720, fps: 30, seconds: 1, audio: "opus" });
    await context.close();
  });

  for (const cell of CELLS) {
    test(`${cell.width} px · ${cell.language} · ${cell.theme}${cell.wide ? " · tipografia ancha" : ""}: axe 0, sin desbordes, objetivos tactiles`, async ({ browser }) => {
      test.setTimeout(120_000);
      const touch = cell.width < 768;
      const context = await newContext(browser, { width: cell.width, height: touch ? 812 : 900, language: cell.language, theme: cell.theme, touch, wide: cell.wide });
      const page = await context.newPage();
      const s = cell.language === "es" ? ES : EN;
      await open(page);

      // 1. Reposo.
      await expect(page.getByRole("heading", { name: s.idleTitle })).toBeVisible();
      expect(await runAxe(page), "axe en reposo").toEqual([]);
      expect(await overflow(page), "desborde en reposo").toBe(0);
      if (touch) expect(await smallTargets(page, "main"), "objetivos < 44 px en reposo").toEqual([]);

      // 2. Con un video elegido (opciones: panel en escritorio, hoja en movil).
      await chooseFile(page, small, "clip.webm", "video/webm");
      await waitForOptions(page, cell.language);
      expect(await runAxe(page), "axe con el video elegido").toEqual([]);
      expect(await overflow(page), "desborde con el video elegido").toBe(0);
      if (touch) expect(await smallTargets(page, "main"), "objetivos < 44 px con el video").toEqual([]);

      if (touch) {
        await page.getByRole("button", { name: cell.language === "es" ? "Opciones" : "Options", exact: true }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByText(s.formatLabel)).toBeVisible();
        expect(await runAxe(page), "axe con la hoja de opciones").toEqual([]);
        expect(await overflow(page), "desborde con la hoja de opciones").toBe(0);
        expect(await smallTargets(page, '[role="dialog"]'), "objetivos < 44 px en la hoja").toEqual([]);
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();
      } else {
        await expect(page.getByRole("tab", { name: "WebM", exact: true })).toBeVisible();
      }

      // 3. Error legible (archivo roto).
      await page.getByRole("button", { name: s.removeFile }).first().click();
      await chooseFile(page, Buffer.from("no es un video ".repeat(80)), "roto.mp4", "video/mp4");
      const errorBanner = page.getByRole("alert").filter({ hasText: s.errors.unreadable.title });
      await expect(errorBanner).toBeVisible({ timeout: 30_000 });
      // El aviso entra con una animacion de opacidad: axe mide el contraste con el texto ya opaco, no a medio fundido.
      await expectOpaque(page, "[data-error-banner]");
      expect(await runAxe(page), "axe con el error").toEqual([]);
      expect(await overflow(page), "desborde con el error").toBe(0);
      if (touch) expect(await smallTargets(page, "main"), "objetivos < 44 px con el error").toEqual([]);
      await context.close();
    });
  }

  test("pagina informativa sin WebCodecs: sin desbordes a 320 y 375 px", async ({ browser }) => {
    for (const width of [320, 375]) {
      const context = await newContext(browser, { width, height: 812, touch: true, noWebCodecs: true, wide: true, language: "es", theme: "dark" });
      const page = await context.newPage();
      await open(page);
      await expect(page.locator("[data-video-unsupported]")).toBeVisible();
      expect(await runAxe(page)).toEqual([]);
      expect(await overflow(page)).toBe(0);
      expect(await smallTargets(page, "main")).toEqual([]);
      await context.close();
    }
  });
});
