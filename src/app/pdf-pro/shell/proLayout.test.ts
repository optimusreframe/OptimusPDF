import { describe, expect, it } from "vitest";
import {
  CONTEXT_WIDTH,
  DEFAULT_LAYOUT_PREFS,
  MIN_VIEWER_WIDTH,
  THUMBS_WIDTH,
  clampContextWidth,
  clampThumbsWidth,
  fitPanels,
  loadLayoutPrefs,
  parseLayoutPrefs,
  saveLayoutPrefs,
  type ProLayoutPrefs,
} from "@/app/pdf-pro/shell/proLayout";

const prefs = (patch: Partial<ProLayoutPrefs> = {}): ProLayoutPrefs => ({ ...DEFAULT_LAYOUT_PREFS, ...patch });

describe("limites de ancho", () => {
  it("las miniaturas se acotan a su rango y lo no numerico vuelve al valor por defecto", () => {
    expect(clampThumbsWidth(10)).toBe(THUMBS_WIDTH.min);
    expect(clampThumbsWidth(9999)).toBe(THUMBS_WIDTH.max);
    expect(clampThumbsWidth(200.4)).toBe(200);
    expect(clampThumbsWidth(Number.NaN)).toBe(THUMBS_WIDTH.def);
  });

  it("el panel de herramienta se acota a su rango", () => {
    expect(clampContextWidth(10)).toBe(CONTEXT_WIDTH.min);
    expect(clampContextWidth(9999)).toBe(CONTEXT_WIDTH.max);
    expect(clampContextWidth(Number.POSITIVE_INFINITY)).toBe(CONTEXT_WIDTH.def);
  });
});

describe("parseLayoutPrefs (lo leido del navegador no es de fiar)", () => {
  it("acepta preferencias validas", () => {
    expect(parseLayoutPrefs({ thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true })).toEqual({
      thumbsWidth: 200,
      contextWidth: 400,
      thumbsOpen: false,
      contextOpen: true,
    });
  });

  it("cualquier cosa que no sea un objeto da los valores por defecto", () => {
    for (const bad of [null, undefined, 5, "x", [], true]) {
      expect(parseLayoutPrefs(bad)).toEqual(DEFAULT_LAYOUT_PREFS);
    }
  });

  it("campos con el tipo equivocado vuelven a su valor por defecto uno a uno", () => {
    expect(parseLayoutPrefs({ thumbsWidth: "ancho", contextWidth: 400, thumbsOpen: "si", contextOpen: false })).toEqual({
      thumbsWidth: THUMBS_WIDTH.def,
      contextWidth: 400,
      thumbsOpen: true,
      contextOpen: false,
    });
  });

  it("los anchos fuera de rango se acotan", () => {
    const parsed = parseLayoutPrefs({ thumbsWidth: 5, contextWidth: 99999 });
    expect(parsed.thumbsWidth).toBe(THUMBS_WIDTH.min);
    expect(parsed.contextWidth).toBe(CONTEXT_WIDTH.max);
  });
});

describe("almacenamiento sin navegador", () => {
  it("leer sin window da los valores por defecto (sin lanzar)", () => {
    expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
  });

  it("guardar sin window no lanza", () => {
    expect(() => saveLayoutPrefs(DEFAULT_LAYOUT_PREFS)).not.toThrow();
  });
});

describe("fitPanels: reparto del ancho", () => {
  it("con sitio de sobra se respetan los dos anchos", () => {
    const fitted = fitPanels(1600, prefs());
    expect(fitted).toMatchObject({
      thumbsWidth: THUMBS_WIDTH.def,
      contextWidth: CONTEXT_WIDTH.def,
      showThumbs: true,
      showContext: true,
      contextAutoHidden: false,
      thumbsAutoHidden: false,
    });
  });

  it("sin medir (ancho 0) no se recorta nada", () => {
    const fitted = fitPanels(0, prefs());
    expect(fitted.showThumbs).toBe(true);
    expect(fitted.showContext).toBe(true);
    expect(fitted.contextWidth).toBe(CONTEXT_WIDTH.def);
  });

  it("el visor conserva su ancho minimo: primero se estrecha el panel de herramienta", () => {
    const width = THUMBS_WIDTH.def + 300 + MIN_VIEWER_WIDTH + 12;
    const fitted = fitPanels(width, prefs({ contextWidth: 500 }));
    expect(fitted.thumbsWidth).toBe(THUMBS_WIDTH.def);
    expect(fitted.contextWidth).toBeLessThan(500);
    expect(fitted.contextWidth).toBeGreaterThanOrEqual(CONTEXT_WIDTH.min);
    expect(width - fitted.thumbsWidth - fitted.contextWidth).toBeGreaterThanOrEqual(MIN_VIEWER_WIDTH);
  });

  it("si aun no cabe se estrechan las miniaturas hasta su minimo", () => {
    const width = THUMBS_WIDTH.min + CONTEXT_WIDTH.min + MIN_VIEWER_WIDTH + 12;
    const fitted = fitPanels(width, prefs({ thumbsWidth: 280, contextWidth: 560 }));
    expect(fitted.thumbsWidth).toBe(THUMBS_WIDTH.min);
    expect(fitted.contextWidth).toBe(CONTEXT_WIDTH.min);
    expect(fitted.showContext).toBe(true);
  });

  it("si ni con los minimos cabe, se pliega solo el panel de herramienta y se recuerda por que", () => {
    const fitted = fitPanels(700, prefs());
    expect(fitted.showContext).toBe(false);
    expect(fitted.contextAutoHidden).toBe(true);
    expect(fitted.showThumbs).toBe(true);
    expect(700 - fitted.thumbsWidth).toBeGreaterThanOrEqual(MIN_VIEWER_WIDTH);
  });

  it("en un ancho muy estrecho se pliegan los dos", () => {
    const fitted = fitPanels(400, prefs());
    expect(fitted.showContext).toBe(false);
    expect(fitted.showThumbs).toBe(false);
    expect(fitted.thumbsAutoHidden).toBe(true);
  });

  it("un panel cerrado por el usuario no cuenta como plegado automaticamente", () => {
    const fitted = fitPanels(1600, prefs({ contextOpen: false, thumbsOpen: false }));
    expect(fitted.showContext).toBe(false);
    expect(fitted.showThumbs).toBe(false);
    expect(fitted.contextAutoHidden).toBe(false);
    expect(fitted.thumbsAutoHidden).toBe(false);
  });

  it("con las miniaturas cerradas el panel de herramienta tiene mas sitio", () => {
    const width = 900;
    const both = fitPanels(width, prefs());
    const only = fitPanels(width, prefs({ thumbsOpen: false }));
    expect(only.contextWidth).toBeGreaterThanOrEqual(both.contextWidth);
    expect(only.showThumbs).toBe(false);
  });

  it("nunca deja menos de MIN_VIEWER_WIDTH al visor en ningun ancho", () => {
    for (let width = 320; width <= 2400; width += 37) {
      const fitted = fitPanels(width, prefs({ thumbsWidth: 280, contextWidth: 560 }));
      const used = (fitted.showThumbs ? fitted.thumbsWidth : 0) + (fitted.showContext ? fitted.contextWidth : 0);
      expect(width - used, `ancho ${width}`).toBeGreaterThanOrEqual(Math.min(width, MIN_VIEWER_WIDTH));
    }
  });
});
