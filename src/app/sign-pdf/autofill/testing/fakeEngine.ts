import type { AutofillSource, ExtractEngine, ExtractResult, ExtractWarning, ExtractedValue } from "@/lib/autofill/types";
import type { PrepareOcrResult } from "@/lib/scan/ocr";

/**
 * Motor FALSO del autorrelleno para las pruebas E2E de la interfaz (se compila a un IIFE que Playwright inyecta con
 * `page.addInitScript` ANTES de la pagina, igual que el del Escaner). NO esta en el build de produccion: nada de `src/app` lo
 * importa. Todo es SINTETICO: ningun valor real.
 *
 * Se configura con `globalThis.__autofillFakeConfig` (lo pone la prueba antes de este script):
 *   {
 *     byName:  { "poliza.pdf": [ { key, value, tier?, confidence?, page?, snippet? } ], ... },   // por nombre de archivo
 *     warnings:{ "foto.jpg": ["ocr-unavailable"] },                                              // avisos por nombre
 *     delayMs: 0, steps: 4,                                                                      // progreso falso
 *     failWith: "mensaje" | null,                                                                // el motor lanza
 *     ocr: { available?: boolean, prepare?: "ok" | "offline" | "network" | "engine", delayMs?: number } // modelo de lectura (por defecto: ya descargado)
 *   }
 * El modelo de lectura se comporta como el real: el MOTOR nunca lo descarga (con fotos y sin modelo avisa `ocr-unavailable` y no lee
 * la foto); la interfaz pregunta con `ocrModelAvailable` y lo baja con `prepareOcrModel`. `globalThis.__autofillFakeOcr` cuenta las
 * consultas y las descargas.
 * Un texto pegado se lee por lineas «Etiqueta: valor» (las etiquetas de abajo); un archivo sin entrada en `byName` devuelve el
 * aviso `no-data`. La senal de cancelacion se respeta en cada paso (rechaza con `AbortError`).
 */
export type FakeSpec = { key: string; value: string; tier?: "high" | "review"; confidence?: number; page?: number; snippet?: string; reason?: string };
export type FakeConfig = {
  ocr?: { available?: boolean; prepare?: "ok" | "offline" | "network" | "engine"; delayMs?: number };
  byName?: Record<string, FakeSpec[]>;
  warnings?: Record<string, ExtractWarning["code"][]>;
  delayMs?: number;
  steps?: number;
  failWith?: string | null;
};

declare global {
  var __autofillFakeOcr: { available: boolean; checks: number; prepares: number } | undefined;
  var __autofillFakeConfig: FakeConfig | undefined;
  var __autofillFakeCalls: { sources: string[]; locale: string }[] | undefined;
}

const LABELS: { re: RegExp; key: string }[] = [
  { re: /^(insured|asegurado|cliente|client|nombre|name)\b/i, key: "insuredName1" },
  { re: /^(phone|tel[eé]fono|celular|cell)\b/i, key: "phone" },
  { re: /^(e-?mail|correo)\b/i, key: "email" },
  { re: /^(address|direcci[oó]n|domicilio)\b/i, key: "address" },
  { re: /^(insurer|aseguradora|carrier)\b/i, key: "insurer" },
  { re: /^(policy|p[oó]liza)\b/i, key: "policyNumber" },
  { re: /^(claim|reclamo|siniestro)\b/i, key: "claimNumber" },
  { re: /^(date of loss|fecha de p[eé]rdida)\b/i, key: "lossDate" },
];

/** El doble del modelo de lectura (`@/lib/scan/ocr`): `ocrModelAvailable` y `prepareOcrModel` con su estado compartido con el motor falso. */
export function createFakeOcr(config: FakeConfig["ocr"] = {}): {
  ocrModelAvailable: () => Promise<boolean>;
  prepareOcrModel: (options?: { signal?: AbortSignal }) => Promise<PrepareOcrResult>;
} {
  const state = (globalThis.__autofillFakeOcr = { available: config.available !== false, checks: 0, prepares: 0 });
  return {
    ocrModelAvailable: async () => {
      state.checks += 1;
      return state.available;
    },
    prepareOcrModel: async (options) => {
      state.prepares += 1;
      try {
        await wait(config.delayMs ?? 0, options?.signal);
      } catch {
        return { ok: false, reason: "cancelled" };
      }
      const mode = config.prepare ?? "ok";
      if (mode === "ok") {
        state.available = true;
        return { ok: true };
      }
      return { ok: false, reason: mode };
    },
  };
}

function nameOf(source: AutofillSource): string {
  return source.kind === "text" ? "texto" : source.file.name;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

export const fakeEngine: ExtractEngine = async (sources, options): Promise<ExtractResult> => {
  const config = globalThis.__autofillFakeConfig ?? {};
  (globalThis.__autofillFakeCalls ??= []).push({ sources: sources.map(nameOf), locale: options.locale });
  const steps = Math.max(1, config.steps ?? 3);
  for (let step = 1; step <= steps; step += 1) {
    await wait(config.delayMs ?? 0, options.signal);
    options.onProgress?.(step / steps);
  }
  if (config.failWith) throw new Error(config.failWith);
  const values: ExtractedValue[] = [];
  const warnings: ExtractWarning[] = [];
  let usedOcr = false;
  let counter = 0;
  const push = (sourceIndex: number, spec: FakeSpec, origin: ExtractedValue["evidence"]["origin"]) => {
    counter += 1;
    const tier = spec.tier ?? "high";
    values.push({
      id: `fake-${counter}`,
      key: spec.key,
      value: spec.value,
      confidence: spec.confidence ?? (tier === "high" ? 0.95 : 0.6),
      tier,
      reason: spec.reason ?? (options.locale === "es" ? "junto a la etiqueta del dato" : "next to the data label"),
      evidence: { sourceIndex, pageIndex: (spec.page ?? 1) - 1, snippet: (spec.snippet ?? `${spec.key}: ${spec.value}`).slice(0, 120), origin },
    });
  };
  sources.forEach((source, sourceIndex) => {
    if (source.kind === "text") {
      let any = false;
      for (const line of source.text.split(/\r?\n/)) {
        const match = /^\s*([^:]{2,40}):\s*(.+?)\s*$/.exec(line);
        const label = match && LABELS.find((entry) => entry.re.test(match[1].trim()));
        if (!match || !label) continue;
        any = true;
        push(sourceIndex, { key: label.key, value: match[2], snippet: line.trim() }, "pasted");
      }
      if (!any) warnings.push({ code: "no-data", sourceIndex, message: "sin datos" });
      return;
    }
    // Como el motor real: sin modelo de lectura NO se lee una foto (y el aviso lo dice); el motor nunca lo descarga.
    if (source.kind === "image" && globalThis.__autofillFakeOcr && !globalThis.__autofillFakeOcr.available) {
      warnings.push({ code: "ocr-unavailable", sourceIndex, message: "ocr-unavailable" });
      return;
    }
    const specs = config.byName?.[source.file.name];
    for (const code of config.warnings?.[source.file.name] ?? []) warnings.push({ code, sourceIndex, message: code });
    if (specs === undefined || specs.length === 0) {
      if (!(config.warnings?.[source.file.name] ?? []).length) warnings.push({ code: "no-data", sourceIndex, message: "sin datos" });
      return;
    }
    if (source.kind === "image") usedOcr = true;
    for (const spec of specs) push(sourceIndex, spec, source.kind === "image" ? "ocr" : "text-layer");
  });
  return { values, warnings, pagesRead: sources.length, usedOcr };
};
