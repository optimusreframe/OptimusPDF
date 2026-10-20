/**
 * Punto de entrada que Vite empaqueta (IIFE) para inyectar en una pagina REAL de la app el arnes de pruebas de los
 * modulos «Ajustes» y «Borradores» del respaldo (U4.6). NO es la interfaz definitiva (esa llega en U4.7): solo encadena
 * las funciones de la libreria, tal como las llamara la interfaz, con los validadores del navegador real (`inputGuard`
 * abre cada PDF con pdf.js; `validatePngForImport` decodifica cada trazo). Solo para las pruebas E2E.
 */
import { buildPackage, readPackage } from "../../src/lib/backup/package";
import {
  applyDraftsImport,
  defaultDraftDecisions,
  exportDraftsDetailed,
  inputGuardPdfValidator,
  planDraftsImport,
  summarizeDrafts,
  type DraftDecision,
  type DraftsImportPlan,
} from "../../src/lib/backup/modules/drafts";
import {
  applySettingsImport,
  defaultSettingsDecisions,
  exportSettings,
  planSettingsImport,
  summarizeSettings,
  type SettingsDecisions,
} from "../../src/lib/backup/modules/settings";
import { validatePngForImport } from "../../src/lib/image/pngImportGuard";

export { summarizeDrafts, summarizeSettings };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type ExportOptions = {
  password?: string;
  settings?: boolean;
  drafts?: boolean;
  includeValueHistory?: boolean;
  includeStrokes?: boolean;
  kinds?: { sign?: boolean; edit?: boolean; pro?: boolean };
};

/** Exporta los modulos pedidos a UN paquete (opcionalmente cifrado) y lo devuelve en base64. */
export async function exportPackage(options: ExportOptions = {}) {
  const modules = [];
  let report = null;
  if (options.settings !== false) modules.push(await exportSettings({ includeValueHistory: options.includeValueHistory === true }));
  if (options.drafts !== false) {
    const exported = await exportDraftsDetailed({ includeStrokes: options.includeStrokes, kinds: options.kinds });
    modules.push(exported.module);
    report = exported.report;
  }
  const blob = await buildPackage({ modules, password: options.password });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { b64: toBase64(bytes), size: bytes.byteLength, files: modules.flatMap((m) => m.files.map((f) => f.path)), report };
}

type Summary = { kind: string; status: string; reason?: string; fileName: string; documents: number; hasStrokes: boolean }[];
const summarize = (plan: DraftsImportPlan): Summary =>
  plan.items.map((i) => ({ kind: i.kind, status: i.status, reason: i.reason, fileName: i.fileName, documents: i.documents, hasStrokes: i.hasStrokes }));

export type ImportOptions = {
  password?: string;
  /** Aplicar de verdad; si no, solo la vista previa. */
  apply?: boolean;
  settings?: SettingsDecisions | "default" | "omit";
  /** Decisiones de borradores: `default`, o por tipo de estado. */
  drafts?: "default" | "omit" | Record<string, DraftDecision>;
  keepStrokes?: boolean;
  /** Solo para los dorados: la fecha con la que se juzga la caducidad de los trazos. */
  now?: number;
};

/** Lee un paquete en base64, planifica (con los validadores reales) y, si se pide, aplica. */
export async function importPackage(b64: string, options: ImportOptions = {}) {
  const started = performance.now();
  const read = await readPackage(new File([fromBase64(b64) as unknown as BlobPart], "respaldo.optimuspdf.zip"), options.password);
  const settingsPlan = planSettingsImport(read);
  const draftsPlan = await planDraftsImport(read, {
    validatePdf: inputGuardPdfValidator(),
    validateImage: async (png) => (await validatePngForImport(png)).ok,
    keepStrokes: options.keepStrokes,
    now: options.now,
  });
  const out = {
    modules: read.modules.map((m) => [m.name, m.status]),
    warnings: read.warnings.length,
    settings: { state: settingsPlan.state, counts: settingsPlan.counts, ignoredKeys: settingsPlan.ignoredKeys, valueHistory: settingsPlan.valueHistory.status },
    drafts: { state: draftsPlan.state, counts: draftsPlan.counts, items: summarize(draftsPlan), includesStrokes: draftsPlan.includesStrokes },
    appliedSettings: null as unknown,
    appliedDrafts: null as unknown,
    ms: 0,
  };
  if (options.apply) {
    const settingsDecisions =
      options.settings === "omit" ? { settings: "omit" as const } : options.settings && options.settings !== "default" ? options.settings : defaultSettingsDecisions(settingsPlan);
    out.appliedSettings = await applySettingsImport(settingsPlan, settingsDecisions);
    const draftDecisions =
      options.drafts === "omit"
        ? {}
        : options.drafts && options.drafts !== "default"
          ? options.drafts
          : defaultDraftDecisions(draftsPlan);
    const result = await applyDraftsImport(draftsPlan, draftDecisions, { keepStrokes: options.keepStrokes, now: options.now });
    out.appliedDrafts = result.ok ? { ...result } : result;
  }
  out.ms = Math.round(performance.now() - started);
  return out;
}
