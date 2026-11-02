/**
 * Piezas comunes de los E2E de audio (OptimusTOOLS · W-AUDIO): audio y video SINTETICOS generados aqui (nunca datos de
 * nadie), un lector de WAV independiente del motor (para no comprobar el codigo con el propio codigo), contextos con
 * tema/idioma/tipografia ancha, axe y la medida de desborde horizontal. SIEMPRE headless.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";

export const AXE_PATH = require.resolve("axe-core/axe.min.js");

/** Fuente ancha forzada (DejaVu Sans / Verdana) + 6 % de espaciado entre letras, como `sign-wide-font`. */
export const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

/* ------------------------------------------------------------------ *
 * WAV
 * ------------------------------------------------------------------ */

export type WavSpec = { seconds: number; sampleRate: number; channels: 1 | 2; frequency?: number; amplitude?: number; frequencyRight?: number };

/** WAV PCM de 16 bits con un seno (en todos los canales; con `frequencyRight`, el canal derecho lleva otro tono). */
export function makeWav({ seconds, sampleRate, channels, frequency = 440, amplitude = 0.5, frequencyRight }: WavSpec): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + frames * channels * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * channels * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * channels * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const tone = c === 1 && frequencyRight !== undefined ? frequencyRight : frequency;
      const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * tone * i) / sampleRate));
      buffer.writeInt16LE(value, 44 + (i * channels + c) * 2);
    }
  }
  return buffer;
}

export type WavInfo = { sampleRate: number; channels: number; frames: number; durationSec: number; samples: Float32Array[] };

/** Lector de WAV de 16 bits propio de la prueba (independiente de `src/lib/media/audio/wav.ts`). */
export function readWav(bytes: Buffer): WavInfo {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("no es un WAV");
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(offset + 10);
      sampleRate = bytes.readUInt32LE(offset + 12);
      bits = bytes.readUInt16LE(offset + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`WAV de ${bits} bits`);
      const frames = Math.floor(Math.min(size, bytes.length - offset - 8) / (channels * 2));
      const samples = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i += 1) for (let c = 0; c < channels; c += 1) samples[c][i] = bytes.readInt16LE(offset + 8 + (i * channels + c) * 2) / 32768;
      return { sampleRate, channels, frames, durationSec: frames / sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV sin bloque data");
}

export const rmsOf = (samples: Float32Array, from = 0, to = samples.length): number => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

export const peakOf = (samples: Float32Array, from = 0, to = samples.length): number => {
  let max = 0;
  for (let i = from; i < to; i += 1) max = Math.max(max, Math.abs(samples[i]));
  return max;
};

/** Frecuencia dominante aproximada (cruces por cero ascendentes) de un tramo. */
export function frequencyOf(samples: Float32Array, sampleRate: number, from = 0, to = samples.length): number {
  let crossings = 0;
  for (let i = Math.max(1, from + 1); i < to; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
  return (crossings * sampleRate) / (to - from);
}

/* ------------------------------------------------------------------ *
 * Contextos, axe y desborde
 * ------------------------------------------------------------------ */

export type Theme = "light" | "dark";
export type Language = "es" | "en";

export async function audioContext(
  browser: Browser,
  options: { width: number; theme?: Theme; language?: Language; wide?: boolean; touch?: boolean },
): Promise<BrowserContext> {
  const { width, theme = "dark", language = "es", wide = false, touch = false } = options;
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 812 : 900 },
    colorScheme: theme,
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: touch ? 2 : 1,
    locale: language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([themeValue, languageValue, css]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", themeValue);
        window.localStorage.setItem("optimuspdf.language", languageValue);
      } catch {
        /* almacenamiento bloqueado */
      }
      if (css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    },
    [theme, language, wide ? WIDE_CSS : ""],
  );
  return context;
}

export type AxeViolation = { id: string; help: string; nodes: string[] };

/** axe-core con las reglas WCAG 2.0/2.1 A y AA (contraste, nombres, ARIA, etiquetas...). */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.slice(0, 6).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`),
    }));
  });
}

export function describeViolations(violations: AxeViolation[]): string {
  return violations.map((violation) => `${violation.id} (${violation.help}):\n   ${violation.nodes.join("\n   ")}`).join("\n");
}

type Offender = { tag: string; cls: string; text: string; left: number; right: number };

/** Desborde horizontal de la pagina y elementos que asoman por los lados sin quedar recortados. */
export async function measureOverflow(page: Page): Promise<{ overflow: number; clientWidth: number; offenders: Offender[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const clips = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") return true;
      }
      return false;
    };
    const offenders: Array<{ tag: string; cls: string; text: string; left: number; right: number }> = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= clientWidth + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      if (clips(element)) continue;
      offenders.push({
        tag: element.tagName.toLowerCase(),
        cls: String(element.getAttribute("class") ?? "").slice(0, 100),
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      });
    }
    return { overflow: root.scrollWidth - clientWidth, clientWidth, offenders: offenders.slice(0, 8) };
  });
}

/* ------------------------------------------------------------------ *
 * Video sintetico (MediaRecorder dentro de la pagina)
 * ------------------------------------------------------------------ */

/** Graba un WebM real con `MediaRecorder`: un seno de 440 Hz y/o un lienzo que cambia de color. */
export async function recordWebm(page: Page, options: { audio: boolean; video: boolean; ms: number }): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ audio, video, ms }) => {
    const tracks: MediaStreamTrack[] = [];
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (video) {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const draw = canvas.getContext("2d") as CanvasRenderingContext2D;
      timer = setInterval(() => {
        draw.fillStyle = `hsl(${(Date.now() / 5) % 360}, 70%, 50%)`;
        draw.fillRect(0, 0, 64, 48);
      }, 30);
      tracks.push(...canvas.captureStream(20).getVideoTracks());
    }
    if (audio) {
      context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const gain = context.createGain();
      gain.gain.value = 0.4;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      tracks.push(...destination.stream.getAudioTracks());
    }
    const mime = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error("MediaRecorder no soporta WebM aqui");
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: audio || !video ? mime : "video/webm;codecs=vp8" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, ms));
    recorder.stop();
    await stopped;
    if (timer) clearInterval(timer);
    tracks.forEach((track) => track.stop());
    await context?.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, options);
  return Buffer.from(base64, "base64");
}
