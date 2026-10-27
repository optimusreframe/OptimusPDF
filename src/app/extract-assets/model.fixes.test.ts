import { describe, expect, it } from "vitest";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import type { ExtractResult, ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import {
  assetLabel,
  choiceFileName,
  choiceOptions,
  hasNothingToExtract,
  needsClean,
  noticesFor,
  offersOriginal,
  ordinalsFor,
  resolveChoice,
  splitExtractable,
} from "@/app/extract-assets/model";
import { makeAsset } from "@/app/extract-assets/testUtils";

/** Correcciones de la verificacion independiente en la logica pura de la herramienta: H4, H8, H9 y H10. */

const x = es.extract;
const xe = en.extract;

describe("H9 · dos firmas de la misma pagina con el mismo nombre accesible llevan ordinal", () => {
  const a = makeAsset({ id: "a", kind: "signature", confidence: 0.85, occurrences: [{ pageIndex: 2, rect: { x: 0.1, y: 0.4, width: 0.3, height: 0.07 } }] });
  const b = makeAsset({ id: "b", kind: "signature", confidence: 0.85, occurrences: [{ pageIndex: 2, rect: { x: 0.5, y: 0.4, width: 0.3, height: 0.07 } }] });
  const c = makeAsset({ id: "c", kind: "signature", confidence: 0.85, occurrences: [{ pageIndex: 3, rect: { x: 0.1, y: 0.4, width: 0.3, height: 0.07 } }] });

  it("«Firma probable 1 de 2, página 3, 420 × 140 px» y «... 2 de 2 ...»", () => {
    const ordinals = ordinalsFor(x, [a, b, c]);
    expect(ordinals.get("a")).toEqual({ n: 1, total: 2 });
    expect(ordinals.get("b")).toEqual({ n: 2, total: 2 });
    expect(assetLabel(x, a, ordinals.get("a"))).toBe("Firma probable 1 de 2, página 3, 420 × 140 px");
    expect(assetLabel(x, b, ordinals.get("b"))).toBe("Firma probable 2 de 2, página 3, 420 × 140 px");
    expect(assetLabel(en.extract, a, ordinals.get("a"))).toBe("Probable signature 1 of 2, page 3, 420 × 140 px");
  });
  it("lo que ya tiene nombre unico no lleva ordinal (otra pagina, otro tamano, otro tipo)", () => {
    const ordinals = ordinalsFor(x, [a, b, c, makeAsset({ id: "d", kind: "signature", confidence: 0.85, pixel: { width: 500, height: 100, hasAlpha: true } }), makeAsset({ id: "e", kind: "initials", confidence: 0.85 })]);
    expect(ordinals.has("c")).toBe(false);
    expect(ordinals.has("d")).toBe(false);
    expect(ordinals.has("e")).toBe(false);
    expect(assetLabel(x, c)).toBe("Firma probable, página 4, 420 × 140 px");
  });
  it("tres iguales: 1, 2 y 3 de 3, en el orden dado; sin elementos, un mapa vacio", () => {
    const three = [a, b, makeAsset({ id: "f", kind: "signature", confidence: 0.85, occurrences: [{ pageIndex: 2, rect: { x: 0.2, y: 0.8, width: 0.3, height: 0.07 } }] })];
    const ordinals = ordinalsFor(x, three);
    expect([...ordinals.values()].map((o) => `${o.n}/${o.total}`)).toEqual(["1/3", "2/3", "3/3"]);
    expect(ordinalsFor(x, []).size).toBe(0);
  });
});

describe("H4 · un campo de firma sin nada que extraer no es una tarjeta", () => {
  const empty = makeAsset({ id: "field", kind: "signature", confidence: 0.1, source: "sig-widget", pixel: null, formats: [], bytesEstimate: 0 });
  const real = makeAsset({ id: "real" });
  it("sin formatos = nada que extraer; se aparta de lo que se ofrece", () => {
    expect(hasNothingToExtract(empty)).toBe(true);
    expect(hasNothingToExtract(real)).toBe(false);
    const split = splitExtractable([real, empty]);
    expect(split.usable.map((asset) => asset.id)).toEqual(["real"]);
    expect(split.empty.map((asset) => asset.id)).toEqual(["field"]);
  });
  it("se avisa en UNA linea, en singular y en plural, en los dos idiomas", () => {
    const result = (assets: ExtractedAsset[]): ExtractResult => ({ pageCount: 3, assets, scannedPages: [], warnings: [], truncated: false });
    const one = noticesFor(x, result([real, empty]), { from: 1, to: 3 }).find((notice) => notice.code === "empty-sig-field");
    expect(one?.text).toBe("Hay 1 campo de firma sin firma dentro (vacío o sin apariencia visible): no hay nada que extraer.");
    const many = noticesFor(x, result([empty, { ...empty, id: "field-2" }]), { from: 1, to: 3 }).find((notice) => notice.code === "empty-sig-field");
    expect(many?.text).toBe("Hay 2 campos de firma sin firma dentro (vacíos o sin apariencia visible): no hay nada que extraer.");
    expect(noticesFor(xe, result([empty]), { from: 1, to: 3 })[0].text).toContain("There is 1 signature field");
    expect(noticesFor(x, result([real]), { from: 1, to: 3 }).some((notice) => notice.code === "empty-sig-field")).toBe(false);
  });
});

describe("H10 · el recorte a 300 anotaciones por pagina se avisa", () => {
  it("aviso `too-many-annotations` con la pagina, cuantas trae y el tope, en ES y EN", () => {
    const result: ExtractResult = { pageCount: 2, assets: [], scannedPages: [], warnings: [{ code: "too-many-annotations", pageIndex: 1, detail: "10000" }], truncated: true };
    const notice = noticesFor(x, result, { from: 1, to: 2 }).find((entry) => entry.code === "too-many-annotations");
    expect(notice?.text).toBe("La página 2 tiene 10000 anotaciones: solo se revisaron las primeras 300. Puede haber más elementos.");
    expect(noticesFor(xe, result, { from: 1, to: 2 })[0].text).toBe("Page 2 has 10000 annotations: only the first 300 were checked. There may be more items.");
  });
});

describe("H8 · la descarga de una firma o iniciales sale LIMPIA; «Original» es la imagen incrustada", () => {
  const signature = makeAsset({ id: "s", kind: "signature", formats: ["png"] });
  const jpegSignature = makeAsset({ id: "j", kind: "signature", pixel: { width: 480, height: 150, hasAlpha: false }, formats: ["png", "jpg-original"] });
  const initials = makeAsset({ id: "i", kind: "initials" });
  const logo = makeAsset({ id: "l", kind: "logo" });
  const ink = makeAsset({ id: "k", kind: "signature", source: "ink-annot", formats: ["png"] });
  const vector = makeAsset({ id: "v", kind: "signature", source: "vector", formats: ["png", "svg"], ref: { engine: "vector", pageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 } } });

  it("solo las firmas e iniciales que salen de una imagen incrustada se limpian", () => {
    expect([signature, jpegSignature, initials].map(needsClean)).toEqual([true, true, true]);
    expect([logo, ink, vector, makeAsset({ id: "x", kind: "signature", pixel: null, formats: [] })].map(needsClean)).toEqual([false, false, false, false]);
    expect(needsClean(makeAsset({ id: "m", kind: "initials", source: "mask" }))).toBe(true);
    expect(needsClean(makeAsset({ id: "n", kind: "initials", source: "inline" }))).toBe(true);
    expect(needsClean(makeAsset({ id: "o", kind: "initials", source: "form" }))).toBe(false);
  });
  it("«PNG» entrega la firma limpia; «Original» el JPG original si lo hay y si no el PNG tal cual", () => {
    expect(resolveChoice(signature, "png")).toEqual({ format: "png", clean: true });
    expect(resolveChoice(signature, "original")).toEqual({ format: "png", clean: false });
    expect(resolveChoice(jpegSignature, "original")).toEqual({ format: "jpg-original", clean: false });
    expect(resolveChoice(jpegSignature, "png")).toEqual({ format: "png", clean: true });
  });
  it("las demas clases conservan el original (no se limpian nunca)", () => {
    expect(resolveChoice(logo, "png")).toEqual({ format: "png", clean: false });
    expect(resolveChoice(ink, "png")).toEqual({ format: "png", clean: false });
    expect(resolveChoice(vector, "original")).toEqual({ format: "svg", clean: false });
    expect(resolveChoice(makeAsset({ id: "w", kind: "watermark", formats: ["txt", "svg"], pixel: null, source: "text" }), "original")).toEqual({ format: "txt", clean: false });
  });
  it("detalle: el PNG limpio primero y «Original (imagen tal cual)» claramente rotulado", () => {
    expect(choiceOptions(signature).map((option) => [option.id, option.choice, option.label])).toEqual([
      ["clean", { format: "png", clean: true }, "formatPngCleanName"],
      ["original", { format: "png", clean: false }, "formatOriginalImageName"],
    ]);
    expect(choiceOptions(jpegSignature).map((option) => [option.id, option.choice.format, option.choice.clean])).toEqual([
      ["clean", "png", true],
      ["jpg-original", "jpg-original", false],
    ]);
    expect(es.extract.formatPngCleanName).toBe("PNG limpio (fondo transparente)");
    expect(es.extract.formatOriginalImageName).toBe("Original (imagen tal cual)");
    expect(en.extract.formatPngCleanName).toBe("Clean PNG (transparent background)");
    expect(en.extract.formatOriginalImageName).toBe("Original (image as is)");
  });
  it("las demas clases siguen mostrando sus formatos de siempre", () => {
    expect(choiceOptions(logo).map((option) => option.id)).toEqual(["png"]);
    expect(choiceOptions(vector).map((option) => option.id)).toEqual(["png", "svg"]);
    expect(choiceOptions(vector).every((option) => !option.choice.clean)).toBe(true);
  });
  it("«Original» se ofrece tambien cuando solo hay firmas limpiables (aunque todo sea PNG)", () => {
    expect(offersOriginal([signature])).toBe(true);
    expect(offersOriginal([logo])).toBe(false);
    expect(offersOriginal([logo, makeAsset({ id: "p", formats: ["png", "jpg"] })])).toBe(true);
  });
  it("nombre del archivo: el PNG limpio es `p03-firma-01.png`; el PNG sin limpiar de una firma lleva `-original`", () => {
    expect(choiceFileName("p03-firma-01", signature, { format: "png", clean: true })).toBe("p03-firma-01.png");
    expect(choiceFileName("p03-firma-01", signature, { format: "png", clean: false })).toBe("p03-firma-01-original.png");
    expect(choiceFileName("p03-firma-01", jpegSignature, { format: "jpg-original", clean: false })).toBe("p03-firma-01.jpg");
    expect(choiceFileName("p01-logo-01", logo, { format: "png", clean: false })).toBe("p01-logo-01.png");
  });
});
