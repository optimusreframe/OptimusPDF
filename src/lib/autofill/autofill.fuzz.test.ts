import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtract } from "@/lib/autofill/engine";
import { buildPdf, textSource } from "@/lib/autofill/testing/corpus";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";
import { makeRng } from "@/lib/scan/__fixtures__/rng";
import type { AutofillSource, ExtractResult } from "@/lib/autofill/types";

/**
 * Fuzz y casos extremos: basura, PDF vacio o roto, expresiones hostiles (tiempo acotado), texto enorme. El motor nunca lanza (salvo
 * `AbortError` si se cancela), nunca tarda de mas y nunca escribe en la consola.
 */

const extract = createExtract(nodeDeps());
let consoleCalls = 0;
beforeEach(() => {
  consoleCalls = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => void (consoleCalls += 1));
});
afterEach(() => {
  expect(consoleCalls).toBe(0);
  vi.restoreAllMocks();
});

function sane(result: ExtractResult): void {
  expect(Array.isArray(result.values)).toBe(true);
  expect(Array.isArray(result.warnings)).toBe(true);
  for (const value of result.values) {
    expect(value.value.trim()).not.toBe("");
    expect(value.evidence.snippet.length).toBeLessThanOrEqual(120);
    expect(value.confidence).toBeGreaterThan(0);
    expect(value.confidence).toBeLessThanOrEqual(1);
    expect(["high", "review"]).toContain(value.tier);
    expect(value.value.length).toBeLessThanOrEqual(200);
  }
}

describe("basura", () => {
  const WORDS = ["Insured:", "Phone:", "Policy", "No.", "#", "Date of Loss", "Claim", "Email:", "@", "(", ")", "____", "N/A", "12-AB", "305-555-0142", "March", "14,", "2026", "a@b.co", "Maria", "PEREZ", "y", "and", "Address:", "123", "Main", "St", "FL", "33166", ":", ".", "\t", " ", "Fecha", "de", "pérdida"];

  it("500 textos al azar (mezcla de etiquetas, valores y ruido) no lanzan y salen coherentes", async () => {
    const rng = makeRng(2026);
    const started = Date.now();
    for (let n = 0; n < 500; n += 1) {
      const lines = Array.from({ length: rng.int(1, 14) }, () => Array.from({ length: rng.int(1, 9) }, () => rng.pick(WORDS)).join(rng.chance(0.2) ? "     " : " ")).join("\n");
      sane(await extract([textSource(lines)], { locale: rng.chance(0.5) ? "es" : "en" }));
    }
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("procedencia: un correo, una poliza, un reclamo o un telefono devueltos SIEMPRE estan en el texto de entrada", async () => {
    const rng = makeRng(555);
    const alnum = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (let n = 0; n < 300; n += 1) {
      const text = Array.from({ length: rng.int(2, 12) }, () => Array.from({ length: rng.int(1, 8) }, () => rng.pick(WORDS)).join(rng.chance(0.2) ? "     " : " ")).join("\n");
      const result = await extract([textSource(text)], { locale: "en" });
      const haystack = alnum(text);
      for (const value of result.values) {
        if (["email", "policyNumber", "claimNumber", "phone"].includes(value.key)) expect(haystack, `${value.key}`).toContain(alnum(value.value.replace(/ ext\. \d+$/, "")));
      }
    }
  });

  it("caracteres aleatorios de todo Unicode, controles y emojis", async () => {
    const rng = makeRng(7);
    for (let n = 0; n < 150; n += 1) {
      const text = Array.from({ length: rng.int(0, 300) }, () => String.fromCodePoint(rng.chance(0.3) ? rng.int(0x20, 0x7e) : rng.chance(0.5) ? rng.int(0, 0x2fff) : rng.int(0x1f300, 0x1f64f))).join("");
      sane(await extract([textSource(text)], { locale: "en" }));
    }
  });

  it("bytes al azar como PDF e imagen: aviso, no excepcion", async () => {
    const rng = makeRng(99);
    const noise = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rng.int(0, 255));
    const sources: AutofillSource[] = [
      { kind: "pdf", file: new File([noise(2048) as BlobPart], "a.pdf"), origin: "file" },
      { kind: "pdf", file: new File([new Uint8Array(0)], "vacio.pdf"), origin: "file" },
      { kind: "pdf", file: new File([new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")], "roto.pdf"), origin: "file" },
      { kind: "image", file: new File([noise(512) as BlobPart], "a.png", { type: "image/png" }), origin: "file" },
    ];
    const result = await createExtract(nodeDeps({ recognize: async () => ({ text: "", lines: [], width: 1, height: 1 }) }))(sources, { locale: "en" });
    expect(result.values).toEqual([]);
    expect(result.warnings.filter((warning) => warning.code === "unreadable-source")).toHaveLength(sources.length);
  });

  it("PDF truncado a la mitad", async () => {
    const bytes = await buildPdf([{ ops: [{ t: "text", x: 60, y: 150, s: "Insured: Maria Testwell" }] }]);
    const result = await extract([{ kind: "pdf", file: new File([bytes.slice(0, Math.floor(bytes.length / 2)) as BlobPart], "t.pdf"), origin: "file" }], { locale: "en" });
    sane(result);
    expect(result.warnings.length + result.values.length).toBeGreaterThan(0);
  });
});

describe("PDF vacio y sin paginas utiles", () => {
  it("documento sin paginas", async () => {
    const doc = await PDFDocument.create();
    const result = await extract([{ kind: "pdf", file: new File([(await doc.save()) as BlobPart], "cero.pdf"), origin: "file" }], { locale: "en" });
    expect(result.values).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("varias paginas en blanco: sin valores y sin OCR", async () => {
    const bytes = await buildPdf([{ ops: [] }, { ops: [] }, { ops: [] }]);
    let calls = 0;
    const result = await createExtract(nodeDeps({ recognize: async () => { calls += 1; return { text: "", lines: [], width: 1, height: 1 }; } }))([{ kind: "pdf", file: new File([bytes as BlobPart], "b.pdf"), origin: "file" }], { locale: "en" });
    expect(result.values).toEqual([]);
    expect(calls).toBe(0);
    expect(result.pagesRead).toBe(0);
  });
});

describe("expresiones hostiles (tiempo acotado)", () => {
  const HOSTILE: Array<[string, string]> = [
    ["digitos", `Phone: ${"1".repeat(50_000)}`],
    ["arrobas", "a@".repeat(20_000)],
    ["numeros con espacios", `Phone: ${"1 ".repeat(30_000)}`],
    ["parentesis", `Insured: ${"(".repeat(30_000)}`],
    ["fechas", `Date of Loss: ${"1/".repeat(30_000)}`],
    ["iniciales", `Insured: ${"A. ".repeat(30_000)}`],
    ["guiones", `Policy No. ${"-".repeat(100_000)}`],
    ["rayas", `Insured: ${"_".repeat(150_000)}`],
    ["espacios", `Insured:${" ".repeat(150_000)}x`],
    ["etiqueta repetida", "Insured: ".repeat(15_000)],
    ["linea sin espacios", "x".repeat(190_000)],
    ["muchas lineas", "word word\n".repeat(19_000)],
    ["muchas lineas con etiquetas", "Insured: Maria Perez\n".repeat(9_000)],
    ["calle", `Address: ${"123 ".repeat(20_000)}`],
    ["ciudad", `Address: 123 Main St, ${"Miami ".repeat(20_000)}FL 33166`],
    ["meses", `Date of Loss: ${"marzo ".repeat(30_000)}`],
    ["comas", `Insured: ${"a,".repeat(50_000)}`],
  ];
  it.each(HOSTILE)("%s", async (_name, text) => {
    const started = Date.now();
    sane(await extract([textSource(text)], { locale: "en" }));
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15_000);

  it("un PDF con una linea enorme", async () => {
    const bytes = await buildPdf([{ ops: [{ t: "text", x: 10, y: 100, s: `Insured: ${"Maria ".repeat(2000)}`, size: 3 }] }]);
    const started = Date.now();
    sane(await extract([{ kind: "pdf", file: new File([bytes as BlobPart], "l.pdf"), origin: "file" }], { locale: "en" }));
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("cancelacion", () => {
  it("cancelar a mitad de varias fuentes grandes termina con AbortError y sin dejar nada colgando", async () => {
    const controller = new AbortController();
    const sources = Array.from({ length: 40 }, (): AutofillSource => textSource("Insured: Maria Testwell\n".repeat(200)));
    const pending = extract(sources, { locale: "en", signal: controller.signal, onProgress: (fraction) => { if (fraction > 0.3) controller.abort(); } });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
