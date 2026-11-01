import type { ExtractEngine } from "@/lib/autofill/types";
import type { PrepareOcrResult } from "@/lib/scan/ocr";

/**
 * PUNTO DE INTEGRACION unico entre la interfaz del autorrelleno y el motor (`src/lib/autofill/index.ts`: `extract` y
 * `planFill`). Dos razones para que sea el UNICO archivo de la interfaz que lo importa:
 *
 *  1. El motor es pesado (pdf.js, OCR): se carga con `import()` solo al abrir la hoja, nunca con la pagina de Firmar.
 *  2. Las pruebas inyectan un motor FALSO sin tocar el build: `globalThis.__optimusAutofillEngine` (Vitest y Playwright lo
 *     ponen antes de abrir la hoja, igual que `__optimusScanEngine` en el Escaner). En produccion nadie lo define.
 *
 * Si el dueno del motor renombra sus exports, este es el unico archivo que hay que tocar.
 */
declare global {
  var __optimusAutofillEngine: ExtractEngine | undefined;
  /** Gancho de PRUEBAS del modelo de lectura (OCR): el doble lo pone junto al motor falso. En produccion nadie lo define. */
  var __optimusAutofillOcr:
    | { ocrModelAvailable: () => Promise<boolean>; prepareOcrModel: (options?: { signal?: AbortSignal }) => Promise<PrepareOcrResult> }
    | undefined;
}

type Motor = typeof import("@/lib/autofill");

export type AutofillEngine = {
  extract: ExtractEngine;
  planFill: Motor["planFill"];
};

let loading: Promise<AutofillEngine> | null = null;

/** Carga el motor una sola vez (el gancho de pruebas se lee en cada llamada, para poder cambiarlo entre pruebas). */
export function loadAutofillEngine(): Promise<AutofillEngine> {
  loading ??= import("@/lib/autofill").then((mod) => ({
    extract: ((sources, options) => (globalThis.__optimusAutofillEngine ?? mod.extract)(sources, options)) satisfies ExtractEngine,
    planFill: mod.planFill,
  }));
  // Si la carga falla (modulo no descargable sin red), la siguiente apertura de la hoja lo vuelve a intentar.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * El MOTOR NUNCA descarga el modelo de lectura (OCR): si falta devuelve el aviso `ocr-unavailable`. Descargarlo es una accion
 * EXPLICITA de la persona (un boton con texto claro), asi que la interfaz pregunta antes de leer fotos (`ocrModelAvailable`) y lo
 * baja con `prepareOcrModel`. Las dos viven en `@/lib/scan/ocr` (las mismas del Escaner); se cargan con `import()` y con el gancho
 * de pruebas por delante.
 */
export async function ocrModelAvailable(): Promise<boolean> {
  const hook = globalThis.__optimusAutofillOcr;
  if (hook) return hook.ocrModelAvailable().catch(() => false);
  try {
    return await (await import("@/lib/scan/ocr")).ocrModelAvailable();
  } catch {
    return false;
  }
}

export async function prepareOcrModel(options: { signal?: AbortSignal } = {}): Promise<PrepareOcrResult> {
  const hook = globalThis.__optimusAutofillOcr;
  try {
    return hook ? await hook.prepareOcrModel(options) : await (await import("@/lib/scan/ocr")).prepareOcrModel(options);
  } catch {
    return { ok: false, reason: "engine" };
  }
}

/** Solo para pruebas. */
export function __resetAutofillEngineForTests(): void {
  loading = null;
}
