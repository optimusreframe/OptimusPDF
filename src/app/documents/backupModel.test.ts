import { describe, expect, it } from "vitest";
import {
  countText,
  decisionLabelKey,
  decisionOptionsFor,
  describeApplyFailure,
  fillText,
  hintKeyFor,
  invalidItems,
  lastBackupView,
  planTotals,
  statusLabelKey,
} from "@/app/documents/backupModel";
import type { LibraryImportItem } from "@/lib/backup/modules/library";

/** Decisiones de pantalla del respaldo de Mis documentos (puras, sin React). */

const item = (over: Partial<LibraryImportItem>): LibraryImportItem => ({
  key: "k",
  kind: "document",
  status: "new",
  id: "k",
  name: "K",
  docType: "",
  pageCount: 1,
  bytes: 1,
  templates: [],
  ...over,
});

describe("decisiones por estado", () => {
  it("nuevo: Importar / Omitir; idéntico e inválido: ninguna", () => {
    expect(decisionOptionsFor({ status: "new" })).toEqual(["import", "omit"]);
    expect(decisionOptionsFor({ status: "identical" })).toEqual([]);
    expect(decisionOptionsFor({ status: "invalid" })).toEqual([]);
  });
  it("distinto: otro PDF o plantillas cambiadas → Reemplazar / Conservar ambos / Omitir; solo plantillas nuevas → Añadir / Omitir", () => {
    expect(decisionOptionsFor({ status: "different", difference: "pdf" })).toEqual(["replace", "keepBoth", "omit"]);
    expect(decisionOptionsFor({ status: "different", difference: "templates", changesTemplates: true })).toEqual(["replace", "keepBoth", "omit"]);
    expect(decisionOptionsFor({ status: "different", difference: "templates", changesTemplates: false })).toEqual(["import", "omit"]);
  });
  it("el rótulo de «import» sobre algo distinto es «Añadir plantillas»", () => {
    expect(decisionLabelKey("import", { status: "new" })).toBe("decisionImport");
    expect(decisionLabelKey("import", { status: "different" })).toBe("decisionAdd");
    expect(decisionLabelKey("replace", { status: "different" })).toBe("decisionReplace");
    expect(decisionLabelKey("keepBoth", { status: "different" })).toBe("decisionKeepBoth");
    expect(decisionLabelKey("omit", { status: "new" })).toBe("decisionOmit");
  });
  it("el texto de cada estado", () => {
    expect(["new", "identical", "different", "invalid"].map((s) => statusLabelKey(s as LibraryImportItem["status"]))).toEqual([
      "statusNew",
      "statusIdentical",
      "statusDifferent",
      "statusInvalid",
    ]);
  });
  it("la explicación de lo distinto", () => {
    expect(hintKeyFor({ status: "new", kind: "document" })).toBeNull();
    expect(hintKeyFor({ status: "identical", kind: "document" })).toBeNull();
    expect(hintKeyFor({ status: "different", kind: "template" })).toBe("hintTemplateSolo");
    expect(hintKeyFor({ status: "different", kind: "document", difference: "pdf" })).toBe("hintPdf");
    expect(hintKeyFor({ status: "different", kind: "document", difference: "templates", changesTemplates: true })).toBe("hintTemplatesChanged");
    expect(hintKeyFor({ status: "different", kind: "document", difference: "templates", changesTemplates: false })).toBe("hintTemplatesNew");
  });
});

describe("fallos y totales", () => {
  it("blocked cuenta como «no válido»; el resto se conserva", () => {
    expect(describeApplyFailure("blocked")).toBe("invalid");
    for (const reason of ["limit", "quota", "unavailable", "invalid", "changed", "failed"] as const) expect(describeApplyFailure(reason)).toBe(reason);
  });
  it("planTotals cuenta documentos y plantillas válidas, no las inválidas", () => {
    const row = (status: "new" | "invalid") => ({ id: "t", name: "T", status });
    const totals = planTotals({
      items: [
        item({ templates: [row("new"), row("invalid")] }),
        item({ key: "b", status: "invalid" }),
        item({ key: "c", kind: "template", templates: [row("new")] }),
      ],
    });
    expect(totals).toEqual({ documents: 1, templates: 2, invalid: 1 });
    expect(invalidItems({ items: [item({ status: "invalid", key: "x" }), item({})] }).map((i) => i.key)).toEqual(["x"]);
  });
  it("fillText y countText", () => {
    expect(fillText("{a} y {b} y {c}", { a: 1, b: "dos" })).toBe("1 y dos y {c}");
    expect(fillText("{__proto__}", {})).toBe("{__proto__}");
    expect(countText(1, "1 doc", "{n} docs")).toBe("1 doc");
    expect(countText(0, "1 doc", "{n} docs")).toBe("0 docs");
    expect(countText(3, "1 doc", "{n} docs")).toBe("3 docs");
  });
});

describe("lastBackupView", () => {
  const now = new Date(2026, 9, 20, 15, 0);
  it("nunca / hoy / ayer / hace N días (días naturales locales)", () => {
    expect(lastBackupView(null, now)).toEqual({ kind: "never" });
    expect(lastBackupView(new Date(2026, 9, 20, 0, 1), now)).toEqual({ kind: "today" });
    expect(lastBackupView(new Date(2026, 9, 19, 23, 59), now)).toEqual({ kind: "yesterday" });
    expect(lastBackupView(new Date(2026, 9, 10, 8, 0), now)).toEqual({ kind: "days", n: 10 });
    expect(lastBackupView(new Date(2026, 9, 21, 8, 0), now)).toEqual({ kind: "today" });
  });
});
