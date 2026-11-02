import { writeFileSync } from "node:fs";
import { expect, test, type Page, type Worker } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import {
  audioContext,
  describeViolations,
  makeWav,
  measureOverflow,
  recordWebm,
  runAxe,
  type Language,
  type Theme,
} from "../helpers/audio-flow";

/**
 * Salida MP3 (OptimusTOOLS · W-MP3), en Chromium headless con el decodificador REAL del navegador:
 *  - Convertidor de audio, Audio Studio y Extraer audio exportan MP3 con LAME (WebAssembly, en un Worker propio);
 *  - el archivo descargado se decodifica con `decodeAudioData` y se comprueban duracion (+-50 ms), frecuencia, canales y los
 *    tonos de cada canal; la cabecera se lee aqui (version, tasa de bits, frecuencia) sin usar el codigo del producto;
 *  - la politica CSP trae `worker-src blob:` y `'wasm-unsafe-eval'` y la pagina no registra ninguna violacion (el Worker y el WASM
 *    SIN `'unsafe-eval'`, con la politica de produccion, se prueban en `audio-converter-engine.spec.ts`);
 *  - ninguna peticion sale del origen ni lleva cuerpo; el Worker nace al empezar y desaparece al terminar o cancelar;
 *  - sin WebAssembly SIMD o sin Worker, MP3 sale desactivado con su motivo; si el Worker no se puede crear, el error lo explica;
 *  - ES/EN, axe 0 y sin desborde a 320 px con MP3 elegido (credito a LAME visible).
 * Los audios son senos generados en la propia prueba.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(180_000);

const input = (page: Page) => page.locator('input[type="file"]').first();
const run = (page: Page) => page.getByRole("button", { name: /^(Procesar|Process)$/ }).first();
const download = (page: Page) => page.getByRole("button", { name: /^(Descargar|Download)$/ });
const mp3Radio = (page: Page) => page.locator('[role="radio"][data-format="mp3"]');

/* ------------------------------------------------------------------ *
 * Piezas de la prueba
 * ------------------------------------------------------------------ */

/**
 * Politica CSP con que se sirve cada documento y violaciones de CSP que ve la pagina. El servidor de desarrollo emite la de
 * produccion MAS `'unsafe-eval'` (React lo exige en desarrollo para reconstruir pilas de llamadas), asi que aqui se comprueba
 * que la politica trae lo que LAME necesita (`worker-src blob:` y `'wasm-unsafe-eval'`) y que nada se bloquea; que el Worker y el
 * WASM funcionan SIN `'unsafe-eval'` se prueba aparte, con el motor y la politica de produccion (`audio-converter-engine.spec.ts`).
 */
async function watchCsp(page: Page): Promise<{ violations: () => Promise<string[]>; policies: string[] }> {
  const policies: string[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "document") return;
    const policy = response.headers()["content-security-policy"];
    if (policy) policies.push(policy);
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  return { violations: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), policies };
}

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

/** Errores y avisos de consola y errores de la pagina (mediabunny avisa por consola, p. ej., de una `AudioSample` sin cerrar). */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message.slice(0, 300)}`));
  return problems;
}

/** Workers vivos de la pagina (el de LAME nace de un blob). */
function watchWorkers(page: Page) {
  const created: Worker[] = [];
  page.on("worker", (worker) => created.push(worker));
  return { created, alive: () => page.workers().length };
}

type Mp3Header = { version: "MPEG-1" | "MPEG-2" | "MPEG-2.5"; kbps: number; sampleRate: number; channels: 1 | 2; frameKbps: Set<number>; frames: number; hasId3: boolean; xingTag: string; consumed: number };

const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Recorre las tramas del MP3 una a una (sin usar el codigo del producto) y devuelve lo que dice la cabecera. */
function readMp3(bytes: Buffer): Mp3Header {
  const hasId3 = bytes.toString("ascii", 0, 3) === "ID3";
  let pos = 0;
  let frames = 0;
  const frameKbps = new Set<number>();
  let first: { version: number; sampleRate: number; channels: 1 | 2; side: number } | null = null;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) throw new Error(`sin sincronismo de trama en ${pos}`);
    const version = (bytes[pos + 1] >> 3) & 3;
    if (((bytes[pos + 1] >> 1) & 3) !== 1) throw new Error("no es Capa III");
    const kbps = (version === 3 ? KBPS_V1 : KBPS_V2)[bytes[pos + 2] >> 4];
    const sampleRate = RATES[version][(bytes[pos + 2] >> 2) & 3];
    const padding = (bytes[pos + 2] >> 1) & 1;
    const channels = ((bytes[pos + 3] >> 6) & 3) === 3 ? 1 : 2;
    if (!kbps || !sampleRate) throw new Error("cabecera invalida");
    const samples = version === 3 ? 1152 : 576;
    first ??= { version, sampleRate, channels, side: version === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17 };
    frameKbps.add(kbps);
    frames += 1;
    pos += Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  }
  if (!first) throw new Error("sin tramas");
  const xingTag = bytes.toString("ascii", 4 + first.side, 8 + first.side);
  const dominant = [...frameKbps].sort((a, b) => b - a)[0];
  return {
    version: first.version === 3 ? "MPEG-1" : first.version === 2 ? "MPEG-2" : "MPEG-2.5",
    kbps: dominant,
    sampleRate: first.sampleRate,
    channels: first.channels,
    frameKbps,
    frames,
    hasId3,
    xingTag,
    consumed: pos,
  };
}

type Decoded = { duration: number; rate: number; channels: number; frequencies: number[]; rms: number; at: number[][] };

/**
 * Decodifica el MP3 con el decodificador de Chromium y mide cada canal en un tramo de 0,3 s: `frequencies`/`rms` en el centro del
 * audio y `at[i]` (una frecuencia por canal) alrededor de cada instante de `centers` (segundos).
 */
async function decodeInPage(page: Page, bytes: Buffer, sampleRate: number, centers: number[] = []): Promise<Decoded> {
  return page.evaluate(
    async ({ base64, rate, instants }) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const buffer = await new OfflineAudioContext(2, 1, rate).decodeAudioData(data.buffer);
      const measure = (centerFrame: number) => {
        const from = Math.max(1, centerFrame - Math.round(rate * 0.15));
        const to = Math.min(buffer.length, centerFrame + Math.round(rate * 0.15));
        const frequencies: number[] = [];
        let rms = 0;
        for (let c = 0; c < buffer.numberOfChannels; c += 1) {
          const samples = buffer.getChannelData(c);
          let crossings = 0;
          let sum = 0;
          for (let i = from; i < to; i += 1) {
            if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
            sum += samples[i] * samples[i];
          }
          frequencies.push((crossings * rate) / (to - from));
          rms = Math.max(rms, Math.sqrt(sum / (to - from)));
        }
        return { frequencies, rms };
      };
      const middle = measure(Math.round(buffer.length / 2));
      return {
        duration: buffer.duration,
        rate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        frequencies: middle.frequencies,
        rms: middle.rms,
        at: instants.map((seconds) => measure(Math.round(seconds * rate)).frequencies),
      };
    },
    { base64: bytes.toString("base64"), rate: sampleRate, instants: centers },
  );
}

const near = (value: number, target: number, tolerance: number) => expect(Math.abs(value - target), `${value} vs ${target}`).toBeLessThanOrEqual(tolerance);

async function openConverter(page: Page) {
  // «networkidle»: el HTML sale del servidor antes de hidratar; un archivo antes de eso se perderia.
  await page.goto("/audio-converter", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: /Convertidor de audio|Audio Converter/ })).toBeVisible();
}

async function chooseMp3(page: Page) {
  await expect(page.getByText(/Comprobando qué formatos|Checking which formats/)).toBeHidden({ timeout: 10_000 });
  await expect(mp3Radio(page)).toHaveAttribute("aria-disabled", "false");
  await mp3Radio(page).click();
  await expect(mp3Radio(page)).toHaveAttribute("aria-checked", "true");
}

/* ------------------------------------------------------------------ *
 * Convertidor de audio
 * ------------------------------------------------------------------ */

test.describe("MP3 · Convertidor de audio", () => {
  test("WAV estereo -> MP3 192 kbps: cabecera, sin ID3, decodificado por el navegador (duracion +-50 ms, tonos L/R), Worker propio y nada sale de la pagina", async ({ page }) => {
    const csp = await watchCsp(page);
    const network = watchNetwork(page);
    const workers = watchWorkers(page);
    const consoleProblems = watchConsole(page);
    await openConverter(page);
    await input(page).setInputFiles({ name: "voz.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 2, sampleRate: 44100, channels: 2, frequency: 440 }) });
    await expect(page.getByText("voz.wav", { exact: true })).toBeVisible();
    await chooseMp3(page);
    await expect(page.getByLabel("Calidad (tasa de bits)")).toHaveValue("192");
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    await expect(download(page)).toBeFocused();
    await expect(page.getByText("1 audio convertido.")).toBeVisible();

    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("voz.mp3");
    const header = readMp3(bytes);
    expect(header).toMatchObject({ version: "MPEG-1", sampleRate: 44100, channels: 2, hasId3: false });
    expect(header.consumed).toBe(bytes.length);
    expect(header.frameKbps.has(192)).toBe(true);
    expect(header.xingTag).toMatch(/^(Xing|Info)$/);
    expect(bytes.length).toBeGreaterThan(40_000); // 2 s x 192 kbps = 48 kB
    expect(bytes.length).toBeLessThan(60_000);

    const decoded = await decodeInPage(page, bytes, 44100);
    near(decoded.duration, 2, 0.05);
    expect(decoded).toMatchObject({ rate: 44100, channels: 2 });
    for (const frequency of decoded.frequencies) near(frequency, 440, 12);
    expect(decoded.rms).toBeGreaterThan(0.3); // 0,5 de amplitud => 0,354

    // Arranco un Worker desde un blob, y no queda ninguno vivo al terminar.
    expect(workers.created.some((worker) => worker.url().startsWith("blob:"))).toBe(true);
    await expect.poll(() => workers.alive(), { timeout: 10_000 }).toBe(0);
    expect(await csp.violations()).toEqual([]);
    expect(consoleProblems).toEqual([]);
    expect(csp.policies.length).toBeGreaterThan(0);
    expect(csp.policies.every((policy) => policy.includes("'wasm-unsafe-eval'") && policy.includes("worker-src 'self' blob:"))).toBe(true);
    expect(network.foreign).toEqual([]);
    expect(network.bodies).toEqual([]);
  });

  test("opciones: 320 kbps, mono y 48 kHz desde un original estereo de 44,1 kHz; el tono sigue siendo el mismo", async ({ page }) => {
    await watchCsp(page);
    await openConverter(page);
    await input(page).setInputFiles({ name: "tono.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1.5, sampleRate: 44100, channels: 2, frequency: 880 }) });
    await expect(page.getByText("tono.wav", { exact: true })).toBeVisible();
    await chooseMp3(page);
    await page.getByLabel("Calidad (tasa de bits)").selectOption("320");
    await page.getByLabel("Frecuencia de muestreo").selectOption("48000");
    await page.getByRole("radio", { name: "Mono" }).click();
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("tono.mp3");
    const header = readMp3(bytes);
    expect(header).toMatchObject({ version: "MPEG-1", sampleRate: 48000, channels: 1, hasId3: false });
    expect(header.frameKbps.has(320)).toBe(true);
    expect(header.consumed).toBe(bytes.length);
    const decoded = await decodeInPage(page, bytes, 48000);
    near(decoded.duration, 1.5, 0.05);
    expect(decoded.rate).toBe(48000);
    near(decoded.frequencies[0], 880, 20);
  });

  test("un MP3 de entrada vuelve a salir como MP3 (con sufijo «-convertido») y varios archivos van a un ZIP con .mp3 dentro", async ({ page }) => {
    await watchCsp(page);
    await openConverter(page);
    // Primero se crea un MP3 de verdad, luego se usa como entrada.
    await input(page).setInputFiles({ name: "base.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: 44100, channels: 1, frequency: 523 }) });
    await chooseMp3(page);
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    const first = await downloadFile(page, () => download(page).click());
    expect(first.filename).toBe("base.mp3");

    await openConverter(page);
    await input(page).setInputFiles([
      { name: "base.mp3", mimeType: "audio/mpeg", buffer: first.bytes },
      { name: "otro.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.6, sampleRate: 22050, channels: 1, frequency: 330 }) },
    ]);
    await expect(page.getByText("base.mp3", { exact: true })).toBeVisible();
    await chooseMp3(page);
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("2 audios convertidos y reunidos en un ZIP.")).toBeVisible();
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync((await downloadFile(page, () => download(page).click())).bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["base-convertido.mp3", "otro.mp3"]);
    for (const name of Object.keys(zip.files)) {
      const mp3 = Buffer.from(await zip.files[name].async("uint8array"));
      expect(readMp3(mp3).consumed, name).toBe(mp3.length);
    }
  });

  test("cancelar a mitad de una conversion larga: vuelve a la lista con el aviso, no se descarga nada, el Worker desaparece y la pagina responde", async ({ page }) => {
    await watchCsp(page);
    const workers = watchWorkers(page);
    await openConverter(page);
    // 30 minutos mono a 22,05 kHz (~80 MB, por ruta porque `setInputFiles` no admite buffers de mas de 50 MB): LAME tarda decenas de
    // segundos, de sobra para cancelar con el Worker ya activo.
    const longFile = test.info().outputPath("largo.wav");
    writeFileSync(longFile, makeWav({ seconds: 1800, sampleRate: 22050, channels: 1, frequency: 440 }));
    await input(page).setInputFiles(longFile);
    await expect(page.getByText("largo.wav", { exact: true })).toBeVisible();
    await expect(run(page)).toBeEnabled({ timeout: 30_000 });
    await chooseMp3(page);
    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    await run(page).click();
    await expect.poll(() => workers.created.filter((worker) => worker.url().startsWith("blob:")).length, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: /^(Cancelar|Cancel)$/ }).click();
    await expect(page.getByText("Proceso cancelado.")).toBeVisible();
    await expect(download(page)).toHaveCount(0);
    await expect(page.getByText("largo.wav", { exact: true })).toBeVisible();
    await expect.poll(() => workers.alive(), { timeout: 10_000 }).toBe(0);
    await expect(run(page)).toBeEnabled();
    // La pestana no se colgo: se puede seguir usando (cambiar de formato y volver).
    await page.locator('[role="radio"][data-format="wav"]').click();
    await expect(page.locator('[role="radio"][data-format="wav"]')).toHaveAttribute("aria-checked", "true");
    expect(downloaded).toBe(false);
  });

  test("los tonos distintos de cada canal sobreviven al MP3 (estereo real: 440 Hz a la izquierda, 880 Hz a la derecha)", async ({ page }) => {
    await watchCsp(page);
    await openConverter(page);
    await input(page).setInputFiles({ name: "lr.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: 44100, channels: 2, frequency: 440, frequencyRight: 880 }) });
    await expect(page.getByText("lr.wav", { exact: true })).toBeVisible();
    await chooseMp3(page);
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    const { bytes } = await downloadFile(page, () => download(page).click());
    const decoded = await decodeInPage(page, bytes, 44100);
    near(decoded.duration, 1, 0.05);
    near(decoded.frequencies[0], 440, 12);
    near(decoded.frequencies[1], 880, 24);
  });
});

/* ------------------------------------------------------------------ *
 * Carga perezosa
 * ------------------------------------------------------------------ */

/** Cuerpo de los scripts que se cargan, para saber si alguno trae el codificador (se reconoce por su marca global). */
function watchEncoderChunks(page: Page) {
  const withEncoder: string[] = [];
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    pending.push(
      response.text().then(
        (text) => {
          if (text.includes("@mediabunny/mp3-encoder loaded")) withEncoder.push(new URL(response.url()).pathname);
        },
        () => undefined,
      ),
    );
  });
  return { withEncoder: async () => (await Promise.all(pending), [...withEncoder]) };
}

test.describe("MP3 · carga perezosa", () => {
  test("ninguna ruta trae el codificador al abrirse ni al convertir a WAV; solo al elegir MP3 y procesar se descarga su trozo (una vez)", async ({ page }) => {
    const chunks = watchEncoderChunks(page);
    for (const route of ["/", "/audio-converter", "/audio-extractor", "/audio-studio", "/video-converter", "/licenses", "/image-converter"]) {
      await page.goto(route, { waitUntil: "networkidle" });
    }
    expect(await chunks.withEncoder(), "al abrir las rutas").toEqual([]);

    await openConverter(page);
    await input(page).setInputFiles({ name: "a.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.4, sampleRate: 22050, channels: 1 }) });
    await expect(page.getByText("a.wav", { exact: true })).toBeVisible();
    await expect(page.getByText(/Comprobando qué formatos/)).toBeHidden({ timeout: 10_000 });
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    expect(await chunks.withEncoder(), "tras convertir a WAV (y con MP3 solo ofrecido)").toEqual([]);

    await openConverter(page);
    await input(page).setInputFiles({ name: "b.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.4, sampleRate: 22050, channels: 1 }) });
    await chooseMp3(page);
    expect(await chunks.withEncoder(), "con MP3 elegido pero sin procesar").toEqual([]);
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    const loaded = await chunks.withEncoder();
    expect(loaded.length, `trozos con el codificador: ${loaded}`).toBe(1);
    test.info().annotations.push({ type: "chunk", description: `el codificador viaja solo en ${loaded[0]}` });
  });
});

/* ------------------------------------------------------------------ *
 * Degradacion honesta
 * ------------------------------------------------------------------ */

test.describe("MP3 · navegador sin capacidades", () => {
  test("sin WebAssembly con SIMD: MP3 desactivado con su motivo (y no se puede elegir ni con teclado); el resto sigue funcionando", async ({ page }) => {
    await page.addInitScript(() => {
      const original = WebAssembly.validate.bind(WebAssembly);
      // Un motor que entiende WebAssembly pero no SIMD (p. ej. Safari anterior a 16.4): el modulo de prueba con `v128` no valida.
      WebAssembly.validate = (bytes: BufferSource) => {
        const view = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : (bytes as ArrayBufferView).buffer);
        return view.includes(253) ? false : original(bytes);
      };
    });
    await openConverter(page);
    await input(page).setInputFiles({ name: "a.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.3, sampleRate: 8000, channels: 1 }) });
    await expect(page.getByText(/Comprobando qué formatos/)).toBeHidden({ timeout: 10_000 });
    await expect(mp3Radio(page)).toHaveAttribute("aria-disabled", "true");
    const reasonId = await mp3Radio(page).getAttribute("aria-describedby");
    await expect(page.locator(`[id="${reasonId}"]`)).toContainText(/WebAssembly con SIMD/);
    await expect(page.locator(`[id="${reasonId}"]`)).not.toContainText(/LGPL/);
    await mp3Radio(page).click({ force: true });
    await mp3Radio(page).focus();
    await page.keyboard.press("Enter");
    await expect(mp3Radio(page)).toHaveAttribute("aria-checked", "false");
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
    expect((await downloadFile(page, () => download(page).click())).filename).toBe("a-convertido.wav");
  });

  test("sin Worker: MP3 desactivado y el motivo habla de procesos en segundo plano (en ingles tambien)", async ({ browser }) => {
    const context = await audioContext(browser, { width: 1280, language: "en" });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        Object.defineProperty(window, "Worker", { value: undefined, configurable: true });
      });
      await openConverter(page);
      await input(page).setInputFiles({ name: "a.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.3, sampleRate: 8000, channels: 1 }) });
      await expect(page.getByText("Checking which formats your browser supports…")).toBeHidden({ timeout: 10_000 });
      await expect(mp3Radio(page)).toHaveAttribute("aria-disabled", "true");
      const reasonId = await mp3Radio(page).getAttribute("aria-describedby");
      await expect(page.locator(`[id="${reasonId}"]`)).toContainText(/does not let the MP3 encoder run in the background/);
    } finally {
      await context.close();
    }
  });

  test("si el Worker existe pero el navegador se niega a crearlo (CSP, extension, modo de bloqueo): el error lo explica con MP3 y WAV/M4A como salida, los archivos siguen en la lista y la pestana no se cuelga", async ({ page }) => {
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.Worker = class extends Original {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (String(url).startsWith("blob:")) throw new DOMException("bloqueado por la prueba", "SecurityError");
          super(url, options);
        }
      };
    });
    await openConverter(page);
    await input(page).setInputFiles({ name: "a.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: 22050, channels: 1 }) });
    await chooseMp3(page);
    await run(page).click();
    const alert = page.locator("[data-error-banner]");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText("Tu navegador no puede crear el formato elegido.");
    await expect(alert).toContainText(/Si era MP3, puede que algo bloquee WebAssembly o los procesos en segundo plano/);
    await expect(page.getByText("a.wav", { exact: true })).toBeVisible();
    await page.locator('[role="radio"][data-format="wav"]').click();
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 60_000 });
  });
});

/* ------------------------------------------------------------------ *
 * Audio Studio
 * ------------------------------------------------------------------ */

test.describe("MP3 · Audio Studio", () => {
  test("unir dos clips, quitar un tramo y exportar a MP3: el archivo dura lo editado (+-50 ms), conserva los tonos de cada tramo y no lleva etiquetas", async ({ page }) => {
    const csp = await watchCsp(page);
    const network = watchNetwork(page);
    const workers = watchWorkers(page);
    const consoleProblems = watchConsole(page);
    await page.goto("/audio-studio", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: "Audio Studio" })).toBeVisible();
    await input(page).setInputFiles([
      { name: "voz.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: 44100, channels: 2, frequency: 440 }) },
      { name: "aviso.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: 44100, channels: 2, frequency: 880 }) },
    ]);
    await expect(page.getByRole("slider", { name: /Forma de onda del audio|Audio waveform/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("wave-summary")).toHaveText("Duración 0:01.50. Cursor en 0:00.00. Sin selección.");

    // Se quitan 0,25 s del principio: 1,25 s de resultado (0,75 s de 440 Hz y 0,5 s de 880 Hz).
    for (const [label, value] of [["Inicio (segundos)", "0"], ["Fin (segundos)", "0.25"]] as const) {
      const field = page.getByLabel(label, { exact: true });
      await field.fill(value);
      await field.blur();
    }
    await page.getByRole("button", { name: "Quitar la selección" }).click();
    await expect(page.getByTestId("wave-summary")).toHaveText("Duración 0:01.25. Cursor en 0:00.00. Sin selección.");

    await chooseMp3(page);
    await page.getByLabel("Calidad (tasa de bits)").selectOption("256");
    await page.getByRole("button", { name: "Exportar audio" }).click();
    const result = page.getByTestId("export-result");
    await expect(result).toBeVisible({ timeout: 90_000 });
    await expect(result).toContainText("voz-editado.mp3");
    await expect(result).toContainText("0:01.25");
    await expect(download(page)).toBeFocused();

    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("voz-editado.mp3");
    const header = readMp3(bytes);
    expect(header).toMatchObject({ version: "MPEG-1", sampleRate: 44100, channels: 2, hasId3: false });
    expect(header.frameKbps.has(256)).toBe(true);
    expect(header.consumed).toBe(bytes.length);
    const decoded = await decodeInPage(page, bytes, 44100, [0.35, 1.0]);
    near(decoded.duration, 1.25, 0.05);
    // 0,25 - 1,0 s del original son la voz (440 Hz, hasta 0,75 s en lo editado) y luego el aviso (880 Hz, de 0,75 a 1,25 s).
    for (const frequency of decoded.at[0]) near(frequency, 440, 12);
    for (const frequency of decoded.at[1]) near(frequency, 880, 24);
    expect(workers.created.some((worker) => worker.url().startsWith("blob:"))).toBe(true);
    await expect.poll(() => workers.alive(), { timeout: 10_000 }).toBe(0);
    expect(await csp.violations()).toEqual([]);
    expect(consoleProblems).toEqual([]);
    expect(network.foreign).toEqual([]);
    expect(network.bodies).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Extraer audio
 * ------------------------------------------------------------------ */

test.describe("MP3 · Extraer audio", () => {
  test("un WebM real con sonido -> MP3: el navegador lo decodifica con una duracion parecida a la del video y el tono de 440 Hz", async ({ page }) => {
    await watchCsp(page);
    await page.goto("/audio-extractor", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: /Extraer audio|Extract audio/ })).toBeVisible();
    const webm = await recordWebm(page, { audio: true, video: true, ms: 1600 });
    await input(page).setInputFiles({ name: "clip.webm", mimeType: "video/webm", buffer: webm });
    await expect(page.getByText("clip.webm", { exact: true })).toBeVisible();
    await expect(run(page)).toBeEnabled();
    await chooseMp3(page);
    await run(page).click();
    await expect(download(page)).toBeVisible({ timeout: 90_000 });
    const { bytes, filename } = await downloadFile(page, () => download(page).click());
    expect(filename).toBe("clip.mp3");
    const header = readMp3(bytes);
    expect(header.consumed).toBe(bytes.length);
    expect(header).toMatchObject({ sampleRate: 48000, hasId3: false });
    const decoded = await decodeInPage(page, bytes, 48000);
    expect(decoded.duration).toBeGreaterThan(1.1);
    expect(decoded.duration).toBeLessThan(2.3);
    near(decoded.frequencies[0], 440, 14);
  });
});

/* ------------------------------------------------------------------ *
 * Accesibilidad y maquetacion con MP3 elegido
 * ------------------------------------------------------------------ */

const MATRIX: Array<{ width: number; theme: Theme; language: Language; wide: boolean }> = [
  { width: 1280, theme: "dark", language: "es", wide: false },
  { width: 375, theme: "light", language: "en", wide: false },
  { width: 320, theme: "dark", language: "es", wide: true },
  { width: 320, theme: "light", language: "en", wide: true },
];

test.describe("MP3 · accesibilidad y maquetacion", () => {
  for (const cell of MATRIX) {
    test(`axe 0, sin desborde y credito a LAME visible: ${cell.width}px · ${cell.theme} · ${cell.language}${cell.wide ? " · tipografia ancha" : ""}`, async ({ browser }) => {
      const context = await audioContext(browser, { ...cell, touch: cell.width < 600 });
      const page = await context.newPage();
      try {
        await openConverter(page);
        await input(page).setInputFiles({ name: "grabacion-con-un-nombre-bastante-largo-para-probar.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.4, sampleRate: 8000, channels: 1 }) });
        await expect(page.getByText(/grabacion-con-un-nombre/)).toBeVisible();
        if (cell.width < 768) {
          await page.getByRole("button", { name: /^(Opciones|Options)$/ }).click();
          await expect(page.getByRole("dialog")).toBeVisible();
        }
        await chooseMp3(page);
        const credit = page.locator("[data-mp3-credit]");
        await expect(credit).toBeVisible();
        await expect(credit).toContainText(cell.language === "es" ? "Codificación MP3 por LAME" : "MP3 encoding by LAME");
        const lame = credit.getByRole("link", { name: /LAME/ });
        await expect(lame).toHaveAttribute("href", "https://lame.sourceforge.io/");
        await expect(credit.getByRole("link", { name: /Licen[cs]es|Licencias/ })).toHaveAttribute("href", "/licenses#mp3");

        const axe = await runAxe(page);
        expect(axe, `axe\n${describeViolations(axe)}`).toEqual([]);
        const measured = await measureOverflow(page);
        expect(measured.overflow, JSON.stringify(measured.offenders)).toBeLessThanOrEqual(1);
        expect(measured.offenders).toEqual([]);

        // Con tacto, los enlaces del credito miden al menos 44 px de alto.
        if (cell.width < 600) {
          const heights = await credit.locator("a").evaluateAll((anchors) => anchors.map((anchor) => Math.round(anchor.getBoundingClientRect().height)));
          for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
        }
      } finally {
        await context.close();
      }
    });
  }
});
