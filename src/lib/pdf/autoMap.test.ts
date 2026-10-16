import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  HIGH_CONFIDENCE,
  MAX_FIELDS_PER_DOCUMENT,
  MAX_FIELDS_PER_PAGE,
  REVIEW_CONFIDENCE,
  applyCaps,
  autoMapDocument,
  dedupeFields,
  finalizeTier,
} from "@/lib/pdf/autoMap";
import type { AutoField, AutoMapWarning } from "@/lib/pdf/autoMapTypes";
import { openForAnalysis } from "@/lib/pdf/testing/autoMapHarness";
import { FONT_FRACTION, captionedLine, paragraph, renderSynthetic, syntheticCorpus, textWidth, type Item, type SyntheticDoc } from "@/lib/pdf/testing/autoMapSynthetic";

function field(partial: Omit<Partial<AutoField>, "rect"> & { rect?: Partial<AutoField["rect"]> }): AutoField {
  const { rect, ...rest } = partial;
  return {
    id: "f",
    pageIndex: 0,
    type: "initials",
    confidence: 0.9,
    tier: "high",
    reason: "",
    source: "label",
    ...rest,
    rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.04, ...rect },
  };
}

describe("finalizeTier", () => {
  const base = { tier: "high" as const, confidence: 0.92, notes: [] as string[], signerIndex: 0 as const, type: "signature" as const };
  it("deja pasar una propuesta limpia", () => {
    expect(finalizeTier(base, 2)).toEqual({ tier: "high", confidence: 0.92 });
  });
  it.each(["blocked", "covers-text", "covers-image", "company", "no-signer", "no-line", "slot-structural"])("el aviso «%s» baja `high` a `review`", (note) => {
    const r = finalizeTier({ ...base, notes: [note] }, 2);
    expect(r.tier).toBe("review");
    expect(r.confidence).toBeLessThan(HIGH_CONFIDENCE);
    expect(r.confidence).toBeGreaterThanOrEqual(REVIEW_CONFIDENCE);
  });
  it("«tight» (poco espacio entre iniciales) no baja el nivel", () => {
    expect(finalizeTier({ ...base, notes: ["tight"] }, 2).tier).toBe("high");
  });
  it("el firmante 2 con un solo firmante se ignora", () => {
    expect(finalizeTier({ ...base, signerIndex: 1 }, 1).tier).toBe("ignore");
    expect(finalizeTier({ ...base, signerIndex: 1 }, 2).tier).toBe("high");
    expect(finalizeTier({ ...base, signerIndex: undefined }, 1).tier).toBe("high");
  });
  it("la confianza cae siempre dentro del rango de su nivel", () => {
    expect(finalizeTier({ ...base, confidence: 0.5 }, 2).confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    expect(finalizeTier({ ...base, confidence: 0.2, tier: "review" }, 2).confidence).toBeGreaterThanOrEqual(REVIEW_CONFIDENCE);
    expect(finalizeTier({ ...base, confidence: 0.99, tier: "review" }, 2).confidence).toBeLessThan(HIGH_CONFIDENCE);
    expect(finalizeTier({ ...base, confidence: 0.99 }, 2).confidence).toBeLessThanOrEqual(0.97);
    expect(finalizeTier({ ...base, confidence: 0.9, tier: "ignore" }, 2).confidence).toBeLessThan(REVIEW_CONFIDENCE);
  });
});

describe("dedupeFields", () => {
  it("quita la copia menos fiable de una misma propuesta", () => {
    const a = field({ confidence: 0.95 });
    const b = field({ confidence: 0.8, tier: "review", rect: { x: 0.11 } });
    expect(dedupeFields([b, a])).toEqual([a]);
  });
  it("mismo tipo en otra pagina o lejos no es duplicado", () => {
    const a = field({});
    expect(dedupeFields([a, field({ pageIndex: 1 })])).toHaveLength(2);
    expect(dedupeFields([a, field({ rect: { x: 0.6 } })])).toHaveLength(2);
  });
  it("dos iniciales pegadas (firmante 1 y 2) no son duplicadas", () => {
    expect(dedupeFields([field({ signerIndex: 0, rect: { x: 0.7, width: 0.06 } }), field({ signerIndex: 1, rect: { x: 0.76, width: 0.06 } })])).toHaveLength(2);
  });
  it("tipos distintos solo se funden si casi coinciden", () => {
    expect(dedupeFields([field({ type: "text" }), field({ type: "date", rect: { x: 0.6, y: 0.6 } })])).toHaveLength(2);
    expect(dedupeFields([field({ type: "text", confidence: 0.7, tier: "review" }), field({ type: "date" })])).toHaveLength(1);
  });
});

describe("applyCaps", () => {
  const many = (page: number, n: number, tier: AutoField["tier"] = "high") =>
    Array.from({ length: n }, (_, i) => field({ pageIndex: page, type: "text", tier, confidence: 0.9 - i * 0.001, rect: { x: 0.05, y: 0.02 + i * 0.03, width: 0.1, height: 0.02 } }));
  it("12 por pagina, dejando fuera lo menos fiable", () => {
    const warnings: AutoMapWarning[] = [];
    const kept = applyCaps(many(0, 20), warnings, "es");
    expect(kept).toHaveLength(MAX_FIELDS_PER_PAGE);
    expect(MAX_FIELDS_PER_PAGE).toBe(12);
    expect(warnings.map((w) => w.code)).toEqual(["page-field-cap"]);
    expect(Math.min(...kept.map((f) => f.confidence))).toBeGreaterThan(0.9 - 12 * 0.001 - 1e-9);
  });
  it("con exactamente 12 no hay aviso", () => {
    const warnings: AutoMapWarning[] = [];
    expect(applyCaps(many(0, 12), warnings, "es")).toHaveLength(12);
    expect(warnings).toHaveLength(0);
  });
  it("80 por documento", () => {
    const warnings: AutoMapWarning[] = [];
    const all = Array.from({ length: 10 }, (_, p) => many(p, 10)).flat();
    const kept = applyCaps(all, warnings, "es");
    expect(kept).toHaveLength(MAX_FIELDS_PER_DOCUMENT);
    expect(MAX_FIELDS_PER_DOCUMENT).toBe(80);
    expect(warnings.map((w) => w.code)).toContain("document-field-cap");
  });
  it("iniciales y firmas se conservan antes que los textos, y `high` antes que `review`", () => {
    const warnings: AutoMapWarning[] = [];
    const list = [...many(0, 11, "review"), field({ type: "initials", tier: "high", confidence: 0.76 }), field({ type: "text", tier: "high", confidence: 0.99, rect: { x: 0.7, y: 0.9 } })];
    const kept = applyCaps(list, warnings, "es");
    expect(kept).toHaveLength(12);
    expect(kept.some((f) => f.type === "initials")).toBe(true);
    expect(kept.filter((f) => f.tier === "high")).toHaveLength(2);
  });
  it("los `ignore` no cuentan para los topes", () => {
    const warnings: AutoMapWarning[] = [];
    const kept = applyCaps([...many(0, 12), ...many(0, 30, "ignore")], warnings, "es");
    expect(kept.filter((f) => f.tier !== "ignore")).toHaveLength(12);
    expect(warnings).toHaveLength(0);
  });
});

/** Un contrato con `rows` filas de «Signature» con su raya en cada una de `pages` paginas. */
function manyLines(pages: number, rows: number): SyntheticDoc {
  return {
    name: "many",
    signers: 2,
    pages: Array.from({ length: pages }, () => {
      const items: Item[] = [];
      // Largos y pasos irregulares: una pila regular de rayas iguales es papel pautado y no se propone.
      for (let r = 0; r < rows; r += 1) items.push(...captionedLine("Signature of Client", 0.1, 0.4 + (r % 5) * 0.03, 0.07 + r * (0.86 / rows) + (r % 3) * 0.004));
      return { items };
    }),
  };
}

async function runDoc(doc: SyntheticDoc, options: Partial<Parameters<typeof autoMapDocument>[1]> = {}, signal?: AbortSignal) {
  const rendered = await renderSynthetic(doc);
  const opened = await openForAnalysis(rendered.bytes);
  try {
    return await autoMapDocument(opened.pdf, { signers: doc.signers, ops: opened.ops, ...options }, signal);
  } finally {
    await opened.close();
  }
}

describe("autoMapDocument: topes reales", () => {
  it("una pagina con 20 lineas de firma no pasa de 12 campos y avisa", async () => {
    const result = await runDoc(manyLines(1, 20));
    expect(result.confidenceSummary.maxPerPage).toBeLessThanOrEqual(12);
    expect(result.warnings.map((w) => w.code)).toContain("page-field-cap");
  });
  it("un documento de 9 paginas no pasa de 80 campos", async () => {
    const result = await runDoc(manyLines(9, 11));
    expect(result.fields.filter((f) => f.tier !== "ignore").length).toBeLessThanOrEqual(80);
    expect(result.warnings.map((w) => w.code)).toContain("document-field-cap");
  });
});

describe("autoMapDocument: contrato", () => {
  const entry = syntheticCorpus().find((e) => e.doc.name === "corner-repeat-2")!;

  it("devuelve campos, resumen por pagina, confianza y avisos", async () => {
    const result = await runDoc(entry.doc);
    expect(result.pages).toHaveLength(7);
    expect(result.pages[0]).toMatchObject({ pageIndex: 0, hasInitialsLine: true, signatureLines: 0 });
    expect(result.pages[6]).toMatchObject({ hasInitialsLine: false, signatureLines: 2 });
    const { confidenceSummary: s } = result;
    expect(s.high).toBe(result.fields.filter((f) => f.tier === "high").length);
    expect(s.review).toBe(result.fields.filter((f) => f.tier === "review").length);
    expect(s.byType.initials).toBe(12);
    expect(s.byType.signature).toBe(2);
    expect(s.meanHighConfidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    for (const f of result.fields) {
      expect(f.rect.x).toBeGreaterThanOrEqual(0);
      expect(f.rect.y).toBeGreaterThanOrEqual(0);
      expect(f.rect.x + f.rect.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(f.rect.y + f.rect.height).toBeLessThanOrEqual(1 + 1e-9);
      expect(f.reason.length).toBeGreaterThan(5);
      expect(["signature", "initials", "date", "text"]).toContain(f.type);
      expect(["high", "review"]).toContain(f.tier);
      expect(["label", "geometry", "repetition"]).toContain(f.source);
    }
  });

  it("las iniciales repetidas sin etiqueta salen de la repeticion y son `high`", async () => {
    const result = await runDoc(entry.doc);
    const initials = result.fields.filter((f) => f.type === "initials");
    expect(initials.every((f) => f.source === "repetition" && f.tier === "high")).toBe(true);
    expect(initials.filter((f) => f.pageIndex === 0).map((f) => f.signerIndex).sort()).toEqual([0, 1]);
    expect(initials.find((f) => f.pageIndex === 2 && f.signerIndex === 0)!.reason).toMatch(/repite en \d+ de \d+ páginas/);
  });

  it("con repeticion en menos del 60 % de las paginas no hay iniciales", async () => {
    const doc: SyntheticDoc = { ...entry.doc, pages: entry.doc.pages.map((p, i) => (i < 3 ? { items: p.items.filter((it) => it.t !== "hline"), truth: [] } : p)) };
    const result = await runDoc(doc);
    // 7 paginas con texto, la raya solo en 3 (+ firma): menos del 60 %
    expect(result.fields.filter((f) => f.type === "initials")).toHaveLength(0);
  });

  it("un solo firmante: una casilla de iniciales por pagina y el firmante 2 se ignora", async () => {
    const result = await runDoc(entry.doc, { signers: 1, includeIgnored: true });
    const initials = result.fields.filter((f) => f.type === "initials" && f.tier !== "ignore");
    expect(initials).toHaveLength(6);
    expect(initials.every((f) => f.signerIndex === 0)).toBe(true);
    expect(result.fields.filter((f) => f.tier === "ignore").length).toBeGreaterThan(0);
    const without = await runDoc(entry.doc, { signers: 1 });
    expect(without.fields.some((f) => f.signerIndex === 1)).toBe(false);
  });

  it("los motivos salen en el idioma pedido", async () => {
    const es = await runDoc(entry.doc, { locale: "es" });
    const en = await runDoc(entry.doc, { locale: "en" });
    expect(es.fields[0].reason).toMatch(/Raya corta|Etiqueta/);
    expect(en.fields[0].reason).toMatch(/Short line|Label/);
  });

  it("avisa cuando no encuentra nada", async () => {
    const result = await runDoc({ name: "empty", signers: 2, pages: [{ items: paragraph(0.12, 20) }] });
    expect(result.fields).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain("no-fields");
  });

  it("`maxPages` limita las paginas analizadas y avisa", async () => {
    const result = await runDoc(entry.doc, { maxPages: 2 });
    expect(result.pages).toHaveLength(2);
    expect(result.warnings.map((w) => w.code)).toContain("too-many-pages");
  });

  it("informa del progreso pagina a pagina", async () => {
    const seen: Array<[number, number]> = [];
    await runDoc(entry.doc, { onProgress: (done, total) => seen.push([done, total]) });
    expect(seen).toHaveLength(7);
    expect(seen[0]).toEqual([1, 7]);
    expect(seen[6]).toEqual([7, 7]);
  });
});

describe("autoMapDocument: cancelacion, errores y tareas largas", () => {
  const entry = syntheticCorpus().find((e) => e.doc.name === "labelled-initials-2")!;

  it("una senal ya cancelada lanza AbortError sin leer nada", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runDoc(entry.doc, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("se puede cancelar entre paginas", async () => {
    const controller = new AbortController();
    await expect(runDoc(entry.doc, { onProgress: () => controller.abort() }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("una pagina que no se puede leer no tira abajo a las demas", async () => {
    const rendered = await renderSynthetic(entry.doc);
    const opened = await openForAnalysis(rendered.bytes);
    try {
      const proxy = new Proxy(opened.pdf, {
        get(target, prop) {
          if (prop === "getPage") return (number: number) => (number === 2 ? Promise.reject(new Error("boom")) : target.getPage(number));
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const result = await autoMapDocument(proxy as PDFDocumentProxy, { signers: 2, ops: opened.ops });
      expect(result.warnings.some((w) => w.code === "page-skipped" && w.pageIndex === 1)).toBe(true);
      expect(result.fields.some((f) => f.pageIndex === 0)).toBe(true);
      expect(result.fields.some((f) => f.pageIndex === 2)).toBe(true);
    } finally {
      await opened.close();
    }
  });

  it("cede el control al hilo principal entre paginas (tareas de menos de ~30 ms)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await runDoc(entry.doc, { yieldEveryMs: 0 });
      const zeroDelay = spy.mock.calls.filter((call) => call[1] === 0 || call[1] === undefined).length;
      expect(zeroDelay).toBeGreaterThanOrEqual(entry.doc.pages.length);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("autoMapDocument: paginas escaneadas", () => {
  const scanned: SyntheticDoc = {
    name: "scan",
    signers: 2,
    pages: [
      { items: [{ t: "image", x: 0, y: 0, w: 1, h: 1 }], scanned: true },
      { items: [{ t: "image", x: 0, y: 0, w: 1, h: 1 }], scanned: true },
    ],
  };
  const W = 306;
  const H = 396;
  const pixels = (lines: Array<{ x0: number; x1: number; y: number }>) => {
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    for (const l of lines) for (let r = 0; r < 2; r += 1) for (let x = Math.round(l.x0 * W); x < Math.round(l.x1 * W); x += 1) data.fill(0, ((Math.round(l.y * H) + r) * W + x) * 4, ((Math.round(l.y * H) + r) * W + x) * 4 + 3);
    return { data, width: W, height: H };
  };

  it("sin rasterizador avisa y no inventa campos", async () => {
    const result = await runDoc(scanned);
    expect(result.fields).toHaveLength(0);
    expect(result.warnings.filter((w) => w.code === "scanned-page")).toHaveLength(2);
    expect(result.pages.every((p) => p.scanned)).toBe(true);
  });

  it("con rasterizador: solo rayas largas, confianza baja y `review`", async () => {
    const rasterizer = vi.fn(async (_page: unknown, index: number) =>
      index === 0
        ? pixels([{ x0: 0.1, x1: 0.5, y: 0.6 }, { x0: 0.1, x1: 0.5, y: 0.75 }, { x0: 0.6, x1: 0.68, y: 0.9 }, { x0: 0.1, x1: 0.5, y: 0.1 }])
        : pixels([]),
    );
    const result = await runDoc(scanned, { rasterizer });
    expect(rasterizer).toHaveBeenCalledTimes(2);
    expect(result.fields).toHaveLength(2);
    for (const f of result.fields) {
      expect(f.tier).toBe("review");
      expect(f.confidence).toBeLessThan(0.5);
      expect(f.type).toBe("signature");
      expect(f.source).toBe("geometry");
      expect(f.pageIndex).toBe(0);
    }
    expect(result.fields.map((f) => f.signerIndex)).toEqual([0, 1]);
  });
});

describe("corpus: invariantes generales", () => {
  it("los tamanos de letra y de pagina de los rotulos no cambian el numero de campos", async () => {
    const entry = syntheticCorpus().find((e) => e.doc.name === "es-single")!;
    const a = await renderSynthetic(entry.doc);
    const b = await renderSynthetic(entry.doc, { page: [595, 842], scale: 1.3, fontScale: 1.1 });
    const opened = await Promise.all([openForAnalysis(a.bytes), openForAnalysis(b.bytes)]);
    try {
      const [ra, rb] = await Promise.all(opened.map((o) => autoMapDocument(o.pdf, { signers: 1, ops: o.ops })));
      expect(rb.fields.filter((f) => f.type === "signature")).toHaveLength(ra.fields.filter((f) => f.type === "signature").length);
      expect(rb.fields.filter((f) => f.type === "initials")).toHaveLength(ra.fields.filter((f) => f.type === "initials").length);
    } finally {
      await Promise.all(opened.map((o) => o.close()));
    }
  });
  it("textWidth y FONT_FRACTION son consistentes", () => {
    expect(textWidth("abcd", FONT_FRACTION)).toBeCloseTo(4 * FONT_FRACTION * 0.52, 9);
  });
});

describe("repeticion: evidencia suficiente para `high`", () => {
  const corner = (count: number, y = 0.93): SyntheticDoc => ({
    name: "corner",
    signers: 2,
    pages: Array.from({ length: count }, (_, i) => ({ items: [...paragraph(0.12, 28, { offset: i }), { t: "hline" as const, x0: 0.74, x1: 0.87, y }] })),
  });

  it("en tres o mas paginas es `high`", async () => {
    const result = await runDoc(corner(3));
    expect(result.fields.filter((f) => f.type === "initials" && f.tier === "high")).toHaveLength(6);
  });

  it("en solo dos paginas es `review` (poca evidencia)", async () => {
    const result = await runDoc(corner(2));
    const initials = result.fields.filter((f) => f.type === "initials");
    expect(initials).toHaveLength(4);
    expect(initials.every((f) => f.tier === "review")).toBe(true);
  });

  it("en el membrete (parte alta) nunca es `high`", async () => {
    const result = await runDoc(corner(5, 0.06));
    const initials = result.fields.filter((f) => f.type === "initials");
    expect(initials.length).toBeGreaterThan(0);
    expect(initials.every((f) => f.tier === "review")).toBe(true);
  });
});
