import { describe, expect, it } from "vitest";
import { appearanceLooksLikeText, isSigWidget } from "./annotationsSig";
import type { AppearanceInfo, PdfLibAnnotation } from "./annotationsPdfLib";

const lib = (appearance: Partial<AppearanceInfo>): PdfLibAnnotation => ({
  pageIndex: 0,
  objectNumber: 1,
  subtype: "Widget",
  fieldType: "Sig",
  hasValue: true,
  appearance: { present: true, empty: false, hasText: false, hasPaths: false, pathSegments: 0, hasImage: false, ...appearance },
});

describe("appearanceLooksLikeText", () => {
  it("texto con un marco sencillo es texto", () => {
    expect(appearanceLooksLikeText(lib({ hasText: true, pathSegments: 1 }))).toBe(true);
    expect(appearanceLooksLikeText(lib({ hasText: true, pathSegments: 8 }))).toBe(true);
  });

  it("texto MAS una firma dibujada (muchos trazos) o con imagen no es solo texto", () => {
    expect(appearanceLooksLikeText(lib({ hasText: true, pathSegments: 60, hasPaths: true }))).toBe(false);
    expect(appearanceLooksLikeText(lib({ hasText: true, hasImage: true }))).toBe(false);
  });

  it("sin texto, sin apariencia o sin lectura de pdf-lib: no es texto", () => {
    expect(appearanceLooksLikeText(lib({ hasPaths: true, pathSegments: 40 }))).toBe(false);
    expect(appearanceLooksLikeText(lib({ present: false, hasText: true }))).toBe(false);
    expect(appearanceLooksLikeText(undefined)).toBe(false);
  });
});

describe("isSigWidget", () => {
  it("solo los widgets de firma", () => {
    expect(isSigWidget({ subtype: "Widget", fieldType: "Sig" })).toBe(true);
    expect(isSigWidget({ subtype: "Widget", fieldType: "Tx" })).toBe(false);
    expect(isSigWidget({ subtype: "Stamp", fieldType: "Sig" })).toBe(false);
    expect(isSigWidget({})).toBe(false);
  });
});
