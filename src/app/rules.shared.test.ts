import { describe, expect, it } from "vitest";
import { watermarkCanRun } from "@/app/add-watermark/watermarkRules";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { cropCanRun, CROP_MIN_FRACTION } from "@/app/crop-pdf/cropRules";
import { CROP_STRINGS } from "@/app/crop-pdf/strings";
import { protectCanRun } from "@/app/protect-pdf/protectRules";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { rotateAllPlan, rotateRangePlan } from "@/app/rotate-pdf/rotatePlan";
import { DEFAULT_WATERMARK_OPTIONS } from "@/lib/pdf/watermark";

/** Reglas «se puede aplicar» y planes COMPARTIDOS entre las herramientas sueltas y PDF Pro (U5). */

describe("watermarkCanRun", () => {
  const s = WATERMARK_STRINGS.es;
  it("texto vacio o solo espacios: motivo", () => {
    expect(watermarkCanRun({ ...DEFAULT_WATERMARK_OPTIONS, text: "" }, s)).toEqual({ ok: false, reason: s.textRequired });
    expect(watermarkCanRun({ ...DEFAULT_WATERMARK_OPTIONS, text: "   " }, s)).toEqual({ ok: false, reason: s.textRequired });
  });
  it("texto valido: ok", () => {
    expect(watermarkCanRun({ ...DEFAULT_WATERMARK_OPTIONS, text: "BORRADOR" }, s)).toEqual({ ok: true });
  });
  it("imagen sin archivo: motivo; con archivo: ok", () => {
    expect(watermarkCanRun({ ...DEFAULT_WATERMARK_OPTIONS, kind: "image" }, s)).toEqual({ ok: false, reason: s.imageRequired });
    const image = new File([new Uint8Array(2)], "a.png", { type: "image/png" });
    expect(watermarkCanRun({ ...DEFAULT_WATERMARK_OPTIONS, kind: "image", image }, s)).toEqual({ ok: true });
  });
  it("el motivo sale en el idioma pedido", () => {
    const en = watermarkCanRun({ ...DEFAULT_WATERMARK_OPTIONS, text: "" }, WATERMARK_STRINGS.en);
    expect(en).toEqual({ ok: false, reason: WATERMARK_STRINGS.en.textRequired });
  });
});

describe("cropCanRun", () => {
  const s = CROP_STRINGS.es;
  const rect = (width: number, height: number) => ({ rect: { x: 0, y: 0, width, height } });
  it("la fraccion minima es el 3 %", () => expect(CROP_MIN_FRACTION).toBe(0.03));
  it("menos del 3 % de ancho o de alto: motivo", () => {
    expect(cropCanRun(rect(0.02, 0.5), s)).toEqual({ ok: false, reason: s.selectionTooSmall });
    expect(cropCanRun(rect(0.5, 0.029), s).ok).toBe(false);
  });
  it("justo el 3 % o mas: ok", () => {
    expect(cropCanRun(rect(0.03, 0.03), s)).toEqual({ ok: true });
    expect(cropCanRun(rect(1, 1), s)).toEqual({ ok: true });
  });
});

describe("protectCanRun", () => {
  const s = PROTECT_STRINGS.es;
  const o = (patch: object) => ({ password: "secreto1", confirm: "secreto1", ...patch });
  it("vacia / corta / sin repetir / distinta", () => {
    expect(protectCanRun(o({ password: "", confirm: "" }), s)).toEqual({ ok: false, reason: s.errors.empty });
    expect(protectCanRun(o({ password: "abc", confirm: "abc" }), s)).toEqual({ ok: false, reason: s.errors.tooShort });
    expect(protectCanRun(o({ confirm: "" }), s)).toEqual({ ok: false, reason: s.confirmRequired });
    expect(protectCanRun(o({ confirm: "otra" }), s)).toEqual({ ok: false, reason: s.errors.mismatch });
  });
  it("senala los caracteres fuera de Latin-1 por su nombre, sin repetirlos", () => {
    expect(protectCanRun(o({ password: "a€b€c€d", confirm: "a€b€c€d" }), s)).toEqual({
      ok: false,
      reason: s.errors.unsupportedChars.replace("{chars}", "€"),
    });
    expect(protectCanRun(o({ password: "xx😀密yy", confirm: "xx😀密yy" }), s)).toEqual({
      ok: false,
      reason: s.errors.unsupportedChars.replace("{chars}", "😀 密"),
    });
  });
  it("sin nada que cifrar: motivo; con un permiso restringido: ok", () => {
    expect(protectCanRun(o({ requirePasswordToOpen: false }), s)).toEqual({ ok: false, reason: s.errors.nothingToDo });
    expect(protectCanRun(o({ requirePasswordToOpen: false, allowPrinting: false }), s)).toEqual({ ok: true });
  });
  it("contraseña valida: ok", () => {
    expect(protectCanRun(o({}), s)).toEqual({ ok: true });
  });
});

describe("planes de giro", () => {
  it("rotateAllPlan normaliza el angulo", () => {
    expect(rotateAllPlan(90)).toEqual({ base: 90 });
    expect(rotateAllPlan(450)).toEqual({ base: 90 });
    expect(rotateAllPlan(-90)).toEqual({ base: 270 });
    expect(rotateAllPlan(Number.NaN)).toEqual({ base: 0 });
  });
  it("rotateRangePlan marca solo el rango", () => {
    expect(rotateRangePlan({ angle: 90, fromPage: 2, toPage: 4 }, 6)).toEqual({ base: 0, byPage: { 2: 90, 3: 90, 4: 90 } });
  });
  it("«hasta 0» llega al final y «desde» se acota", () => {
    expect(rotateRangePlan({ angle: 180, fromPage: 4, toPage: 0 }, 5)).toEqual({ base: 0, byPage: { 4: 180, 5: 180 } });
    expect(rotateRangePlan({ angle: 90, fromPage: 0, toPage: 2 }, 3)).toEqual({ base: 0, byPage: { 1: 90, 2: 90 } });
  });
  it("paridad: impares y pares dentro del rango", () => {
    expect(Object.keys(rotateRangePlan({ angle: 90, fromPage: 1, toPage: 6, parity: "odd" }, 6).byPage ?? {})).toEqual(["1", "3", "5"]);
    expect(Object.keys(rotateRangePlan({ angle: 90, fromPage: 1, toPage: 6, parity: "even" }, 6).byPage ?? {})).toEqual(["2", "4", "6"]);
  });
  it("un rango sin ninguna pagina que cumpla la paridad queda vacio", () => {
    expect(rotateRangePlan({ angle: 90, fromPage: 2, toPage: 2, parity: "odd" }, 4).byPage).toEqual({});
  });
});
