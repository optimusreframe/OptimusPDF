import { describe, expect, it } from "vitest";
import { runOperation } from "@/app/pdf-pro/proAdapter";
import { PRO_OPERATIONS, getProOperation } from "@/app/pdf-pro/proOperations";
import { PRO_STRINGS, proOperationLabel } from "@/app/pdf-pro/proStrings";
import { pagesApplyOperation, type PagesApplyReport } from "@/app/pdf-pro/pages/pagesOperation";
import type { PageEntry } from "@/lib/pdf/pageAssembly";
import { inspectPdf, makeRichPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";

const existing = (sourceIndex: number, rotation = 0): PageEntry => ({ kind: "existing", sourceIndex, rotation });

describe("operacion «Aplicar» del organizador de paginas", () => {
  it("es una operacion de tipo `pages` con id estable y esta registrada", () => {
    expect(pagesApplyOperation).toMatchObject({ id: "pages-apply", kind: "pages", labelKey: "pagesApply" });
    expect(getProOperation("pages-apply")).toBe(PRO_OPERATIONS.find((operation) => operation.id === "pages-apply"));
    expect(PRO_OPERATIONS.map((operation) => operation.id)).toContain("pages-apply");
  });

  it("tiene etiqueta en los dos idiomas", () => {
    expect(proOperationLabel("es", "pagesApply")).toBe(PRO_STRINGS.es.operations.pagesApply);
    expect(proOperationLabel("en", "pagesApply")).toBe(PRO_STRINGS.en.operations.pagesApply);
    expect(PRO_STRINGS.es.operations.pagesApply).not.toBe(PRO_STRINGS.en.operations.pagesApply);
  });

  it("aplica el plan por el adaptador y devuelve bytes, numero de paginas y avisos del motor", async () => {
    const bytes = await makeRichPdf({ pages: 5, outline: true });
    const outcome = await runOperation(pagesApplyOperation, bytes, { plan: [existing(4), existing(0, 90)], externals: {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pageCount).toBe(2);
    const report = outcome.report as PagesApplyReport;
    expect(report.pageCount).toBe(2);
    expect(report.warnings.map((w) => w.code)).toContain("outlinesRemoved");
    const info = await inspectPdf(outcome.bytes);
    expect(info.rotations).toEqual([0, 90]);
  });

  it("un plan invalido sale como error tipado (no como excepcion)", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const outcome = await runOperation(pagesApplyOperation, bytes, { plan: [existing(9)], externals: {} });
    expect(outcome).toMatchObject({ ok: false, cancelled: false, code: "invalidConfig" });
  });

  it("un plan vacio es `empty`", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const outcome = await runOperation(pagesApplyOperation, bytes, { plan: [], externals: {} });
    expect(outcome).toMatchObject({ ok: false, code: "empty" });
  });

  it("cancelar antes de empezar devuelve `cancelled` sin ejecutar", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    const controller = new AbortController();
    controller.abort();
    const outcome = await runOperation(pagesApplyOperation, bytes, { plan: [existing(0)], externals: {} }, { signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, cancelled: true });
  });

  it("cancelar durante la operacion devuelve `cancelled` y el resultado tardio se ignora", async () => {
    const bytes = await makeRichPdf({ pages: 60, form: true });
    const controller = new AbortController();
    const plan = Array.from({ length: 60 }, (_, i) => existing(59 - i));
    const pending = runOperation(pagesApplyOperation, bytes, { plan, externals: {} }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
  });

  it("el progreso llega acotado de 0 a 1", async () => {
    const bytes = await makeRichPdf({ pages: 4 });
    const values: number[] = [];
    await runOperation(pagesApplyOperation, bytes, { plan: [existing(3), existing(1)], externals: {} }, { onProgress: (v) => values.push(v) });
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(values[values.length - 1]).toBe(1);
  });
});
