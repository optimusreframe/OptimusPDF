import { describe, expect, it } from "vitest";
import { createExtract } from "@/lib/autofill/engine";
import { buildPdf, type Op, type PageSpec } from "@/lib/autofill/testing/corpus";
import { nodeDeps } from "@/lib/autofill/testing/nodeDeps";

/**
 * Rendimiento: un PDF con capa de texto de 12 paginas densas debe leerse en menos de 1,5 s en Node (apertura de pdf.js incluida), sin
 * OCR, y la memoria no crece con las repeticiones. Se mide caliente (despues de una pasada de calentamiento) y se toma la mediana.
 */

const PROSE = [
  "The parties agree that the services described herein will be performed in a workmanlike manner and in accordance with applicable law.",
  "Any dispute arising under this agreement shall first be submitted to good faith negotiation before any further proceedings are started.",
  "Payment is due within thirty days of the invoice date and late balances may accrue a monthly finance charge as permitted by statute.",
  "The insured authorizes the company to communicate with the carrier regarding the status of the claim and the scope of the repairs.",
];

function densePage(n: number): PageSpec {
  const ops: Op[] = [];
  for (let line = 0; line < 52; line += 1) ops.push({ t: "text", x: 40, y: 60 + line * 13.2, s: `${PROSE[(line + n) % PROSE.length]}`, size: 8 });
  ops.push({ t: "text", x: 40, y: 760, s: `Insured: Maria Testwell     Phone: 305-555-0142     Policy No. 12-AB-3456   page ${n + 1}`, size: 8 });
  return { ops };
}

describe("rendimiento", () => {
  it("12 paginas con capa de texto: < 1,5 s en caliente, sin OCR", async () => {
    const bytes = await buildPdf(Array.from({ length: 12 }, (_, n) => densePage(n)));
    let ocrCalls = 0;
    const extract = createExtract(nodeDeps({ recognize: async () => { ocrCalls += 1; return { text: "", lines: [], width: 1, height: 1 }; } }));
    const run = async (): Promise<number> => {
      const started = performance.now();
      const result = await extract([{ kind: "pdf", file: new File([bytes as BlobPart], "doc.pdf"), origin: "file" }], { locale: "en" });
      const elapsed = performance.now() - started;
      expect(result.pagesRead).toBe(12);
      expect(result.values.map((value) => value.key)).toContain("policyNumber");
      return elapsed;
    };
    await run();
    const times = [await run(), await run(), await run()].sort((a, b) => a - b);
    expect(times[1]).toBeLessThan(1500);
    expect(ocrCalls).toBe(0);
  }, 30_000);

  it("la memoria no crece con las repeticiones", async () => {
    const bytes = await buildPdf(Array.from({ length: 12 }, (_, n) => densePage(n)));
    const extract = createExtract(nodeDeps());
    const file = new File([bytes as BlobPart], "doc.pdf");
    for (let i = 0; i < 3; i += 1) await extract([{ kind: "pdf", file, origin: "file" }], { locale: "en" });
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 12; i += 1) await extract([{ kind: "pdf", file, origin: "file" }], { locale: "en" });
    globalThis.gc?.();
    const grown = process.memoryUsage().heapUsed - before;
    // Sin `--expose-gc` la medida es ruidosa: el tope es holgado (un escape real de 12 corridas pasaria de los 120 MB).
    expect(grown).toBeLessThan(120 * 1024 * 1024);
  }, 60_000);
});
