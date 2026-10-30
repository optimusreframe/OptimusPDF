import { describe, expect, it } from "vitest";
import type { ExportDescription, ModuleOutcome } from "@/lib/backup/globalPackage";
import {
  chosenModules,
  countsLine,
  defaultExportChoice,
  draftDecisionOptions,
  draftKindLabel,
  lastBackupText,
  moduleAvailability,
  omissionNotes,
  outcomeLine,
  outcomeLines,
  packageParts,
  scanDecisionOptions,
  summaryLine,
  summaryParts,
} from "@/app/settings/packageModel";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/** Decisiones de pantalla de «Respaldo y traslado» (U4.7) sin React. */

const copy = es.settings.backup;

function description(over: Partial<ExportDescription> = {}): ExportDescription {
  return {
    signatures: { available: true, count: 2, bytes: 1000 },
    library: { available: true, documents: 3, templates: 1, bytes: 5000, withoutCopy: 0 },
    drafts: { available: true, count: 2, signCount: 1, editCount: 1, proCount: 0, bytes: 3000, withSignatureStrokes: 1, includesStrokes: true, strokesHeldBack: false, fitsInPackage: true, expiredSkipped: 0 },
    scanSessions: { available: true, sessions: [], count: 0, bytes: 0, selectedCount: 0, selectedPages: 0, selectedBytes: 0, fitsInPackage: true, large: false, unreadable: 0 },
    settings: { available: true, keys: 4, valueHistoryLabels: 2, valueHistoryValues: 3 },
    willInclude: ["signatures", "library", "drafts", "settings"],
    willOmitEmpty: [],
    unavailable: [],
    estimatedBytes: 9000,
    containsSignatureStrokes: true,
    containsScanSessions: false,
    containsSignatures: true,
    containsClientData: true,
    encryptionRecommended: true,
    tooLarge: false,
    limitBytes: 242 * 1024 * 1024,
    overBy: 0,
    nothingToExport: false,
    ...over,
  };
}

describe("exportar", () => {
  it("marca por defecto todo lo que tiene contenido y nunca el historial", () => {
    expect(defaultExportChoice(description())).toEqual({ signatures: true, library: true, drafts: true, scanSessions: false, settings: true });
    const empty = description({
      signatures: { available: true, count: 0, bytes: 0 },
      library: { available: true, documents: 0, templates: 0, bytes: 0, withoutCopy: 0 },
      drafts: { ...description().drafts, count: 0 },
      settings: { available: true, keys: 0, valueHistoryLabels: 3, valueHistoryValues: 3 },
    });
    expect(defaultExportChoice(empty)).toEqual({ signatures: false, library: false, drafts: false, scanSessions: false, settings: false });
    expect(defaultExportChoice(description({ library: { available: true, documents: 0, templates: 2, bytes: 0, withoutCopy: 0 } })).library).toBe(true);
  });

  it("los módulos elegidos salen en el orden del paquete", () => {
    expect(chosenModules({ settings: true, signatures: true, drafts: false, library: true })).toEqual(["signatures", "library", "settings"]);
    expect(chosenModules({})).toEqual([]);
  });

  it("el resumen cuenta solo lo que viaja y dice «sí/no» de las firmas dibujadas en Firmar", () => {
    expect(summaryParts(description(), copy, { includeValueHistory: false })).toEqual([
      "2 firmas",
      "3 documentos",
      "1 plantilla",
      "2 borradores (firmas dibujadas en los de Firmar: sí)",
      "ajustes",
    ]);
    expect(summaryParts(description({ drafts: { ...description().drafts, includesStrokes: false } }), copy, { includeValueHistory: true })).toContain(
      "2 borradores (firmas dibujadas en los de Firmar: no)",
    );
    expect(summaryParts(description(), copy, { includeValueHistory: true }).slice(-2)).toEqual(["ajustes", "historial de valores"]);
    // Sin borradores de Firmar no se habla de firmas dibujadas.
    expect(summaryParts(description({ drafts: { ...description().drafts, signCount: 0, count: 1 } }), copy, { includeValueHistory: false })).toContain("1 borrador");
    expect(summaryParts(description({ willInclude: ["library"] }), copy, { includeValueHistory: false })).toEqual(["3 documentos", "1 plantilla"]);
    expect(summaryParts(description({ willInclude: ["library"], library: { available: true, documents: 1, templates: 0, bytes: 0, withoutCopy: 0 } }), copy, { includeValueHistory: false })).toEqual(["1 documento"]);
  });

  it("la línea de resumen: cargando, nada que exportar o «Se exportará: …»", () => {
    expect(summaryLine(null, copy, "es", { includeValueHistory: false })).toBe(copy.summaryLoading);
    expect(summaryLine(description({ nothingToExport: true, willInclude: [] }), copy, "es", { includeValueHistory: false })).toBe(copy.summaryNothing);
    expect(summaryLine(description(), copy, "es", { includeValueHistory: false })).toMatch(/^Se exportará: 2 firmas, 3 documentos, 1 plantilla, 2 borradores \(.*\), ajustes\. Tamaño aproximado: 8[,.]\d KB\.$/);
  });

  it("avisos de módulos que no van, uno por motivo", () => {
    expect(omissionNotes([], copy)).toEqual([]);
    expect(
      omissionNotes(
        [
          { module: "signatures", reason: "empty" },
          { module: "drafts", reason: "empty" },
          { module: "library", reason: "unavailable" },
        ],
        copy,
      ),
    ).toEqual(["No se incluirá Firmas, Borradores: no hay nada que respaldar.", "No se incluyó Plantillas y documentos: este navegador no permite leerlo."]);
  });

  it("disponibilidad de cada módulo: ok, vacío o ilegible", () => {
    const d = description();
    for (const name of ["signatures", "library", "drafts", "settings"] as const) expect(moduleAvailability(d, name)).toBe("ok");
    expect(moduleAvailability(description({ signatures: { available: true, count: 0, bytes: 0 } }), "signatures")).toBe("empty");
    expect(moduleAvailability(description({ signatures: { available: false, count: 0, bytes: 0 } }), "signatures")).toBe("unavailable");
    expect(moduleAvailability(description({ library: { available: true, documents: 0, templates: 0, bytes: 0, withoutCopy: 0 } }), "library")).toBe("empty");
    expect(moduleAvailability(description({ library: { available: false, documents: 0, templates: 0, bytes: 0, withoutCopy: 0 } }), "library")).toBe("unavailable");
    expect(moduleAvailability(description({ drafts: { ...d.drafts, available: false } }), "drafts")).toBe("unavailable");
    expect(moduleAvailability(description({ drafts: { ...d.drafts, count: 0 } }), "drafts")).toBe("empty");
    expect(moduleAvailability(description({ settings: { available: true, keys: 0, valueHistoryLabels: 0, valueHistoryValues: 0 } }), "settings")).toBe("empty");
    expect(moduleAvailability(description({ settings: { available: false, keys: 1, valueHistoryLabels: 0, valueHistoryValues: 0 } }), "settings")).toBe("unavailable");
  });
});

describe("importar", () => {
  it("recuentos: solo los distintos de cero", () => {
    expect(countsLine({ new: 2, identical: 0, different: 1, invalid: 0 }, copy)).toBe("2 nuevos · 1 distintos");
    expect(countsLine({ new: 0, identical: 3, different: 0, invalid: 1 }, copy)).toBe("3 ya los tienes · 1 no se pueden importar");
    expect(countsLine({ new: 0, identical: 0, different: 0, invalid: 0 }, copy)).toBe("");
  });

  it("«El paquete trae»: solo módulos importables y recuentos mayores que cero", () => {
    const modules = [
      { module: "signatures", state: "ok", counts: { new: 0, identical: 0, different: 0, invalid: 0 }, importable: true },
      { module: "library", state: "ok", counts: { new: 0, identical: 0, different: 0, invalid: 0 }, importable: true },
      { module: "drafts", state: "newerVersion", counts: { new: 0, identical: 0, different: 0, invalid: 0 }, importable: false },
      { module: "settings", state: "ok", counts: { new: 0, identical: 0, different: 0, invalid: 0 }, importable: true },
    ] as const;
    expect(packageParts(modules, copy, { signatures: 2, documents: 3, templates: 1, drafts: 4, scanSessions: 2, settings: 1 })).toEqual(["2 firmas", "3 documentos", "1 plantilla", "1 ajuste"]);
    expect(packageParts(modules, copy, { signatures: 0, documents: 0, templates: 0, drafts: 0, scanSessions: 0, settings: 0 })).toEqual([]);
  });

  it("decisiones de un borrador: nuevo → importar/omitir; distinto → reemplazar (+ conservar ambos solo en Firmar)", () => {
    expect(draftDecisionOptions({ status: "new", canKeepBoth: true })).toEqual(["import", "omit"]);
    expect(draftDecisionOptions({ status: "different", canKeepBoth: true })).toEqual(["replace", "keepBoth", "omit"]);
    expect(draftDecisionOptions({ status: "different", canKeepBoth: false })).toEqual(["replace", "omit"]);
    expect(draftDecisionOptions({ status: "identical", canKeepBoth: true })).toEqual([]);
    expect(draftDecisionOptions({ status: "invalid", canKeepBoth: true })).toEqual([]);
  });

  it("rótulo del tipo de borrador", () => {
    expect(draftKindLabel({ kind: "sign-document", documents: 1 }, copy)).toBe("Firmar");
    expect(draftKindLabel({ kind: "sign-session", documents: 3 }, copy)).toBe("Firmar · 3 documentos");
    expect(draftKindLabel({ kind: "edit", documents: 1 }, copy)).toBe("Editar");
    expect(draftKindLabel({ kind: "pro", documents: 1 }, copy)).toBe("PDF Pro");
  });
});

describe("resultado por módulo", () => {
  const applied = (over: object): ModuleOutcome => ({ status: "applied", ...over }) as ModuleOutcome;

  it("una línea por módulo con su tono y sus recuentos", () => {
    expect(outcomeLine(applied({ module: "signatures", written: 2, replaced: 0, skipped: 0 }), copy)).toEqual({ tone: "ok", text: "Firmas: 2 importadas." });
    expect(outcomeLine(applied({ module: "signatures", written: 2, replaced: 1, skipped: 0 }), copy)).toEqual({ tone: "ok", text: "Firmas: 2 importadas, 1 reemplazadas." });
    expect(outcomeLine(applied({ module: "library", documents: 2, documentsReplaced: 1, templates: 1, templatesReplaced: 0, skipped: 0, reassigned: 0 }), copy)).toEqual({
      tone: "ok",
      text: "Plantillas y documentos: 3 documentos, 1 plantilla.",
    });
    expect(outcomeLine(applied({ module: "drafts", written: 4, replaced: 0, keptBoth: 0, skipped: 0, strokesDropped: 0, saved: [] }), copy)).toEqual({ tone: "ok", text: "Borradores: 4 importados." });
    expect(outcomeLine(applied({ module: "drafts", written: 4, replaced: 0, keptBoth: 0, skipped: 0, strokesDropped: 2, saved: [] }), copy)?.text).toBe("Borradores: 4 importados. 2 sin las firmas dibujadas.");
    expect(outcomeLine(applied({ module: "settings", written: 3, skipped: 0, valueHistory: false, reloadRequired: true }), copy)).toEqual({ tone: "ok", text: "Ajustes: 3 aplicados." });
    expect(outcomeLine(applied({ module: "settings", written: 3, skipped: 0, valueHistory: true, reloadRequired: true }), copy)?.text).toBe("Ajustes: 3 aplicados y el historial de valores.");
  });

  it("nada que importar, módulo que no venía, módulo no importado y módulo que falla", () => {
    expect(outcomeLine({ module: "drafts", status: "nothing", written: 0, replaced: 0, keptBoth: 0, skipped: 2, strokesDropped: 0, saved: [] }, copy)).toEqual({
      tone: "info",
      text: "Borradores: nada que importar (ya lo tenías).",
    });
    expect(outcomeLine({ module: "library", status: "skipped", why: "absent" }, copy)).toBeNull();
    expect(outcomeLine({ module: "library", status: "skipped", why: "newerVersion" }, copy)).toEqual({ tone: "info", text: "Plantillas y documentos: no se importó." });
    expect(outcomeLine({ module: "drafts", status: "failed", reason: "limit" }, copy)).toEqual({
      tone: "error",
      text: "Borradores: no se pudo importar (no caben todos los elementos elegidos). No se escribió nada de esta parte.",
    });
  });

  it("si algo falló y algo se aplicó, se dice que lo ya importado se conserva; si nada se hizo, también", () => {
    const lines = outcomeLines(
      [
        applied({ module: "signatures", written: 1, replaced: 0, skipped: 0 }),
        { module: "library", status: "skipped", why: "absent" },
        { module: "drafts", status: "failed", reason: "quota" },
        { module: "settings", status: "skipped", why: "absent" },
      ],
      copy,
    );
    // H4: lo que el paquete NO traía ya no es «no se importó»: va en UNA línea aparte («El paquete no incluye: …»).
    expect(lines.map((line) => line.tone)).toEqual(["ok", "error", "info", "info"]);
    expect(lines[2].text).toBe("El paquete no incluye: Plantillas y documentos, Ajustes.");
    expect(lines[3].text).toBe(copy.resultKeptOthers);
    const none = outcomeLines([{ module: "library", status: "skipped", why: "absent" }], copy);
    expect(none).toEqual([
      { tone: "info", text: "El paquete no incluye: Plantillas y documentos." },
      { tone: "info", text: copy.resultNothingAtAll },
    ]);
    const allFailed = outcomeLines([{ module: "drafts", status: "failed", reason: "failed" }], copy);
    expect(allFailed.map((line) => line.tone)).toEqual(["error"]);
    const idle = outcomeLines([{ module: "settings", status: "nothing", written: 0, skipped: 3, valueHistory: false, reloadRequired: false }], copy);
    expect(idle.map((line) => line.tone)).toEqual(["info"]);
  });
});

describe("«Último respaldo»", () => {
  it("cuatro formas, en los dos idiomas", () => {
    expect(lastBackupText({ kind: "never" }, copy)).toBe("Aún no has hecho un respaldo.");
    expect(lastBackupText({ kind: "today" }, copy)).toBe("Último respaldo: hoy.");
    expect(lastBackupText({ kind: "yesterday" }, copy)).toBe("Último respaldo: ayer.");
    expect(lastBackupText({ kind: "days", n: 12 }, copy)).toBe("Último respaldo: hace 12 días.");
    expect(lastBackupText({ kind: "days", n: 12 }, en.settings.backup)).toBe("Last backup: 12 days ago.");
  });
});

describe("escaneos en curso", () => {
  const scan = (over: Partial<ExportDescription["scanSessions"]> = {}): ExportDescription["scanSessions"] => ({
    available: true,
    sessions: [],
    count: 2,
    bytes: 5000,
    selectedCount: 2,
    selectedPages: 5,
    selectedBytes: 5000,
    fitsInPackage: true,
    large: false,
    unreadable: 0,
    ...over,
  });
  const applied = (over: object): ModuleOutcome => ({ status: "applied", ...over }) as ModuleOutcome;

  it("la casilla viene marcada si hay pocos y caben; desmarcada si pesan mucho, no caben o no hay", () => {
    expect(defaultExportChoice(description({ scanSessions: scan() })).scanSessions).toBe(true);
    expect(defaultExportChoice(description({ scanSessions: scan({ large: true }) })).scanSessions).toBe(false);
    expect(defaultExportChoice(description({ scanSessions: scan({ fitsInPackage: false }) })).scanSessions).toBe(false);
    expect(defaultExportChoice(description({ scanSessions: scan({ count: 0, selectedCount: 0 }) })).scanSessions).toBe(false);
  });

  it("el resumen cuenta los escaneos elegidos y sus páginas, con singular y plural, en los dos idiomas", () => {
    const withScan = description({ willInclude: ["scanSessions"], scanSessions: scan() });
    expect(summaryParts(withScan, copy, { includeValueHistory: false })).toEqual(["2 escaneos (5 páginas)"]);
    expect(summaryParts(description({ willInclude: ["scanSessions"], scanSessions: scan({ selectedCount: 1, selectedPages: 1 }) }), copy, { includeValueHistory: false })).toEqual(["1 escaneo (1 página)"]);
    expect(summaryParts(withScan, en.settings.backup, { includeValueHistory: false })).toEqual(["2 scans (5 pages)"]);
    // Sin marcarlo no aparece aunque haya escaneos.
    expect(summaryParts(description({ scanSessions: scan() }), copy, { includeValueHistory: false })).not.toContain("2 escaneos (5 páginas)");
  });

  it("disponibilidad: ilegible, vacío o con contenido", () => {
    expect(moduleAvailability(description({ scanSessions: scan({ available: false }) }), "scanSessions")).toBe("unavailable");
    expect(moduleAvailability(description({ scanSessions: scan({ count: 0 }) }), "scanSessions")).toBe("empty");
    expect(moduleAvailability(description({ scanSessions: scan() }), "scanSessions")).toBe("ok");
  });

  it("«El paquete trae»: cuenta los escaneos importables y los módulos no importables no cuentan", () => {
    const ok = [{ module: "scanSessions", state: "ok", counts: { new: 0, identical: 0, different: 0, invalid: 0 }, importable: true }] as const;
    const bad = [{ module: "scanSessions", state: "newerVersion", counts: { new: 0, identical: 0, different: 0, invalid: 0 }, importable: false }] as const;
    const zero = { signatures: 0, documents: 0, templates: 0, drafts: 0, settings: 0 };
    expect(packageParts(ok, copy, { ...zero, scanSessions: 3 })).toEqual(["3 escaneos"]);
    expect(packageParts(ok, copy, { ...zero, scanSessions: 1 })).toEqual(["1 escaneo"]);
    expect(packageParts(bad, copy, { ...zero, scanSessions: 3 })).toEqual([]);
  });

  it("las decisiones de un escaneo son las de un borrador de Firmar (nuevo: importar; distinto: reemplazar, conservar ambos, omitir)", () => {
    expect(scanDecisionOptions({ status: "new", canKeepBoth: true })).toEqual(["import", "omit"]);
    expect(scanDecisionOptions({ status: "different", canKeepBoth: true })).toEqual(["replace", "keepBoth", "omit"]);
    expect(scanDecisionOptions({ status: "identical", canKeepBoth: true })).toEqual([]);
    expect(scanDecisionOptions({ status: "invalid", canKeepBoth: true })).toEqual([]);
  });

  it("resultado: importados, y lo que no se pudo guardar o cambió mientras se revisaba se dice (nunca «ya lo tenías»)", () => {
    const base = { module: "scanSessions", replaced: 0, keptBoth: 0, skipped: 0, saved: [] };
    expect(outcomeLine(applied({ ...base, written: 2, changed: 0, failed: 0 }), copy)).toEqual({ tone: "ok", text: "Escaneos en curso: 2 importados." });
    expect(outcomeLine(applied({ ...base, written: 2, changed: 0, failed: 1, failedReason: "quota" }), copy)).toEqual({
      tone: "info",
      text: "Escaneos en curso: 2 importados. 1 no se pudieron guardar (no hay espacio suficiente en este navegador).",
    });
    expect(outcomeLine(applied({ ...base, written: 1, changed: 2, failed: 0 }), copy)?.text).toBe("Escaneos en curso: 1 importados. 2 no se importaron porque cambiaron mientras revisabas.");
    // Nada importado pero algo cambió: lo dice, no «nada que importar (ya lo tenías)».
    expect(outcomeLine({ ...base, status: "nothing", written: 0, changed: 1, failed: 0 } as ModuleOutcome, copy)).toEqual({
      tone: "info",
      text: "1 no se importaron porque cambiaron mientras revisabas.",
    });
    expect(outcomeLine({ ...base, status: "nothing", written: 0, changed: 0, failed: 0 } as ModuleOutcome, copy)).toEqual({
      tone: "info",
      text: "Escaneos en curso: nada que importar (ya lo tenías).",
    });
    expect(outcomeLine({ module: "scanSessions", status: "failed", reason: "quota", failedReason: "quota" }, copy)?.text).toBe(
      "Escaneos en curso: no se pudo importar (no hay espacio suficiente en este navegador; libera espacio o exporta y borra algo). No se escribió nada de esta parte.",
    );
    expect(outcomeLine({ module: "scanSessions", status: "skipped", why: "absent" }, copy)).toBeNull();
    expect(outcomeLines([{ module: "scanSessions", status: "skipped", why: "absent" }], copy).map((line) => line.text)).toEqual(["El paquete no incluye: Escaneos en curso.", copy.resultNothingAtAll]);
    expect(outcomeLine(applied({ ...base, written: 3, changed: 0, failed: 0 }), en.settings.backup)?.text).toBe("Scans in progress: 3 imported.");
  });

  it("todo texto nuevo existe en los dos idiomas (mismas claves, ninguna vacía)", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`)) : [prefix];
    expect(keys(en.settings.backup).sort()).toEqual(keys(es.settings.backup).sort());
    for (const key of Object.keys(es.settings.backup).filter((name) => /^(scan|pages|resultScan|limitScan|summaryScan)/.test(name))) {
      const spanish = (es.settings.backup as Record<string, unknown>)[key];
      const english = (en.settings.backup as Record<string, unknown>)[key];
      expect(english, key).toBeDefined();
      if (typeof spanish === "string") {
        expect(spanish.length, key).toBeGreaterThan(0);
        // (salvo un formato sin palabras, como «{pages} · {size}»: es el mismo en los dos idiomas)
        if (/[A-Za-zÁÉÍÓÚáéíóúñ]{3,}/.test(spanish.replace(/\{\w+\}/g, ""))) expect(spanish, key).not.toBe(english);
        // Los mismos marcadores {n}, {size}... en los dos idiomas.
        expect((spanish.match(/\{\w+\}/g) ?? []).sort(), key).toEqual(((english as string).match(/\{\w+\}/g) ?? []).sort());
      }
    }
  });
});
