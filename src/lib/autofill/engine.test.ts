import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCR_TIMEOUT_MS, createExtract, ocrToBoxes } from "@/lib/autofill/engine";
import { buildPdf, pdfSource, textSource, type PageSpec } from "@/lib/autofill/testing/corpus";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";
import type { EngineDeps } from "@/lib/autofill/engine";
import type { PdfPageText, PdfSession } from "@/lib/autofill/pdfSession";
import { renderSheet, simulatedRecognizer } from "@/lib/autofill/testing/ocrSheet";
import type { AutofillSource } from "@/lib/autofill/types";

const FORM = ["Insured: Maria Testwell", "Phone: 305-555-0142", "Policy No. 12-AB-3456"];
const formPage = (): PageSpec => ({ ops: FORM.map((s, i) => ({ t: "text", x: 60, y: 150 + i * 24, s })) });
const sheetLines = [
  { text: "Insured: Maria Testwell", y: 150 },
  { text: "Phone: 305-555-0142", y: 200 },
  { text: "Policy No. 12-AB-3456", y: 250 },
];

const fileOf = (bytes: Uint8Array, name: string, type: string): File => new File([bytes as BlobPart], name, { type });
const imageSource = (png: Uint8Array): AutofillSource => ({ kind: "image", file: fileOf(png, "foto.png", "image/png"), origin: "camera" });
const keys = (values: Array<{ key: string }>): string[] => values.map((value) => value.key);

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});
afterEach(() => {
  // Ni un valor, ni nada, en la consola: el motor no escribe en ella.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("fuentes", () => {
  it("PDF con capa de texto: lee, no usa OCR", async () => {
    let ocrCalls = 0;
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(renderSheet(sheetLines)), onRecognize: () => (ocrCalls += 1) }));
    const result = await extract([await pdfSource([formPage()])], { locale: "en" });
    expect(keys(result.values)).toEqual(["insuredName1", "phone", "policyNumber"]);
    expect(result.usedOcr).toBe(false);
    expect(result.pagesRead).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(ocrCalls).toBe(0);
    expect(result.values.every((value) => value.evidence.origin === "text-layer" && value.evidence.sourceIndex === 0 && value.evidence.pageIndex === 0)).toBe(true);
  });

  it("texto pegado: directo, y un salto de pagina separa paginas", async () => {
    const extract = createExtract(nodeDeps());
    const result = await extract([textSource("Insured: Maria Testwell\fPhone: 305-555-0142")], { locale: "en" });
    expect(result.pagesRead).toBe(2);
    expect(result.values.map((value) => [value.key, value.evidence.pageIndex, value.evidence.origin])).toEqual([
      ["insuredName1", 0, "pasted"],
      ["phone", 1, "pasted"],
    ]);
    expect(result.usedOcr).toBe(false);
  });

  it("imagen: decodifica, pasa por OCR y lee", async () => {
    const sheet = renderSheet(sheetLines);
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet) }));
    const result = await extract([imageSource(sheet.png)], { locale: "en" });
    expect(result.usedOcr).toBe(true);
    expect(keys(result.values)).toEqual(["insuredName1", "phone", "policyNumber"]);
    expect(result.values.every((value) => value.evidence.origin === "ocr")).toBe(true);
  });

  it("PDF escaneado (solo imagen): se rasteriza y pasa por OCR", async () => {
    const sheet = renderSheet(sheetLines);
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(sheet.png);
    const page = doc.addPage([612, 792]);
    page.drawImage(png, { x: 0, y: 792 - 612 * (sheet.height / sheet.width), width: 612, height: 612 * (sheet.height / sheet.width) });
    const bytes = await doc.save();
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet) }));
    const result = await extract([{ kind: "pdf", file: fileOf(bytes, "scan.pdf", "application/pdf"), origin: "scan" }], { locale: "en" });
    expect(result.usedOcr).toBe(true);
    expect(keys(result.values)).toEqual(["insuredName1", "phone", "policyNumber"]);
  });

  it("una pagina en blanco (sin texto ni imagen) no gasta OCR", async () => {
    let calls = 0;
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(renderSheet(sheetLines)), onRecognize: () => (calls += 1) }));
    const result = await extract([await pdfSource([{ ops: [] }, formPage()])], { locale: "en" });
    expect(calls).toBe(0);
    expect(result.pagesRead).toBe(1);
    expect(keys(result.values)).toContain("insuredName1");
  });

  it("varias fuentes: cada valor sabe de cual salio", async () => {
    const extract = createExtract(nodeDeps());
    const result = await extract([textSource("Insured: Maria Testwell"), await pdfSource([formPage()]), textSource("Email: m@example.com")], { locale: "en" });
    const email = result.values.find((value) => value.key === "email");
    expect(email?.evidence.sourceIndex).toBe(2);
    expect(result.values.find((value) => value.key === "phone")?.evidence.sourceIndex).toBe(1);
  });
});

describe("avisos", () => {
  it("sin OCR disponible: aviso `ocr-unavailable`, sin colgarse, y se lee lo que hay", async () => {
    const sheet = renderSheet(sheetLines);
    const extract = createExtract(nodeDeps());
    const result = await extract([imageSource(sheet.png), textSource("Insured: Maria Testwell")], { locale: "es" });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["ocr-unavailable"]);
    expect(result.warnings[0].sourceIndex).toBe(0);
    expect(result.warnings[0].message).toMatch(/OCR/);
    expect(result.usedOcr).toBe(false);
    expect(keys(result.values)).toEqual(["insuredName1"]);
  });

  it("un reconocedor que falla no tumba la corrida", async () => {
    let calls = 0;
    const extract = createExtract(nodeDeps({ recognize: async () => { calls += 1; throw new Error("boom"); }, onReset: () => undefined }));
    const sheet = renderSheet(sheetLines);
    const result = await extract([imageSource(sheet.png), imageSource(sheet.png)], { locale: "en" });
    expect(result.warnings.map((warning) => warning.code)).toContain("ocr-unavailable");
    // Tras el primer fallo no se vuelve a intentar en la corrida.
    expect(calls).toBe(1);
    expect(result.values).toEqual([]);
  });

  it("un OCR colgado se abandona al vencer el plazo y se reinicia", async () => {
    let resets = 0;
    const sheet = renderSheet(sheetLines);
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet, { hang: true }), ocrTimeoutMs: 60, onReset: () => (resets += 1) }));
    const started = Date.now();
    const result = await extract([imageSource(sheet.png), textSource("Insured: Maria Testwell")], { locale: "en" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.warnings.map((warning) => warning.code)).toContain("ocr-unavailable");
    expect(resets).toBe(1);
    expect(keys(result.values)).toEqual(["insuredName1"]);
    expect(OCR_TIMEOUT_MS).toBeGreaterThan(10_000);
  });

  it("archivo ilegible: `unreadable-source` y las demas fuentes siguen", async () => {
    const extract = createExtract(nodeDeps());
    const broken: AutofillSource = { kind: "pdf", file: fileOf(new TextEncoder().encode("esto no es un pdf"), "x.pdf", "application/pdf"), origin: "file" };
    const badImage: AutofillSource = { kind: "image", file: fileOf(new Uint8Array([1, 2, 3]), "x.png", "image/png"), origin: "file" };
    const withOcr = createExtract(nodeDeps({ recognize: simulatedRecognizer(renderSheet(sheetLines)) }));
    const result = await extract([broken, textSource("Phone: 305-555-0142")], { locale: "en" });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "unreadable-source", sourceIndex: 0 })]);
    expect(keys(result.values)).toEqual(["phone"]);
    const second = await withOcr([badImage, textSource("Phone: 305-555-0142")], { locale: "en" });
    expect(second.warnings.map((w) => [w.code, w.sourceIndex])).toEqual([["unreadable-source", 0]]);
    expect(keys(second.values)).toEqual(["phone"]);
  });

  it("sin datos: `no-data`; sin fuentes: resultado vacio", async () => {
    const extract = createExtract(nodeDeps());
    const none = await extract([textSource("hello there, nothing to see")], { locale: "en" });
    expect(none.values).toEqual([]);
    expect(none.warnings.map((warning) => warning.code)).toEqual(["no-data"]);
    const empty = await extract([], { locale: "en" });
    expect(empty).toEqual({ values: [], warnings: [], pagesRead: 0, usedOcr: false });
  });

  it("los avisos van en el idioma pedido y sin valores", async () => {
    const extract = createExtract(nodeDeps());
    const es = await extract([textSource("hola")], { locale: "es" });
    const en = await extract([textSource("hello")], { locale: "en" });
    expect(es.warnings[0].message).toMatch(/No se encontraron/);
    expect(en.warnings[0].message).toMatch(/No data/);
  });
});

describe("limites", () => {
  it("lee como mucho `maxPages` paginas por fuente (12 por defecto) y avisa", async () => {
    const pages = Array.from({ length: 15 }, (_, i): PageSpec => ({ ops: [{ t: "text", x: 60, y: 150, s: `Policy No. P-${1000 + i}-AB` }] }));
    const extract = createExtract(nodeDeps());
    const source = await pdfSource(pages);
    const normal = await extract([source], { locale: "en" });
    expect(normal.pagesRead).toBe(12);
    expect(normal.warnings.map((warning) => warning.code)).toEqual(["too-many-pages"]);
    expect(normal.warnings[0].message).toContain("12");
    const few = await extract([source], { locale: "en", maxPages: 3 });
    expect(few.pagesRead).toBe(3);
    expect(few.values.filter((value) => value.key === "policyNumber")).toHaveLength(3);
    const all = await extract([await pdfSource(pages.slice(0, 5))], { locale: "en", maxPages: 50 });
    expect(all.pagesRead).toBe(5);
    expect(all.warnings).toEqual([]);
  });

  it("PDF de 1 000 paginas: solo se leen 12, rapido y sin reventar la memoria", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 1000; i += 1) doc.addPage([612, 792]).drawText(`Claim No. CLM-${100000 + i}`, { x: 60, y: 700, size: 11, font });
    const bytes = await doc.save();
    const extract = createExtract(nodeDeps());
    const started = Date.now();
    const result = await extract([{ kind: "pdf", file: fileOf(bytes, "big.pdf", "application/pdf"), origin: "file" }], { locale: "en" });
    expect(result.pagesRead).toBe(12);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["too-many-pages"]);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it("texto pegado enorme: se recorta sin colgarse", async () => {
    const extract = createExtract(nodeDeps());
    const huge = `${"relleno ".repeat(60_000)}\nPhone: 305-555-0142`;
    const started = Date.now();
    const result = await extract([textSource(huge)], { locale: "en" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.warnings.map((warning) => warning.code)).toContain("too-many-pages");
  });
});

describe("cancelacion y progreso", () => {
  it("una senal ya cancelada lanza AbortError sin leer nada", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createExtract(nodeDeps())([textSource("Phone: 305-555-0142")], { locale: "en", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancelar durante el OCR corta de inmediato", async () => {
    const sheet = renderSheet(sheetLines);
    const controller = new AbortController();
    const extract = createExtract(nodeDeps({ recognize: simulatedRecognizer(sheet, { delayMs: 5000 }) }));
    const pending = extract([imageSource(sheet.png)], { locale: "en", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("cancelar mientras se abre un PDF: AbortError al instante y el documento tardio se cierra", async () => {
    const controller = new AbortController();
    let closed = 0;
    let opened = false;
    const deps: EngineDeps = {
      ...nodeDeps(),
      openPdf: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            opened = true;
            resolve({ numPages: 1, readPage: async () => { throw new Error("no se lee"); }, rasterize: async () => null, release: async () => undefined, close: async () => { closed += 1; } });
          }, 150),
        ),
    };
    const pending = createExtract(deps)([{ kind: "pdf", file: new File([new Uint8Array(4)], "x.pdf"), origin: "file" }], { locale: "en", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // Rechazo ANTES de que el documento terminara de abrirse; el que llega tarde se cierra.
    expect(opened).toBe(false);
    await vi.waitFor(() => expect(closed).toBe(1));
  });

  it("cancelar entre paginas de un PDF", async () => {
    const pages = Array.from({ length: 10 }, (): PageSpec => formPage());
    const controller = new AbortController();
    let seen = 0;
    const extract = createExtract(nodeDeps());
    const pending = extract([await pdfSource(pages)], {
      locale: "en",
      signal: controller.signal,
      onProgress: () => {
        seen += 1;
        if (seen === 2) controller.abort();
      },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("el progreso sube sin retroceder y termina en 1", async () => {
    const reports: number[] = [];
    const extract = createExtract(nodeDeps());
    await extract([await pdfSource([formPage(), formPage(), formPage()]), textSource("Email: m@example.com")], { locale: "en", onProgress: (fraction) => reports.push(fraction) });
    expect(reports.length).toBeGreaterThan(2);
    expect(reports.every((value, i) => value >= 0 && value <= 1 && (i === 0 || value >= reports[i - 1]))).toBe(true);
    expect(reports[reports.length - 1]).toBe(1);
  });
});

describe("determinismo", () => {
  it("misma entrada, misma salida (ids incluidos)", async () => {
    const extract = createExtract(nodeDeps());
    const source = await pdfSource([formPage()]);
    const a = await extract([source], { locale: "en" });
    const b = await extract([source], { locale: "en" });
    expect(b).toEqual(a);
  });
});

describe("ocrToBoxes", () => {
  it("palabras con confianza; lineas sin palabras; solo texto plano", () => {
    const bbox = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(ocrToBoxes({ text: "", width: 1, height: 1, lines: [{ text: "a b", confidence: 80, bbox, words: [{ text: "a", confidence: 80, bbox }, { text: "b", confidence: 70, bbox }] }] })).toHaveLength(2);
    expect(ocrToBoxes({ text: "", width: 1, height: 1, lines: [{ text: "linea", confidence: 80, bbox, words: [] }] })).toEqual([expect.objectContaining({ text: "linea", confidence: 80 })]);
    expect(ocrToBoxes({ text: "Phone: 305-555-0142", width: 1, height: 1, lines: [] }).length).toBeGreaterThan(0);
    expect(ocrToBoxes({ text: "  ", width: 1, height: 1, lines: [] })).toEqual([]);
  });
});

describe("paginas especiales", () => {
  it("pagina girada (/Rotate 90) con el texto derecho en la vista", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([792, 612]);
    FORM.forEach((line, i) => page.drawText(line, { x: 60, y: 520 - i * 24, size: 11, font }));
    const upright = await doc.save();
    const extract = createExtract(nodeDeps());
    const result = await extract([{ kind: "pdf", file: fileOf(upright, "land.pdf", "application/pdf"), origin: "file" }], { locale: "en" });
    expect(keys(result.values)).toEqual(["insuredName1", "phone", "policyNumber"]);

    const rotated = await PDFDocument.load(upright);
    const { degrees } = await import("@cantoo/pdf-lib");
    rotated.getPage(0).setRotation(degrees(90));
    const bytes = await rotated.save();
    const sideways = await extract([{ kind: "pdf", file: fileOf(bytes, "rot.pdf", "application/pdf"), origin: "file" }], { locale: "en" });
    // Con la pagina girada el texto queda de lado en la vista: no se inventa nada.
    expect(sideways.values.filter((value) => value.tier === "high").every((value) => ["insuredName1", "phone", "policyNumber"].includes(value.key))).toBe(true);
    void buildPdf;
  });
});


describe("capa de texto ilegible (fuente sin mapa de caracteres)", () => {
  const garbage = (legible: number, illegible: number): PdfPageText => ({
    boxes: [{ text: "\uE000\uE001\uE002\uE003 Phone: 305-555-0142", x0: 40, x1: 300, y0: 100, y1: 111 }],
    width: 612,
    height: 792,
    chars: legible + illegible,
    legible,
    illegible,
    imageCoverage: async () => 0,
  });
  const pixels = { data: new Uint8ClampedArray(16 * 16 * 4).fill(0), width: 16, height: 16 };
  const stub = (page: PdfPageText, recognize?: EngineDeps["recognize"]): EngineDeps => ({
    openPdf: async (): Promise<PdfSession> => ({ numPages: 1, readPage: async () => page, rasterize: async () => pixels, release: async () => undefined, close: async () => undefined }),
    decodeImage: async () => pixels,
    ocrAvailable: async () => recognize !== undefined,
    recognize: recognize ?? (async () => ({ text: "", lines: [], width: 1, height: 1 })),
  });
  const source: AutofillSource = { kind: "pdf", file: new File([new Uint8Array(4)], "x.pdf"), origin: "file" };

  it("mucho texto pero casi todo ilegible: se lee la imagen con OCR", async () => {
    let calls = 0;
    const recognize: EngineDeps["recognize"] = async () => {
      calls += 1;
      return { text: "Policy No. 12-AB-3456", width: 16, height: 16, lines: [] };
    };
    const result = await createExtract(stub(garbage(20, 480), recognize))([source], { locale: "en" });
    expect(calls).toBe(1);
    expect(result.usedOcr).toBe(true);
    expect(keys(result.values)).toEqual(["policyNumber"]);
  });

  it("sin OCR: aviso y se aprovecha lo poco legible de la capa de texto", async () => {
    const result = await createExtract(stub(garbage(20, 480)))([source], { locale: "en" });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["ocr-unavailable"]);
    expect(keys(result.values)).toEqual(["phone"]);
  });

  it("si la pagina no se puede rasterizar: aviso `page-skipped` y las demas paginas siguen", async () => {
    const deps = stub(garbage(20, 480), async () => ({ text: "Policy No. 12-AB-3456", width: 16, height: 16, lines: [] }));
    const open = deps.openPdf;
    deps.openPdf = async (file, signal) => {
      const session = await open(file, signal);
      return { ...session, numPages: 2, readPage: async (index) => (index === 0 ? garbage(20, 480) : { ...garbage(480, 20), boxes: [{ text: "Email: m@example.com", x0: 40, x1: 200, y0: 100, y1: 111 }] }), rasterize: async () => { throw new Error("canvas"); } };
    };
    const result = await createExtract(deps)([source], { locale: "en" });
    expect(result.warnings.map((warning) => warning.code)).toContain("page-skipped");
    expect(keys(result.values)).toEqual(expect.arrayContaining(["phone", "email"]));
  });

  it("texto legible normal no llama al OCR", async () => {
    let calls = 0;
    const result = await createExtract(stub(garbage(480, 20), async () => { calls += 1; return { text: "", lines: [], width: 1, height: 1 }; }))([source], { locale: "en" });
    expect(calls).toBe(0);
    expect(keys(result.values)).toEqual(["phone"]);
  });
});
