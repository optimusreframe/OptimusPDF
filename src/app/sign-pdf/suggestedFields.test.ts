import { describe, expect, it } from "vitest";
import { isSuggestedField, isSuggestionOnly, type DetectedField } from "@/lib/pdf/detectFields";
import { isPendingElsewhere, pendingCount, findPendingInOtherDocs } from "@/app/sign-pdf/sequenceMath";
import { EMPTY_DOC_STATE } from "@/app/sign-pdf/docSet";

/** Las sugerencias de la heuristica no son campos del documento hasta que alguien las toca (W6-A). */

function field(id: string, source: DetectedField["source"], rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.03 }): DetectedField {
  return { id, pageIndex: 0, rect, source, confidence: source === "heuristic-raster" ? "low" : "medium" };
}

describe("isSuggestedField / isSuggestionOnly", () => {
  it("solo las heuristicas (vectorial y raster) son sugerencias", () => {
    expect(isSuggestedField(field("a", "heuristic-vector"))).toBe(true);
    expect(isSuggestedField(field("a", "heuristic-raster"))).toBe(true);
    expect(isSuggestedField(field("a", "acroform"))).toBe(false);
    expect(isSuggestedField(field("a", "manual"))).toBe(false);
  });

  it("una sugerencia con valor ya no es «solo sugerencia»", () => {
    const f = field("a", "heuristic-vector");
    expect(isSuggestionOnly(f, undefined)).toBe(true);
    expect(isSuggestionOnly(f, "")).toBe(true);
    expect(isSuggestionOnly(f, "   ")).toBe(true);
    expect(isSuggestionOnly(f, "Ana")).toBe(false);
  });

  it("un campo real o manual nunca es «solo sugerencia», este vacio o no", () => {
    expect(isSuggestionOnly(field("a", "acroform"), "")).toBe(false);
    expect(isSuggestionOnly(field("a", "manual"), "")).toBe(false);
  });
});

describe("la navegacion entre documentos ignora las sugerencias", () => {
  const real = field("real", "acroform");
  const sug = field("sug", "heuristic-vector", { x: 0.1, y: 0.5, width: 0.3, height: 0.03 });

  it("una sugerencia sin tocar no es un campo pendiente", () => {
    expect(isPendingElsewhere(sug, {})).toBe(false);
    expect(isPendingElsewhere(real, {})).toBe(true);
  });

  it("una sugerencia con valor tampoco (ya esta rellena)", () => {
    expect(isPendingElsewhere(sug, { sug: "Ana" })).toBe(false);
  });

  it("pendingCount solo cuenta los campos reales sin rellenar", () => {
    expect(pendingCount({ textFields: [real, sug], textValues: {} })).toBe(1);
    expect(pendingCount({ textFields: [sug, field("s2", "heuristic-raster")], textValues: {} })).toBe(0);
  });

  it("«siguiente campo pendiente» no salta a un documento que solo tiene sugerencias", () => {
    const docs = {
      a: { ...EMPTY_DOC_STATE, textFields: [real] },
      b: { ...EMPTY_DOC_STATE, textFields: [sug, field("s2", "heuristic-vector")] },
      c: { ...EMPTY_DOC_STATE, textFields: [field("r3", "acroform")] },
    };
    const target = findPendingInOtherDocs(["a", "b", "c"], docs, "a", 1);
    expect(target?.docId).toBe("c");
  });
});
