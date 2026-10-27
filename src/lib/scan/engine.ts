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

export class ScanEngineUnavailableError extends Error {
  readonly code = "engine-unavailable";
  constructor(message = "El motor del escaner no esta instalado") {
    super(message);
    this.name = "ScanEngineUnavailableError";
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

const real = () => import("@/lib/scan/realEngine").then((module) => module.realEngine);

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
