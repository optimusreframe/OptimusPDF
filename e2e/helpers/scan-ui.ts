/**
 * Ayudas de los E2E del Escaner (interfaz): motor y almacen FALSOS inyectados (sin rutas de prueba en el build), camara FALSA
 * por canvas (vale igual en Chromium y WebKit, sin banderas de lanzamiento) y documentos SINTETICOS generados aqui (nunca
 * PDFs ni fotos reales).
 *
 * `SCAN_REAL=1` desactiva la inyeccion del motor/almacen falsos: los mismos specs corren contra el motor real (integracion).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { expect as baseExpect, type Page } from "@playwright/test";

const ROOT = process.cwd();

/** Holgura del CI de Linux (fuente ancha, ~2,5× mas lento): tiempos absolutos de las pruebas de esta herramienta. */
export const SLACK = process.env.CI ? 2.5 : 1;
/** `expect` con plazo holgado en CI (autoguardado en IndexedDB, camara de WebKit en Linux, 2 trabajadores a la vez). */
export const expect = baseExpect.configure({ timeout: Math.round(5_000 * SLACK * 1.5) });
/** Plazo de una prueba completa de esta herramienta. */
export const TEST_TIMEOUT = Math.round(45_000 * SLACK);
const BUNDLE = path.join(ROOT, ".evidence", `scan-fakes-${process.pid}.iife.js`);
const BUNDLE_SOURCES = [path.join(ROOT, "src/lib/scan/testing/installFakes.ts"), path.join(ROOT, "src/lib/scan/testing/fakeEngine.ts"), path.join(ROOT, "src/lib/scan/testing/fakeStore.ts")];

let built = false;
function ensureBundle(): string {
  if (built && existsSync(BUNDLE)) return BUNDLE;
  mkdirSync(path.dirname(BUNDLE), { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, "e2e/helpers/scan-fakes-bundle.mjs"), BUNDLE], { cwd: ROOT, stdio: "pipe" });
  void BUNDLE_SOURCES.map((file) => statSync(file));
  built = true;
  return BUNDLE;
}

export type FakeConfig = {
  store?: { backend?: "memory" | "indexeddb"; quotaBytes?: number; latencyMs?: number };
  controls?: Record<string, unknown>;
};

export const USE_REAL_ENGINE = process.env.SCAN_REAL === "1";

/** Inyecta el motor y el almacen falsos antes de que cargue la pagina. */
export async function installScanFakes(page: Page, config: FakeConfig = {}): Promise<void> {
  if (USE_REAL_ENGINE) return;
  await page.addInitScript((cfg) => {
    (globalThis as unknown as { __scanFakeConfig: unknown }).__scanFakeConfig = cfg;
  }, config);
  await page.addInitScript({ path: ensureBundle() });
}

export type FakeCameraOptions = {
  width?: number;
  height?: number;
  torch?: boolean;
  zoom?: boolean;
  focus?: boolean;
  devices?: number;
  /** El primer `getUserMedia` falla con este error (`NotAllowedError`, `NotFoundError`...). */
  denyWith?: string;
};

/**
 * Camara FALSA: un `MediaStream` de un canvas que dibuja una hoja con un contador y una barra que cambia en cada fotograma
 * (dos capturas nunca son iguales byte a byte, asi no se marcan como repetidas). `window.__cam` expone llamadas y ajustes.
 */
export async function installFakeCamera(page: Page, options: FakeCameraOptions = {}): Promise<void> {
  await page.addInitScript((opts) => {
    const w = opts.width ?? 640;
    const h = opts.height ?? 480;
    const cam = ((window as unknown as { __cam: Record<string, unknown> }).__cam = { constraints: [] as unknown[], gum: 0, label: "PAGINA", tracks: [] as MediaStreamTrack[] });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    const draw = () => {
      frame += 1;
      ctx.fillStyle = "#2b2f36";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(w * 0.12, h * 0.08, w * 0.76, h * 0.84);
      ctx.fillStyle = "#111111";
      ctx.font = `bold ${Math.round(h * 0.09)}px sans-serif`;
      ctx.fillText(String(cam.label), w * 0.18, h * 0.22);
      ctx.font = `${Math.round(h * 0.045)}px sans-serif`;
      for (let line = 0; line < 8; line += 1) ctx.fillText("Lorem ipsum dolor sit amet consectetur", w * 0.18, h * (0.32 + line * 0.07));
      ctx.fillStyle = "#c0392b";
      ctx.fillRect(w * 0.18, h * 0.86, (frame % 100) * (w * 0.005), 6);
    };
    draw();
    setInterval(draw, 66);
    const open = async () => {
      if (opts.denyWith) throw new DOMException("denegado", opts.denyWith);
      (cam.gum as number) += 1;
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      const caps: Record<string, unknown> = {};
      if (opts.torch !== false) caps.torch = true;
      if (opts.zoom !== false) caps.zoom = { min: 1, max: 4, step: 0.1 };
      if (opts.focus !== false) caps.focusMode = ["single-shot", "continuous"];
      track.getCapabilities = () => caps as MediaTrackCapabilities;
      track.applyConstraints = async (constraints?: MediaTrackConstraints) => {
        (cam.constraints as unknown[]).push(constraints);
      };
      (cam.tracks as MediaStreamTrack[]).push(track);
      return stream;
    };
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", { configurable: true, writable: true, value: open });
    Object.defineProperty(MediaDevices.prototype, "enumerateDevices", {
      configurable: true,
      writable: true,
      value: async () => Array.from({ length: opts.devices ?? 1 }, (_, i) => ({ kind: "videoinput", deviceId: `cam${i}`, label: `Camara ${i}`, groupId: "g" })),
    });
  }, options);
}

/* ------------------------------------------------------------------ *
 * Documentos sinteticos (Node, @napi-rs/canvas)
 * ------------------------------------------------------------------ */

export type DocVariant = "text" | "blank" | "dark" | "glare" | "blurry";

export type DocOptions = {
  width?: number;
  height?: number;
  /** Cambia el texto: dos documentos con distinta `seed` no son iguales byte a byte. */
  seed?: number;
  title?: string;
  variant?: DocVariant;
  quality?: number;
};

/** Un documento (hoja con texto) como JPEG. */
export function docJpeg(options: DocOptions = {}): Buffer {
  const w = options.width ?? 640;
  const h = options.height ?? 800;
  const seed = options.seed ?? 1;
  const variant = options.variant ?? "text";
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = variant === "dark" ? "#303030" : "#ffffff";
  ctx.fillRect(0, 0, w, h);
  if (variant !== "blank") {
    ctx.fillStyle = variant === "dark" ? "#555555" : "#111111";
    ctx.font = `bold ${Math.round(h * 0.05)}px sans-serif`;
    ctx.fillText(options.title ?? `Documento ${seed}`, w * 0.08, h * 0.1);
    ctx.font = `${Math.round(h * 0.028)}px sans-serif`;
    for (let line = 0; line < 22; line += 1) {
      ctx.fillText(`Linea ${line + 1} del documento numero ${seed} con texto de prueba ${(seed * 7 + line * 13) % 997}`, w * 0.08, h * (0.17 + line * 0.035));
    }
  }
  if (variant === "glare") {
    const gradient = ctx.createRadialGradient(w * 0.7, h * 0.3, 5, w * 0.7, h * 0.3, w * 0.4);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  }
  return canvas.toBuffer("image/jpeg", options.quality ?? 80);
}

export type SyntheticFile = { name: string; mimeType: string; buffer: Buffer };

/** Fotos para `setInputFiles`; las etiquetas del nombre (`blank`, `blurry`, `sideways`, `title-X`...) las lee el motor falso. */
export function docFiles(count: number, options: { prefix?: string; width?: number; height?: number; names?: string[] } = {}): SyntheticFile[] {
  return Array.from({ length: count }, (_, index) => ({
    name: options.names?.[index] ?? `${options.prefix ?? "doc"}-${index + 1}.jpg`,
    mimeType: "image/jpeg",
    buffer: docJpeg({ seed: index + 1, width: options.width, height: options.height, title: `Documento ${index + 1}` }),
  }));
}

/* ------------------------------------------------------------------ *
 * Acciones de la interfaz
 * ------------------------------------------------------------------ */

/** Lee/modifica el gancho de pruebas del motor falso en la pagina. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fakeControls<T>(page: Page, fn: (controls: Record<string, any>) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(globalThis.__scanFake.controls)`) as Promise<T>;
}

export async function fakeStoreInfo(page: Page): Promise<{ saves: number; list: Array<{ id: string; pageCount: number; name: string }> }> {
  return page.evaluate(async () => {
    const fake = (globalThis as unknown as { __scanFake: { store: { controls: { saveLog: unknown[] }; list: () => Promise<Array<{ id: string; pageCount: number; name: string }>> } } }).__scanFake;
    return { saves: fake.store.controls.saveLog.length, list: await fake.store.list() };
  });
}

/** El numero de tarjetas pintadas y el de paginas (con virtualizacion, pintadas <= paginas). */
export async function tileCount(page: Page): Promise<number> {
  return page.locator("[data-page-grid] [data-page-id]").count();
}

export async function pageIds(page: Page): Promise<string[]> {
  return page.locator("[data-page-grid] [data-page-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-page-id") ?? ""));
}

/** Espera a que no quede ninguna tarjeta procesandose. */
export async function waitIdle(page: Page, timeout = 30_000 * SLACK): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll("[data-page-grid] [data-tile-processing]").length === 0 && document.querySelectorAll("[data-page-grid] [data-pending]").length === 0, undefined, { timeout });
}

export async function waitVideoReady(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const video = document.querySelector("video");
        return !!video && video.videoWidth > 0 && video.readyState >= 2;
      },
      undefined,
      { timeout: 30_000 * SLACK },
    );
  } catch (error) {
    // Diagnostico: en que estado se quedo el video (WebKit en Linux con varios trabajadores a la vez).
    const state = await page
      .evaluate(() => {
        const video = document.querySelector("video") as HTMLVideoElement | null;
        const stream = video?.srcObject as MediaStream | null;
        const track = stream?.getVideoTracks()[0];
        return JSON.stringify({ has: !!video, readyState: video?.readyState, w: video?.videoWidth, paused: video?.paused, active: stream?.active, track: track?.readyState, muted: track?.muted, gum: (window as unknown as { __cam?: { gum: number } }).__cam?.gum, hidden: document.hidden });
      })
      .catch(() => "no se pudo leer");
    throw new Error(`la camara falsa no entrego fotogramas: ${state}\n${(error as Error).message}`);
  }
}

/** Documentos de anchos distintos: con la hoja «Ajustar», el ancho de cada pagina del PDF identifica de cual viene. */
export function widthCodedFiles(count: number, options: { names?: string[]; base?: number; step?: number; height?: number } = {}): SyntheticFile[] {
  const base = options.base ?? 400;
  const step = options.step ?? 40;
  return Array.from({ length: count }, (_, index) => ({
    name: options.names?.[index] ?? `w-${index + 1}.jpg`,
    mimeType: "image/jpeg",
    buffer: docJpeg({ seed: index + 1, width: base + index * step, height: options.height ?? 600, title: `Pagina ${index + 1}` }),
  }));
}

/** Ancho esperado (pt) de la pagina `index` (0-based) de un `widthCodedFiles` tras el recorte del 4 % por lado del motor falso. */
export function expectedWidth(index: number, base = 400, step = 40): number {
  return (base + index * step) * 0.92;
}

/** Importa fotos desde la pantalla de inicio o desde Revisar (el input de la fototeca esta siempre montado). */
export async function importPhotos(page: Page, files: SyntheticFile[]): Promise<void> {
  await page.locator('input[data-scan-input="library"]').setInputFiles(files);
}

/**
 * Escribe fotos sinteticas a disco y devuelve sus rutas: `setInputFiles(rutas)` las lee el propio navegador (sin pasar 100 buffers en
 * base64 por el protocolo, que ya es una tarea larga de la PRUEBA, no de la herramienta). Se borran con `cleanup()`.
 */
export function docFilesOnDisk(name: string, count: number, options: { width?: number; height?: number } = {}): { paths: string[]; cleanup: () => void } {
  const dir = path.join(ROOT, ".evidence", "scan-ui-tmp", `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const paths = Array.from({ length: count }, (_, index) => {
    const file = path.join(dir, `doc-${String(index + 1).padStart(3, "0")}.jpg`);
    writeFileSync(file, docJpeg({ seed: index + 1, width: options.width, height: options.height, title: `Documento ${index + 1}` }));
    return file;
  });
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * WebKit en LINUX (GTK/GStreamer) no decodifica de forma fiable un `MediaStream` de canvas cuando hay varios trabajadores a la vez
 * (el `<video>` se queda en `readyState 0` con la pista viva: medido en Docker, 11 de 27 repeticiones con 2 trabajadores; con 1
 * trabajador, 32 de 32). No es un defecto de la herramienta: esas pruebas se saltan alli (Chromium Linux y WebKit en macOS las cubren).
 * `SCAN_WEBKIT_CAMERA_LINUX=1` las fuerza.
 */
export function webkitLinuxCamera(browserName: string): boolean {
  return browserName === "webkit" && process.platform === "linux" && !process.env.SCAN_WEBKIT_CAMERA_LINUX;
}
export const WEBKIT_LINUX_CAMERA_REASON = "WebKit en Linux no entrega fotogramas de la camara falsa de forma fiable con varios trabajadores (ver scan-ui.ts)";
