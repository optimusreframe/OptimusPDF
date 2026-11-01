import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createExtract } from "@/lib/autofill/engine";
import { buildCorpus, type CorpusDoc } from "@/lib/autofill/testing/corpus";
import { buildHeldOutCorpus } from "@/lib/autofill/testing/heldout";
import { evaluate, type Report } from "@/lib/autofill/testing/metrics";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";
import { renderSheet, simulatedRecognizer } from "@/lib/autofill/testing/ocrSheet";
import { buildRealisticCorpusWithTruth } from "@/lib/autofill/testing/realistic";
import type { ExtractResult } from "@/lib/autofill/types";

/**
 * Metricas sobre el CORPUS SINTETICO (datos inventados, ES y EN, 20 disposiciones): precision de los `high` y recall por clave.
 * Objetivos: precision de los `high` >= 0,95 y recall de las claves con etiqueta clara >= 0,80. Ningun senuelo (membrete, pie,
 * bloque del ajustador, prosa) puede salir en ningun nivel, y ninguna clave "sin dato" puede llegar a `high`.
 * `AUTOFILL_METRICS_FILE=<ruta>` guarda el informe completo (solo datos sinteticos).
 */

let docs: CorpusDoc[] = [];
const rows: Array<{ doc: CorpusDoc; result: ExtractResult }> = [];
let report: Report;
let consoleCalls = 0;
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeAll(async () => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, method).mockImplementation(() => void (consoleCalls += 1)));
  docs = [...buildCorpus(), ...(await buildRealisticCorpusWithTruth())];
  const extract = createExtract(nodeDeps());
  for (const doc of docs) rows.push({ doc, result: await extract([await doc.source()], { locale: doc.locale }) });
  report = evaluate(rows);
  if (process.env.AUTOFILL_METRICS_FILE) fs.writeFileSync(process.env.AUTOFILL_METRICS_FILE, JSON.stringify(report, null, 1));
}, 180_000);

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("corpus sintetico", () => {
  it("tiene la variedad prometida", () => {
    expect(docs.length).toBeGreaterThanOrEqual(100);
    const layouts = new Set(docs.map((doc) => doc.layout.replace("+caps", "")));
    for (const expected of ["inline", "cols", "overlay", "split", "stacked", "headerRow", "dense", "contract", "letter", "declarations", "blank", "clauses", "pasted-lines", "pasted-email", "pasted-table", "real-multiLabel", "real-letterheadTable", "real-thirdParty", "real-moldAgreement", "real-serviceAuthorization", "real-lawRetainer"]) {
      expect(layouts.has(expected), expected).toBe(true);
    }
    expect(docs.some((doc) => doc.locale === "es")).toBe(true);
    expect(docs.some((doc) => doc.locale === "en")).toBe(true);
  });

  it("precision de los valores `high` >= 0,95 (global y por clave)", () => {
    expect(report.precisionHigh).toBeGreaterThanOrEqual(0.95);
    for (const [key, stats] of Object.entries(report.perKey)) {
      if (stats.highTotal < 5) continue;
      expect(stats.highCorrect / stats.highTotal, `precision ${key}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("recall de las claves con etiqueta clara >= 0,80 (global y por clave)", () => {
    expect(report.recallHigh).toBeGreaterThanOrEqual(0.8);
    for (const [key, stats] of Object.entries(report.perKey)) {
      if (stats.expectedHigh < 5) continue;
      expect(stats.foundHigh / stats.expectedHigh, `recall ${key}`).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("cada disposicion llega a >= 0,80 de recall", () => {
    for (const [layout, stats] of Object.entries(report.perLayout)) {
      if (stats.expectedHigh === 0) continue;
      expect(stats.foundHigh / stats.expectedHigh, layout).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("ningun senuelo (membrete, pie, bloque del ajustador, prosa) sale en ningun nivel", () => {
    expect(report.forbiddenHits).toEqual([]);
  });

  it("formularios en blanco y clausulas: ninguna clave sale como `high`", () => {
    expect(report.noHighViolations).toEqual([]);
    for (const { doc, result } of rows.filter((row) => row.doc.layout === "blank" || row.doc.layout === "clauses")) {
      expect(result.values.filter((value) => value.tier === "high"), doc.id).toEqual([]);
    }
  });

  it("ningun `high` sin etiqueta: los libres siempre van a revision", () => {
    for (const { doc, result } of rows) {
      for (const value of result.values) {
        if (value.tier === "high") expect(value.reason, `${doc.id} ${value.key}`).toMatch(/Next to|To the right|Below|Junto a|A la derecha|Debajo/);
      }
    }
  });

  it("todo valor trae evidencia valida y razon sin el valor", () => {
    for (const { doc, result } of rows) {
      for (const value of result.values) {
        expect(value.evidence.snippet.length, doc.id).toBeLessThanOrEqual(120);
        expect(value.evidence.snippet.length, doc.id).toBeGreaterThan(0);
        expect(value.confidence).toBeGreaterThan(0);
        expect(value.confidence).toBeLessThanOrEqual(0.99);
        expect(value.tier === "high" ? value.confidence >= 0.85 : value.confidence < 0.85, `${doc.id} ${value.key}`).toBe(true);
        if (value.value.length >= 8) expect(value.reason, doc.id).not.toContain(value.value);
      }
      expect(new Set(result.values.map((value) => value.id)).size).toBe(result.values.length);
    }
  });

  it("los valores de revision esperados aparecen (cartas: direccion y aseguradora)", () => {
    let expected = 0;
    let found = 0;
    for (const { doc, result } of rows) {
      for (const [key, raw] of Object.entries(doc.truth.review ?? {})) {
        expected += 1;
        const accepted = Array.isArray(raw) ? raw : [raw];
        if (result.values.some((value) => value.key === key && accepted.includes(value.value))) found += 1;
      }
    }
    expect(expected).toBeGreaterThan(0);
    expect(found / expected).toBeGreaterThanOrEqual(0.8);
  });

  it("ningun valor se escribio en la consola", () => {
    expect(consoleCalls).toBe(0);
  });
});

describe("OCR simulado con ruido", () => {
  const lines = [
    { text: "Insured: Maria Testwell", y: 140 },
    { text: "Phone: 305-555-0142", y: 190 },
    { text: "Email: maria.testwell@example.com", y: 240 },
    { text: "Policy No. 12-AB-3456", y: 290 },
    { text: "Claim #: CLM-2026-118342", y: 340 },
    { text: "Date of Loss: March 14, 2026", y: 390 },
  ];
  const image = (png: Uint8Array): { kind: "image"; file: File; origin: "camera" } => ({ kind: "image", file: new File([png as BlobPart], "hoja.png", { type: "image/png" }), origin: "camera" });

  it("palabras mal leidas (poca confianza) nunca llegan a `high` con un valor equivocado", async () => {
    const sheet = renderSheet(lines);
    const noisy = (word: string): boolean => /\d/.test(word) && !/^\d{4}$/.test(word);
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet, { noisy }) }));
    const result = await extract([image(sheet.png)], { locale: "en" });
    const truth: Record<string, string> = { insuredName1: "Maria Testwell", phone: "(305) 555-0142", email: "maria.testwell@example.com", policyNumber: "12-AB-3456", claimNumber: "CLM-2026-118342", lossDate: "03/14/2026" };
    for (const value of result.values.filter((item) => item.tier === "high")) expect(value.value, value.key).toBe(truth[value.key]);
    // Las palabras dudosas bajan a revision en lugar de desaparecer.
    expect(result.values.some((value) => value.tier === "review")).toBe(true);
  });

  it("licencia fotografiada (datos inventados): nombre y domicilio en revision; fecha de nacimiento y numero no se guardan", async () => {
    const sheet = renderSheet([
      { text: "DRIVER LICENSE", y: 90, size: 40 },
      { text: "DL S123-456-78-901-0", y: 150 },
      { text: "LN TESTWELL", y: 210 },
      { text: "FN MARIA", y: 250 },
      { text: "1234 SW 5TH ST", y: 300 },
      { text: "MIAMI FL 33166", y: 340 },
      { text: "DOB 01/02/1980  EXP 01/02/2030", y: 400 },
      { text: "SEX F  HGT 5-04  EYES BRN", y: 450 },
    ]);
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet) }));
    const result = await extract([image(sheet.png)], { locale: "es" });
    expect(result.values.map((value) => [value.key, value.value, value.tier])).toEqual([
      ["insuredName1", "Maria Testwell", "review"],
      ["address", "1234 SW 5th St, Miami FL 33166", "review"],
    ]);
    expect(result.values.every((value) => value.evidence.origin === "ocr")).toBe(true);
  });

  it("OCR limpio: lee lo mismo que la capa de texto", async () => {
    const sheet = renderSheet(lines);
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet) }));
    const result = await extract([image(sheet.png)], { locale: "en" });
    expect(result.values.map((value) => value.key)).toEqual(["insuredName1", "phone", "email", "policyNumber", "claimNumber", "lossDate"]);
    expect(result.values.filter((value) => value.tier === "high").length).toBeGreaterThanOrEqual(5);
  });
});

describe("conjunto con sinonimos de etiqueta no usados en el corpus principal", () => {
  it("precision >= 0,95 y recall >= 0,80 (56 documentos, ES y EN, 7 disposiciones)", async () => {
    const extract = createExtract(nodeDeps());
    const heldRows: Array<{ doc: CorpusDoc; result: ExtractResult }> = [];
    for (const doc of buildHeldOutCorpus()) heldRows.push({ doc, result: await extract([await doc.source()], { locale: doc.locale }) });
    const held = evaluate(heldRows);
    if (process.env.AUTOFILL_HELDOUT_FILE) fs.writeFileSync(process.env.AUTOFILL_HELDOUT_FILE, JSON.stringify(held, null, 1));
    expect(held.documents).toBe(56);
    expect(held.precisionHigh).toBeGreaterThanOrEqual(0.95);
    expect(held.recallHigh).toBeGreaterThanOrEqual(0.8);
    expect(held.forbiddenHits).toEqual([]);
  }, 120_000);
});
