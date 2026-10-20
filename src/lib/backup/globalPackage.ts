import { listVault } from "@/app/sign-pdf/signVault";
import { passwordBoxAvailable } from "@/lib/crypto/passwordBox";
import { validatePngForImport } from "@/lib/image/pngImportGuard";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { PACKAGE_LIMITS, PackageError, type PackageModuleInput, type PackageReadResult } from "@/lib/backup/types";
import {
  applySignaturesImport,
  checkSignaturesLimits,
  defaultSignatureDecisions,
  exportSignatures,
  planSignaturesImport,
  type ImportPlan as SignaturesPlan,
  type SignatureDecision,
  type SignaturesLimitCheck,
} from "@/lib/backup/modules/signatures";
import {
  applyLibraryImport,
  checkLibraryLimits,
  defaultLibraryDecisions,
  exportLibraryWithReport,
  loadLibraryExisting,
  planLibraryImport,
  summarizeLibraryExport,
  type LibraryDecision,
  type LibraryLimitCheck,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import {
  applyDraftsImport,
  checkDraftsLimits,
  defaultDraftDecisions,
  exportDraftsDetailed,
  inputGuardPdfValidator,
  planDraftsImport,
  summarizeDrafts,
  type DraftDecision,
  type DraftsImportPlan,
  type DraftsLimitCheck,
  type DraftsSummary,
  type ExportDraftsOptions,
} from "@/lib/backup/modules/drafts";
import {
  applySettingsImport,
  defaultSettingsDecisions,
  exportSettings,
  planSettingsImport,
  summarizeSettings,
  type SettingsDecisions,
  type SettingsImportPlan,
} from "@/lib/backup/modules/settings";
import { LibraryError } from "@/lib/docLibrary/types";
import { guardPdfBytes } from "@/app/documents/backupFlow";
import { readFailureFor, type ReadFailure } from "@/app/sign-pdf/backupFlow";

/**
 * «OptimusPDF Package» GLOBAL (U4.7, `docs/PLAN-FIRMA-AGIL.md` §9.3): orquestación PURA sobre los cuatro módulos que ya
 * existen (Firmas, Plantillas y documentos, Borradores, Ajustes). No tiene formato propio ni lógica de fusión: describe,
 * exporta, lee/planifica y aplica llamando a `buildPackage`/`readPackage` y a las funciones de cada módulo. Un paquete de
 * UN solo módulo (el de firmas de U4.4, el de documentos de U4.5…) se importa por esta misma vía.
 *
 * Garantías: leer y planificar NUNCA escribe; cada módulo es atómico en sí (lo garantiza su `apply…Import`) y, entre
 * módulos, uno que falla NO deshace los que ya se aplicaron bien (se informa por módulo). Nada sale del dispositivo.
 */

export type PackageModuleName = "signatures" | "library" | "drafts" | "settings";

/** Orden fijo de exportación, de la vista previa y de aplicación. Ajustes va el último: aplicarlo pide recargar la página. */
export const PACKAGE_MODULES: readonly PackageModuleName[] = ["signatures", "library", "drafts", "settings"];

export type ModuleChoice = Partial<Record<PackageModuleName, boolean>>;

const isChosen = (modules: ModuleChoice, name: PackageModuleName): boolean => modules[name] === true;

/* ------------------------------------------------------------------------------------------------------------ */
/* Describir lo que se va a exportar                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** Margen del índice y los JSON dentro del tope de bytes del paquete. */
const PACKAGE_SLACK_BYTES = 8 * 1024 * 1024;
/** Estimación de `settings.json` (pocos KB). */
const SETTINGS_ESTIMATE_BYTES = 4 * 1024;
/** Estimación por etiqueta de historial de valores (≤ 5 valores de ≤ 500 caracteres: se queda corta a propósito). */
const HISTORY_ESTIMATE_BYTES_PER_LABEL = 400;

export type ExportOptions = {
  modules: ModuleChoice;
  /** Incluir el historial de valores (PII). DESMARCADO por defecto. */
  includeValueHistory?: boolean;
  /** `false` quita los trazos de firma de los borradores (solo puede quitarlos, nunca forzarlos). */
  includeStrokes?: boolean;
  /** Qué tipos de borrador viajan; por defecto, todos. */
  draftKinds?: ExportDraftsOptions["kinds"];
};

export type ExportDescription = {
  signatures: { available: boolean; count: number; bytes: number };
  library: { available: boolean; documents: number; templates: number; bytes: number; withoutCopy: number };
  drafts: {
    available: boolean;
    count: number;
    signCount: number;
    editCount: number;
    proCount: number;
    bytes: number;
    /** Borradores de Firmar con trazos de firma guardados hoy. */
    withSignatureStrokes: number;
    /** Los trazos VIAJARÍAN con este paquete («contienen tu firma»). */
    includesStrokes: boolean;
    /** Hay trazos guardados pero no viajan (ajuste «guardar las firmas» apagado, o se quitaron). */
    strokesHeldBack: boolean;
    fitsInPackage: boolean;
    expiredSkipped: number;
  };
  settings: { available: boolean; keys: number; valueHistoryLabels: number; valueHistoryValues: number };
  /** Módulos pedidos que tienen algo que exportar. */
  willInclude: PackageModuleName[];
  /** Módulos pedidos que están vacíos y se omitirán (con aviso). */
  willOmitEmpty: PackageModuleName[];
  /** Módulos pedidos que este navegador no puede leer. */
  unavailable: PackageModuleName[];
  /** Tamaño estimado (sin comprimir) de lo que viajaría. */
  estimatedBytes: number;
  /** Algún borrador con trazos de firma viajaría: «contienen tu firma». */
  containsSignatureStrokes: boolean;
  /** Lleva firmas guardadas o trazos de firma. */
  containsSignatures: boolean;
  /** Lleva borradores o historial de valores: datos de clientes. */
  containsClientData: boolean;
  /** Conviene cifrar (firmas, borradores o historial de valores). */
  encryptionRecommended: boolean;
  /** Lo elegido no cabe en un solo paquete (250 MiB). */
  tooLarge: boolean;
  /** No hay nada que exportar con la selección actual. */
  nothingToExport: boolean;
};

/**
 * Resumen previo a exportar: «N firmas, M documentos, K plantillas, D borradores (S de Firmar con trazos: sí/no), ajustes,
 * tamaño estimado». Solo lee metadatos (ni PDF ni contenido) y no cambia nada. Nunca lanza.
 */
export async function describeExport(options: ExportOptions): Promise<ExportDescription> {
  const { modules } = options;
  const vault = await listVault().catch(() => ({ ok: false as const, entries: [] }));
  const signaturesBytes = vault.entries.reduce((sum, entry) => sum + (entry.signature?.png.byteLength ?? 0) + (entry.initials?.png.byteLength ?? 0), 0);
  const library = await summarizeLibraryExport().catch(() => ({ available: false, documents: 0, templates: 0, bytes: 0, withoutCopy: 0 }));
  const drafts: DraftsSummary = await summarizeDrafts().catch(() => ({ ok: false, reason: "unavailable" }) as DraftsSummary);
  const settings = summarizeSettings();

  const draftKinds = options.draftKinds;
  const kind = (name: "sign" | "edit" | "pro") => draftKinds?.[name] !== false;
  const draftSign = drafts.ok && kind("sign") ? drafts.sign : { count: 0, bytes: 0, documents: 0, sessions: 0 };
  const draftEdit = drafts.ok && kind("edit") ? drafts.edit : { count: 0, bytes: 0 };
  const draftPro = drafts.ok && kind("pro") ? drafts.pro : { count: 0, bytes: 0 };
  const draftCount = draftSign.count + draftEdit.count + draftPro.count;
  const draftBytes = draftSign.bytes + draftEdit.bytes + draftPro.bytes;
  const strokesWanted = options.includeStrokes !== false;
  const withStrokes = drafts.ok && kind("sign") ? drafts.withSignatureStrokes : 0;
  const draftsIncludeStrokes = drafts.ok && kind("sign") && drafts.includesSignatureStrokes && strokesWanted;
  const historyOn = options.includeValueHistory === true;

  const signaturesInfo = { available: vault.ok, count: vault.entries.length, bytes: signaturesBytes };
  const libraryInfo = { available: library.available, documents: library.documents, templates: library.templates, bytes: library.bytes, withoutCopy: library.withoutCopy };
  const draftsInfo = {
    available: drafts.ok,
    count: draftCount,
    signCount: draftSign.count,
    editCount: draftEdit.count,
    proCount: draftPro.count,
    bytes: draftBytes,
    withSignatureStrokes: withStrokes,
    includesStrokes: draftsIncludeStrokes,
    strokesHeldBack: withStrokes > 0 && !draftsIncludeStrokes,
    fitsInPackage: drafts.ok ? drafts.fitsInPackage : true,
    expiredSkipped: drafts.ok ? drafts.expiredSkipped : 0,
  };
  const settingsInfo = { available: settings.ok, keys: settings.keys, valueHistoryLabels: settings.valueHistoryLabels, valueHistoryValues: settings.valueHistoryValues };

  const hasContent: Record<PackageModuleName, boolean> = {
    signatures: signaturesInfo.count > 0,
    library: libraryInfo.documents + libraryInfo.templates > 0,
    drafts: draftCount > 0,
    settings: settingsInfo.keys > 0 || (historyOn && settingsInfo.valueHistoryLabels > 0),
  };
  const isAvailable: Record<PackageModuleName, boolean> = {
    signatures: signaturesInfo.available,
    library: libraryInfo.available,
    drafts: draftsInfo.available,
    settings: settingsInfo.available,
  };
  const chosen = PACKAGE_MODULES.filter((name) => isChosen(modules, name));
  const unavailable = chosen.filter((name) => !isAvailable[name]);
  const willInclude = chosen.filter((name) => isAvailable[name] && hasContent[name]);
  const willOmitEmpty = chosen.filter((name) => isAvailable[name] && !hasContent[name]);

  let estimated = 0;
  if (willInclude.includes("signatures")) estimated += signaturesInfo.bytes;
  if (willInclude.includes("library")) estimated += libraryInfo.bytes;
  if (willInclude.includes("drafts")) estimated += draftsInfo.bytes;
  if (willInclude.includes("settings")) estimated += SETTINGS_ESTIMATE_BYTES + (historyOn ? settingsInfo.valueHistoryLabels * HISTORY_ESTIMATE_BYTES_PER_LABEL : 0);

  const includesDrafts = willInclude.includes("drafts");
  const includesHistory = willInclude.includes("settings") && historyOn && settingsInfo.valueHistoryLabels > 0;
  const containsSignatureStrokes = includesDrafts && draftsInfo.includesStrokes;
  const containsSignatures = willInclude.includes("signatures") || containsSignatureStrokes;
  const containsClientData = includesDrafts || includesHistory;

  return {
    signatures: signaturesInfo,
    library: libraryInfo,
    drafts: draftsInfo,
    settings: settingsInfo,
    willInclude,
    willOmitEmpty,
    unavailable,
    estimatedBytes: estimated,
    containsSignatureStrokes,
    containsSignatures,
    containsClientData,
    encryptionRecommended: containsSignatures || containsClientData,
    tooLarge: estimated > PACKAGE_LIMITS.maxUncompressedBytes - PACKAGE_SLACK_BYTES || (includesDrafts && !draftsInfo.fitsInPackage),
    nothingToExport: willInclude.length === 0,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Exportar                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** `OptimusPDF-paquete-AAAA-MM-DD.optimuspdf.zip` con la fecha LOCAL (la que la persona ve en su calendario). */
export function packageFilename(date: Date = new Date()): string {
  return `OptimusPDF-paquete-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}.optimuspdf.zip`;
}

export type ExportEverythingFailure = "nothingSelected" | "empty" | "unavailable" | "encryptionUnavailable" | "tooLarge" | "failed";

export type OmittedModule = { module: PackageModuleName; reason: "empty" | "unavailable" };

export type ExportEverythingOptions = ExportOptions & {
  /** Con valor, el paquete entero se cifra con ella. Sin valor, queda en claro (recomendado cifrar, no obligatorio). */
  password?: string;
  now?: Date;
};

export type ExportEverythingResult =
  | {
      ok: true;
      blob: Blob;
      filename: string;
      encrypted: boolean;
      /** Módulos que SÍ van en el paquete, con su recuento. */
      included: PackageModuleName[];
      omitted: OmittedModule[];
      counts: { signatures: number; documents: number; templates: number; drafts: number; settings: number; valueHistory: boolean; strokes: boolean };
    }
  | { ok: false; reason: ExportEverythingFailure; omitted?: OmittedModule[] };

function codeOf(error: unknown): string | null {
  if (error instanceof PackageError) return error.code;
  if (error instanceof LibraryError) return error.code;
  return null;
}

/**
 * Empaqueta los módulos elegidos en UN paquete (cifrado si hay `password`). Un módulo VACÍO se omite y se informa en
 * `omitted`; uno que este navegador no puede leer también (con su motivo). Si no queda ninguno, `empty`/`unavailable`.
 * El historial de valores solo va si se pide; los trazos de firma de los borradores van salvo `includeStrokes: false` o el
 * ajuste «guardar las firmas» apagado (lo decide el propio módulo de borradores). No escribe ni descarga nada.
 */
export async function exportEverything(options: ExportEverythingOptions): Promise<ExportEverythingResult> {
  const chosen = PACKAGE_MODULES.filter((name) => isChosen(options.modules, name));
  if (chosen.length === 0) return { ok: false, reason: "nothingSelected" };
  const password = options.password === "" ? undefined : options.password;
  if (password !== undefined && !passwordBoxAvailable()) return { ok: false, reason: "encryptionUnavailable" };

  const omitted: OmittedModule[] = [];
  const inputs: PackageModuleInput[] = [];
  const counts = { signatures: 0, documents: 0, templates: 0, drafts: 0, settings: 0, valueHistory: false, strokes: false };

  try {
    // Antes de leer ningún PDF: lo que se puede medir sin leer y no cabría se rechaza ya.
    const description = await describeExport(options);
    if (description.tooLarge) return { ok: false, reason: "tooLarge" };

    for (const name of chosen) {
      try {
        if (name === "signatures") {
          const input = await exportSignatures();
          const count = typeof input.meta?.count === "number" ? input.meta.count : 0;
          if (count === 0) omitted.push({ module: name, reason: "empty" });
          else {
            inputs.push(input);
            counts.signatures = count;
          }
        } else if (name === "library") {
          const summary = await summarizeLibraryExport();
          if (!summary.available) {
            omitted.push({ module: name, reason: "unavailable" });
            continue;
          }
          if (summary.documents === 0 && summary.templates === 0) {
            omitted.push({ module: name, reason: "empty" });
            continue;
          }
          const { module: input, report } = await exportLibraryWithReport();
          if (report.documents === 0 && report.templates === 0) omitted.push({ module: name, reason: "empty" });
          else {
            inputs.push(input);
            counts.documents = report.documents;
            counts.templates = report.templates;
          }
        } else if (name === "drafts") {
          const { module: input, report } = await exportDraftsDetailed({ kinds: options.draftKinds, includeStrokes: options.includeStrokes });
          const total = report.signDocuments + report.signSessions + report.edit + report.pro;
          if (total === 0) omitted.push({ module: name, reason: "empty" });
          else {
            inputs.push(input);
            counts.drafts = total;
            counts.strokes = report.includesStrokes;
          }
        } else {
          const input = await exportSettings({ includeValueHistory: options.includeValueHistory === true });
          const count = typeof input.meta?.count === "number" ? input.meta.count : 0;
          const history = input.meta?.includesValueHistory === true;
          if (count === 0 && !history) omitted.push({ module: name, reason: "empty" });
          else {
            inputs.push(input);
            counts.settings = count;
            counts.valueHistory = history;
          }
        }
      } catch (error) {
        const code = codeOf(error);
        if (code === "tooLarge") return { ok: false, reason: "tooLarge" };
        if (code === "unavailable") omitted.push({ module: name, reason: "unavailable" });
        else return { ok: false, reason: "failed" };
      }
    }

    if (inputs.length === 0) {
      const onlyUnavailable = omitted.length > 0 && omitted.every((item) => item.reason === "unavailable");
      return { ok: false, reason: onlyUnavailable ? "unavailable" : "empty", omitted };
    }
    const blob = await buildPackage({ modules: inputs, password, now: options.now });
    return {
      ok: true,
      blob,
      filename: packageFilename(options.now),
      encrypted: password !== undefined,
      included: inputs.map((input) => input.name as PackageModuleName),
      omitted,
      counts,
    };
  } catch (error) {
    const code = codeOf(error);
    if (code === "tooLarge" || code === "tooManyEntries") return { ok: false, reason: "tooLarge" };
    if (code === "unavailable") return { ok: false, reason: password !== undefined ? "encryptionUnavailable" : "unavailable" };
    return { ok: false, reason: "failed" };
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Leer y planificar (SIN escribir)                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

export type EverythingPlans = {
  signatures: SignaturesPlan | null;
  library: LibraryPlan | null;
  drafts: DraftsImportPlan | null;
  settings: SettingsImportPlan | null;
};

export type ModuleState = "ok" | "absent" | "newerVersion" | "damaged" | "unavailable";

export type ModuleCounts = { new: number; identical: number; different: number; invalid: number };

export type ModuleSummary = {
  module: PackageModuleName;
  state: ModuleState;
  message?: string;
  counts: ModuleCounts;
  /** El módulo está en el paquete y se puede leer. */
  importable: boolean;
};

export type ReadEverythingFailure = Exclude<ReadFailure, "noSignatures"> | "noModules";

export type ReadEverythingResult =
  | {
      ok: true;
      encrypted: boolean;
      plans: EverythingPlans;
      modules: ModuleSummary[];
      /** Avisos del lector (módulos o archivos desconocidos): solo se cuentan. */
      warnings: number;
    }
  | { ok: false; reason: ReadEverythingFailure; code?: string };

export type ReadEverythingOptions = {
  /** Tras revisar cada PDF (`total` = lo que dice el paquete que trae; informativo). */
  onProgress?: (done: number, total: number) => void;
  /** Para pruebas: sustituyen las puertas de entrada de producción. */
  validatePdf?: (bytes: Uint8Array) => Promise<boolean>;
  validateImage?: (png: Uint8Array) => Promise<boolean>;
  /** Solo para pruebas: la fecha con la que se juzga la caducidad de los trazos de los borradores. */
  now?: number;
};

const ZERO: ModuleCounts = { new: 0, identical: 0, different: 0, invalid: 0 };

function summaryOf(name: PackageModuleName, plan: { state: ModuleState | string; message?: string; counts: ModuleCounts } | null): ModuleSummary {
  if (!plan) return { module: name, state: "unavailable", counts: ZERO, importable: false };
  const state = plan.state as ModuleState;
  return { module: name, state, ...(plan.message ? { message: plan.message } : {}), counts: { ...plan.counts }, importable: state === "ok" };
}

function declaredPdfCount(read: PackageReadResult): number {
  let total = 0;
  for (const entry of read.modules) {
    if (entry.name === "library" && typeof entry.meta.documents === "number") total += Math.max(0, Math.floor(entry.meta.documents));
    if (entry.name === "drafts") {
      for (const key of ["signDocuments", "signSessions", "editDrafts", "proDrafts"]) {
        const value = entry.meta[key];
        if (typeof value === "number") total += Math.max(0, Math.floor(value));
      }
    }
  }
  return total;
}

/**
 * Lee el paquete (con contraseña si está cifrado) y planifica cada módulo contra lo que hay hoy, SIN escribir nada. Los
 * errores del contenedor (`needsPassword`, `wrongPassword`, límites, zip hostil…) vuelven como `{ ok: false, reason }`; un
 * módulo ausente, de una versión más nueva o dañado se queda en su estado y NO impide leer los demás.
 */
export async function readAndPlanEverything(file: Blob, password?: string, options: ReadEverythingOptions = {}): Promise<ReadEverythingResult> {
  let read: PackageReadResult;
  try {
    read = await readPackage(file, password === "" ? undefined : password);
  } catch (error) {
    if (error instanceof PackageError) {
      const reason = readFailureFor(error.code);
      return { ok: false, reason: reason === "noSignatures" ? "generic" : reason, code: error.code };
    }
    return { ok: false, reason: "generic" };
  }
  if (!read.modules.some((module) => PACKAGE_MODULES.includes(module.name as PackageModuleName))) {
    return { ok: false, reason: "noModules" };
  }

  const total = declaredPdfCount(read);
  let done = 0;
  const tick = () => {
    done += 1;
    options.onProgress?.(done, Math.max(total, done));
  };
  const libraryGuard = options.validatePdf ?? guardPdfBytes;
  const draftsGuard = options.validatePdf ? async (bytes: Uint8Array) => options.validatePdf!(bytes) : inputGuardPdfValidator();
  const imageGuard = options.validateImage ?? (async (png: Uint8Array) => (await validatePngForImport(png)).ok);

  const plans: EverythingPlans = { signatures: null, library: null, drafts: null, settings: null };
  const failed = new Set<PackageModuleName>();
  const has = (name: PackageModuleName) => read.modules.some((module) => module.name === name);

  if (has("signatures")) {
    try {
      const vault = await listVault();
      if (!vault.ok) failed.add("signatures");
      else plans.signatures = await planSignaturesImport(read, vault.entries, { validateImage: imageGuard });
    } catch {
      failed.add("signatures");
    }
  }
  if (has("library")) {
    try {
      plans.library = await planLibraryImport(read, await loadLibraryExisting(), {
        validatePdf: async (bytes) => {
          const ok = await libraryGuard(bytes);
          tick();
          return ok;
        },
      });
    } catch {
      failed.add("library");
    }
  }
  if (has("drafts")) {
    try {
      plans.drafts = await planDraftsImport(read, {
        validatePdf: async (bytes, fileName) => {
          const ok = await draftsGuard(bytes, fileName);
          tick();
          return ok;
        },
        validateImage: imageGuard,
        now: options.now,
      });
    } catch {
      failed.add("drafts");
    }
  }
  if (has("settings")) {
    try {
      plans.settings = planSettingsImport(read);
    } catch {
      failed.add("settings");
    }
  }

  const modules: ModuleSummary[] = PACKAGE_MODULES.filter((name) => has(name)).map((name) => {
    if (failed.has(name)) return summaryOf(name, null);
    return summaryOf(name, plans[name]);
  });
  return { ok: true, encrypted: read.encrypted, plans, modules, warnings: read.warnings.length };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Decisiones y límites                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

export type EverythingDecisions = {
  signatures: Record<string, SignatureDecision>;
  library: Record<string, LibraryDecision>;
  drafts: Record<string, DraftDecision>;
  settings: SettingsDecisions;
};

/** Las decisiones sugeridas de cada módulo (nuevo → importar; nunca se pierde nada por defecto; el historial de valores, omitido). */
export function defaultEverythingDecisions(plans: EverythingPlans): EverythingDecisions {
  return {
    signatures: plans.signatures && plans.signatures.state === "ok" ? defaultSignatureDecisions(plans.signatures) : {},
    library: plans.library && plans.library.state === "ok" ? defaultLibraryDecisions(plans.library) : {},
    drafts: plans.drafts && plans.drafts.state === "ok" ? defaultDraftDecisions(plans.drafts) : {},
    settings: plans.settings && plans.settings.state === "ok" ? defaultSettingsDecisions(plans.settings) : { settings: "omit", valueHistory: "omit" },
  };
}

export type EverythingLimits = {
  signatures: SignaturesLimitCheck | null;
  library: LibraryLimitCheck | null;
  drafts: DraftsLimitCheck | null;
  /** Elementos aprobados en total (lo que cuenta el botón «Importar N elementos»). */
  wanted: number;
  /** Aprobados por módulo. */
  wantedBy: Record<PackageModuleName, number>;
  /** Todos los módulos caben. */
  ok: boolean;
  /** Módulos que NO caben (la importación se bloquea hasta que se omita algo). */
  blocked: PackageModuleName[];
};

/** Cuántos de los aprobados caben en cada almacén, ANTES de escribir nada. */
export function checkEverythingLimits(plans: EverythingPlans, decisions: EverythingDecisions): EverythingLimits {
  const signatures = plans.signatures && plans.signatures.state === "ok" ? checkSignaturesLimits(plans.signatures, decisions.signatures) : null;
  const library = plans.library && plans.library.state === "ok" ? checkLibraryLimits(plans.library, decisions.library) : null;
  const drafts = plans.drafts && plans.drafts.state === "ok" ? checkDraftsLimits(plans.drafts, decisions.drafts) : null;
  let settingsWanted = 0;
  if (plans.settings && plans.settings.state === "ok") {
    if (decisions.settings.settings === "replace") settingsWanted += plans.settings.items.filter((item) => item.status === "new" || item.status === "different").length;
    const history = plans.settings.valueHistory.status;
    if (decisions.settings.valueHistory === "replace" && (history === "new" || history === "different")) settingsWanted += 1;
  }
  const wantedBy = { signatures: signatures?.wanted ?? 0, library: library?.wanted ?? 0, drafts: drafts?.wanted ?? 0, settings: settingsWanted };
  const blocked: PackageModuleName[] = [];
  if (signatures && !signatures.ok) blocked.push("signatures");
  if (library && !library.ok) blocked.push("library");
  if (drafts && !drafts.ok) blocked.push("drafts");
  return {
    signatures,
    library,
    drafts,
    wanted: wantedBy.signatures + wantedBy.library + wantedBy.drafts + wantedBy.settings,
    wantedBy,
    ok: blocked.length === 0,
    blocked,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Aplicar                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

export type ModuleFailureReason = "limit" | "quota" | "unavailable" | "invalid" | "blocked" | "changed" | "failed";

type Base<M extends PackageModuleName> = { module: M };
export type SignaturesOutcome = Base<"signatures"> & (
  | { status: "applied" | "nothing"; written: number; replaced: number; skipped: number }
  | { status: "failed"; reason: ModuleFailureReason; fits?: number; wanted?: number }
  | { status: "skipped"; why: SkipWhy }
);
export type LibraryOutcome = Base<"library"> & (
  | { status: "applied" | "nothing"; documents: number; documentsReplaced: number; templates: number; templatesReplaced: number; skipped: number; reassigned: number }
  | { status: "failed"; reason: ModuleFailureReason; fits?: number; wanted?: number }
  | { status: "skipped"; why: SkipWhy }
);
export type DraftsOutcome = Base<"drafts"> & (
  | { status: "applied" | "nothing"; written: number; replaced: number; keptBoth: number; skipped: number; strokesDropped: number; saved: { kind: string; id: string }[] }
  | { status: "failed"; reason: ModuleFailureReason; partial?: boolean }
  | { status: "skipped"; why: SkipWhy }
);
export type SettingsOutcome = Base<"settings"> & (
  | { status: "applied" | "nothing"; written: number; skipped: number; valueHistory: boolean; reloadRequired: boolean }
  | { status: "failed"; reason: ModuleFailureReason }
  | { status: "skipped"; why: SkipWhy }
);

/** Por qué un módulo no se tocó: no venía en el paquete, es de una versión más nueva, estaba dañado o no se pudo leer. */
export type SkipWhy = "absent" | "newerVersion" | "damaged" | "unavailable";

export type ModuleOutcome = SignaturesOutcome | LibraryOutcome | DraftsOutcome | SettingsOutcome;

export type ApplyEverythingResult = {
  /** Un resultado por módulo, en el orden de aplicación. */
  outcomes: ModuleOutcome[];
  applied: PackageModuleName[];
  failed: PackageModuleName[];
  /** Los almacenes en memoria (tema, idioma, interruptores) no se enteran de los ajustes importados: hay que recargar. */
  reloadRequired: boolean;
};

export type ApplyEverythingOptions = {
  /** Antes de aplicar cada módulo que tiene algo aprobado (para el progreso). */
  onModule?: (module: PackageModuleName) => void;
  /** Solo para pruebas. */
  now?: number;
};

function skipWhy(state: string | undefined): SkipWhy {
  return state === "newerVersion" ? "newerVersion" : state === "damaged" ? "damaged" : state === "absent" ? "absent" : "unavailable";
}

/**
 * Aplica lo aprobado MÓDULO A MÓDULO (firmas, biblioteca, borradores y, al final, ajustes). Cada módulo es atómico en sí;
 * si uno falla, los que ya se aplicaron bien NO se deshacen y el resultado dice cuál falló y por qué (el siguiente módulo
 * sigue). Un módulo sin nada aprobado no se toca. Nunca lanza.
 */
export async function applyEverything(plans: EverythingPlans, decisions: EverythingDecisions, options: ApplyEverythingOptions = {}): Promise<ApplyEverythingResult> {
  const limits = checkEverythingLimits(plans, decisions);
  const outcomes: ModuleOutcome[] = [];

  // Firmas
  {
    const plan = plans.signatures;
    if (!plan || plan.state !== "ok") outcomes.push({ module: "signatures", status: "skipped", why: skipWhy(plan?.state) });
    else if (limits.wantedBy.signatures === 0) outcomes.push({ module: "signatures", status: "nothing", written: 0, replaced: 0, skipped: plan.items.length });
    else {
      options.onModule?.("signatures");
      try {
        const result = await applySignaturesImport(plan, decisions.signatures);
        outcomes.push(
          result.ok
            ? { module: "signatures", status: result.written + result.replaced > 0 ? "applied" : "nothing", written: result.written, replaced: result.replaced, skipped: result.skipped }
            : { module: "signatures", status: "failed", reason: result.reason, fits: result.fits, wanted: result.wanted },
        );
      } catch {
        outcomes.push({ module: "signatures", status: "failed", reason: "failed" });
      }
    }
  }

  // Plantillas y documentos
  {
    const plan = plans.library;
    if (!plan || plan.state !== "ok") outcomes.push({ module: "library", status: "skipped", why: skipWhy(plan?.state) });
    else if (limits.wantedBy.library === 0) {
      outcomes.push({ module: "library", status: "nothing", documents: 0, documentsReplaced: 0, templates: 0, templatesReplaced: 0, skipped: plan.items.length, reassigned: 0 });
    } else {
      options.onModule?.("library");
      try {
        const result = await applyLibraryImport(plan, decisions.library);
        outcomes.push(
          result.ok
            ? {
                module: "library",
                status: result.documents + result.documentsReplaced + result.templates + result.templatesReplaced > 0 ? "applied" : "nothing",
                documents: result.documents,
                documentsReplaced: result.documentsReplaced,
                templates: result.templates,
                templatesReplaced: result.templatesReplaced,
                skipped: result.skipped,
                reassigned: result.reassigned,
              }
            : { module: "library", status: "failed", reason: result.reason, fits: result.fits, wanted: result.wanted },
        );
      } catch {
        outcomes.push({ module: "library", status: "failed", reason: "failed" });
      }
    }
  }

  // Borradores (antes que los ajustes: la política de «guardar las firmas» que se aplica es la de este navegador, la misma que mostró la vista previa)
  {
    const plan = plans.drafts;
    if (!plan || plan.state !== "ok") outcomes.push({ module: "drafts", status: "skipped", why: skipWhy(plan?.state) });
    else if (limits.wantedBy.drafts === 0) outcomes.push({ module: "drafts", status: "nothing", written: 0, replaced: 0, keptBoth: 0, skipped: plan.items.length, strokesDropped: 0, saved: [] });
    else {
      options.onModule?.("drafts");
      try {
        const result = await applyDraftsImport(plan, decisions.drafts, { now: options.now });
        outcomes.push(
          result.ok
            ? {
                module: "drafts",
                status: result.written > 0 ? "applied" : "nothing",
                written: result.written,
                replaced: result.replaced,
                keptBoth: result.keptBoth,
                skipped: result.skipped,
                strokesDropped: result.strokesDropped,
                saved: result.saved,
              }
            : { module: "drafts", status: "failed", reason: result.reason, ...(result.partial ? { partial: true } : {}) },
        );
      } catch {
        outcomes.push({ module: "drafts", status: "failed", reason: "failed" });
      }
    }
  }

  // Ajustes (el último: aplicarlos pide recargar la página)
  {
    const plan = plans.settings;
    if (!plan || plan.state !== "ok") outcomes.push({ module: "settings", status: "skipped", why: skipWhy(plan?.state) });
    else if (limits.wantedBy.settings === 0) outcomes.push({ module: "settings", status: "nothing", written: 0, skipped: plan.items.length, valueHistory: false, reloadRequired: false });
    else {
      options.onModule?.("settings");
      try {
        const result = await applySettingsImport(plan, decisions.settings);
        outcomes.push(
          result.ok
            ? { module: "settings", status: result.written > 0 || result.valueHistory ? "applied" : "nothing", written: result.written, skipped: result.skipped, valueHistory: result.valueHistory, reloadRequired: result.reloadRequired }
            : { module: "settings", status: "failed", reason: result.reason },
        );
      } catch {
        outcomes.push({ module: "settings", status: "failed", reason: "failed" });
      }
    }
  }

  return {
    outcomes,
    applied: outcomes.filter((item) => item.status === "applied").map((item) => item.module),
    failed: outcomes.filter((item) => item.status === "failed").map((item) => item.module),
    reloadRequired: outcomes.some((item) => item.module === "settings" && item.status === "applied" && item.reloadRequired),
  };
}

/**
 * ¿Hay algo que valga la pena respaldar (firmas, documentos, plantillas o borradores)? Lo usa el recordatorio para no avisar
 * a quien no tiene nada: solo los ajustes no cuentan. Nunca lanza.
 */
export async function hasBackupWorthyData(): Promise<boolean> {
  const description = await describeExport({ modules: { signatures: true, library: true, drafts: true } });
  return description.willInclude.length > 0;
}
