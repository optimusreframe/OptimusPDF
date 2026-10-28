import { estimateScanSize } from "@/lib/scan/estimate";
import { analyzeLiveFrame, sharedFrameTracker } from "@/lib/scan/liveFrame";
import type { ScanEngineApi } from "@/lib/scan/types";

export * from "@/lib/scan/types";

/**
 * Fachada del Escaner: la interfaz importa SIEMPRE de aqui (`@/lib/scan/engine`).
 *
 * Por defecto la implementacion es la REAL (`realEngine.ts`): analisis del fotograma en vivo (sincrono, estatico), y el resto
 * (crear/procesar paginas, analisis de la sesion, orientacion, nombre, PDF) cargado bajo demanda con `import()`, asi que solo
 * pesa cuando se usa la herramienta. Todo es local: ninguna peticion de red (el OCR opcional descarga el modelo de idioma la
 * primera vez, como el resto de herramientas de OCR).
 *
 * Se puede sustituir con `setScanEngine({ ...metodos })` (lo que falte conserva la implementacion real;
 * `setScanEngine(null)` la restaura) y `unavailableEngine` sigue exportado para probar el aviso «sin motor».
 *
 * Gancho de pruebas: si existe `globalThis.__optimusScanEngine` (un objeto con alguno de los metodos), SUS funciones mandan
 * sobre las instaladas. Lo usan los E2E para inyectar un motor falso en la build de produccion sin anadir rutas de prueba.
 * En produccion nadie lo define: es inerte.
 */

export const SCAN_ENGINE_TEST_HOOK = "__optimusScanEngine";

/**
 * El motor no esta disponible. `code` es SIEMPRE `"engine-unavailable"` (usa `isScanEngineUnavailable`). `reason` distingue:
 *  - `"not-installed"`: no hay motor (solo el motor de prueba `unavailableEngine`);
 *  - `"load-failed"`: el trozo de codigo del motor NO se pudo descargar (sin conexion o conexion caida al abrir la herramienta). NO es
 *    una foto danada: la interfaz debe decir «No se pudo cargar el escaner; comprueba la conexion» y reintentar al volver la red.
 * `needsReload` pasa a `true` cuando la conexion ya volvio y aun asi sigue fallando: el cargador de la aplicacion (Turbopack)
 * recuerda un trozo fallido hasta recargar la pagina. La interfaz debe ofrecer «Recargar» (lo ya guardado en Recientes se conserva).
 */
export class ScanEngineUnavailableError extends Error {
  readonly code = "engine-unavailable";
  readonly reason: "not-installed" | "load-failed";
  readonly needsReload: boolean;
  constructor(message = "El motor del escaner no esta instalado", options: { reason?: "not-installed" | "load-failed"; needsReload?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ScanEngineUnavailableError";
    this.reason = options.reason ?? "not-installed";
    this.needsReload = options.needsReload ?? false;
  }
}

export function isScanEngineUnavailable(error: unknown): error is ScanEngineUnavailableError {
  return error instanceof Error && (error as { code?: unknown }).code === "engine-unavailable";
}

const unavailable = (): never => {
  throw new ScanEngineUnavailableError();
};
const unavailableAsync = (): Promise<never> => Promise.reject(new ScanEngineUnavailableError());

/** Sin motor: todo lanza `ScanEngineUnavailableError` (para probar el aviso de la interfaz). */
export const unavailableEngine: ScanEngineApi = {
  analyzeFrame: unavailable,
  createPage: unavailableAsync,
  renderPage: unavailableAsync,
  analyzeSession: unavailableAsync,
  detectOrientation: unavailableAsync,
  suggestName: unavailableAsync,
  estimateSize: unavailable,
  buildPdf: unavailableAsync,
  splitSpread: unavailableAsync,
};

let realPromise: Promise<ScanEngineApi> | null = null;
let realImporter: () => Promise<ScanEngineApi> = () => import("@/lib/scan/realEngine").then((module) => module.realEngine);

/** Solo para pruebas: sustituye la carga del motor real (`null` restaura la normal) y olvida lo cargado. */
export function __setRealEngineImporterForTests(next: (() => Promise<ScanEngineApi>) | null): void {
  realImporter = next ?? (() => import("@/lib/scan/realEngine").then((module) => module.realEngine));
  realPromise = null;
  failedWhileOffline = false;
}

/** Esperas entre intentos de carga del motor (ms). */
export const ENGINE_LOAD_BACKOFF_MS: readonly number[] = [250, 900];
let waitBetweenAttempts: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Un intento de carga fallido anterior (para saber si la conexion ya volvio y aun asi falla). */
let failedWhileOffline = false;

/** Solo para pruebas: sin esperas reales entre intentos (`null` restaura). */
export function __setEngineLoadWaitForTests(wait: ((ms: number) => Promise<void>) | null): void {
  waitBetweenAttempts = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  failedWhileOffline = false;
}

const online = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;

async function loadReal(): Promise<ScanEngineApi> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ENGINE_LOAD_BACKOFF_MS.length; attempt += 1) {
    try {
      const engine = await realImporter();
      failedWhileOffline = false;
      return engine;
    } catch (error) {
      lastError = error;
      if (attempt < ENGINE_LOAD_BACKOFF_MS.length) await waitBetweenAttempts(ENGINE_LOAD_BACKOFF_MS[attempt]);
    }
  }
  // Si ya habia fallado SIN conexion y ahora la hay, el cargador de la aplicacion recuerda el trozo fallido: hace falta recargar.
  const needsReload = failedWhileOffline && online();
  if (!online()) failedWhileOffline = true;
  throw new ScanEngineUnavailableError("No se pudo cargar el motor del escaner (comprueba la conexion)", { reason: "load-failed", needsReload, cause: lastError });
}

/**
 * Carga el motor real una vez. Un rechazo (trozo no disponible, sin conexion) NO se guarda: el siguiente uso lo reintenta (con un
 * par de reintentos esperando antes) y falla con `ScanEngineUnavailableError` (`reason: "load-failed"`), distinto de una foto
 * danada.
 */
const real = (): Promise<ScanEngineApi> => {
  realPromise ??= loadReal().catch((error: unknown) => {
    realPromise = null;
    throw error;
  });
  return realPromise;
};

/**
 * Deja todo cargado y caliente (motor, detector scanic, worker de procesado) mientras hay conexion, para que importar fotos
 * funcione tambien SIN ella. Se llama sola al cargar la herramienta (ver abajo); la interfaz puede llamarla de nuevo. Nunca lanza.
 */
export async function preloadScanEngine(): Promise<void> {
  try {
    await real();
    const [{ preloadDocumentDetection }, { warmScanWorker, workerSupported }] = await Promise.all([import("@/lib/scan/documentDetection"), import("@/lib/scan/renderBrowser")]);
    // El detector corre en el worker (que lo precarga al arrancar): el hilo principal solo lo carga si no hay worker (respaldo).
    if (!workerSupported()) preloadDocumentDetection();
    warmScanWorker();
  } catch {
    // Sin conexion o sin el chunk: se reintenta al usar el motor.
  }
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  // Fuera del camino critico de la pagina; en pruebas Node no hay `window`.
  const idle = (window as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === "function") idle.call(window, () => void preloadScanEngine(), { timeout: 2500 });
  else setTimeout(() => void preloadScanEngine(), 400);
}

export { ocrModelAvailable, prepareOcrModel, type PrepareOcrResult } from "@/lib/scan/ocr";

/** Implementacion por defecto: el motor real (el analisis en vivo y la estimacion, estaticos; lo demas, bajo demanda). */
export const defaultEngine: ScanEngineApi = {
  analyzeFrame: (frame, previous, now, options) =>
    analyzeLiveFrame(frame, sharedFrameTracker, previous, now ?? (typeof performance !== "undefined" ? performance.now() : Date.now()), options),
  createPage: async (source, info) => (await real()).createPage(source, info),
  renderPage: async (page, options) => (await real()).renderPage(page, options),
  analyzeSession: async (pages) => (await real()).analyzeSession(pages),
  detectOrientation: async (page, signal) => (await real()).detectOrientation(page, signal),
  suggestName: async (pages, locale, signal) => (await real()).suggestName(pages, locale, signal),
  estimateSize: (pages, options) => estimateScanSize(pages, options),
  buildPdf: async (session, options) => (await real()).buildPdf(session, options),
  splitSpread: async (page, options) => {
    const engine = await real();
    if (!engine.splitSpread) throw new ScanEngineUnavailableError();
    return engine.splitSpread(page, options);
  },
};

let installed: Partial<ScanEngineApi> | null = null;

/** Instala (o, con `null`, retira) una implementacion. Lo que no traiga conserva la de por defecto. */
export function setScanEngine(api: Partial<ScanEngineApi> | null): void {
  installed = api;
}

const METHODS = ["analyzeFrame", "createPage", "renderPage", "analyzeSession", "detectOrientation", "suggestName", "estimateSize", "buildPdf", "splitSpread"] as const;

function testHook(): Partial<ScanEngineApi> | null {
  const hook = (globalThis as Record<string, unknown>)[SCAN_ENGINE_TEST_HOOK];
  if (!hook || typeof hook !== "object") return null;
  const picked: Partial<ScanEngineApi> = {};
  for (const method of METHODS) {
    const candidate = (hook as Record<string, unknown>)[method];
    if (typeof candidate === "function") {
      (picked as Record<string, unknown>)[method] = (candidate as (...args: unknown[]) => unknown).bind(hook);
    }
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

/** Motor vigente: real por defecto < instalado < gancho de pruebas. */
export function getScanEngine(): ScanEngineApi {
  return { ...defaultEngine, ...(installed ?? {}), ...(testHook() ?? {}) };
}

/** `true` si el motor vigente NO es `unavailableEngine`. */
export function isScanEngineAvailable(): boolean {
  return getScanEngine().createPage !== unavailableEngine.createPage;
}

export const analyzeFrame: ScanEngineApi["analyzeFrame"] = (frame, previous, now, options) => getScanEngine().analyzeFrame(frame, previous, now, options);
export const createPage: ScanEngineApi["createPage"] = (source, info) => getScanEngine().createPage(source, info);
export const renderPage: ScanEngineApi["renderPage"] = (page, options) => getScanEngine().renderPage(page, options);
export const analyzeSession: ScanEngineApi["analyzeSession"] = (pages) => getScanEngine().analyzeSession(pages);
export const detectOrientation: ScanEngineApi["detectOrientation"] = (page, signal) => getScanEngine().detectOrientation(page, signal);
export const suggestName: ScanEngineApi["suggestName"] = (pages, locale, signal) => getScanEngine().suggestName(pages, locale, signal);
export const estimateSize: ScanEngineApi["estimateSize"] = (pages, options) => getScanEngine().estimateSize(pages, options);
export const buildPdf: ScanEngineApi["buildPdf"] = (session, options) => getScanEngine().buildPdf(session, options);
/** Parte un libro abierto en dos paginas; `undefined` si el motor vigente no lo ofrece. */
export const splitSpread = (...args: Parameters<NonNullable<ScanEngineApi["splitSpread"]>>): ReturnType<NonNullable<ScanEngineApi["splitSpread"]>> => {
  const method = getScanEngine().splitSpread;
  return method ? method(...args) : Promise.reject(new ScanEngineUnavailableError());
};
