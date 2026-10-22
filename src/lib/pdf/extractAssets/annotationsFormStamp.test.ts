import { describe, expect, it } from "vitest";
import { STAMP_MAX_AREA, STAMP_MIN_AREA, groupFormStamps, stampLikeness, toneOf, unmixStampColor, type FormStampOccurrence } from "./annotationsFormStamp";
import type { FormCandidate } from "./watermarkOps";
import type { RasterImage } from "./annotationsTypes";

const form = (over: Partial<FormCandidate> = {}): FormCandidate => ({
  beginIndex: 1,
  endIndex: 9,
  bbox: { x: 100, y: 100, width: 100, height: 100 },
  dominantColor: "#d90d0d",
  dominantShare: 1,
  curves: 4,
  lines: 0,
  paints: 2,
  hasText: true,
  text: "RECIBIDO",
  fingerprint: "P20c",
  ocIds: [],
  ...over,
});

const W = 612;
const H = 792;

describe("toneOf", () => {
  it("rojo y azul saturados si; gris, negro, verde, amarillo y pasteles no", () => {
    expect(toneOf("#d90d0d")).toBe("rojo");
    expect(toneOf("#ff0000")).toBe("rojo");
    expect(toneOf("#e0103a")).toBe("rojo"); // rojo que tira a carmesi (matiz ~ 348)
    expect(toneOf("#0d1ab2")).toBe("azul");
    expect(toneOf("#1030c0")).toBe("azul");
    for (const hex of ["#666666", "#0d0d0d", "#ffffff", "#2e9b2e", "#e6c800", "#f5b5b5", "#b5b5f5", "#220000", "#9b30d0", "#7a1fd1", "nada"]) expect(toneOf(hex), hex).toBeNull();
  });
});

describe("stampLikeness", () => {
  it("circular con texto: media confianza (<= 0,7) y razones legibles", () => {
    const result = stampLikeness(form(), W, H);
    expect(result).toMatchObject({ shape: "circular", tone: "rojo", color: "#d90d0d" });
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result?.confidence).toBeLessThanOrEqual(0.7);
    expect(result?.reasons.join(" ")).toContain("circular");
    expect(result?.reasons.join(" ")).toContain("RECIBIDO");
  });

  it("ovalado y rectangular con texto; el rectangulo sin texto es un marco, no un sello", () => {
    expect(stampLikeness(form({ bbox: { x: 0, y: 0, width: 120, height: 60 } }), W, H)?.shape).toBe("oval");
    const rect = form({ curves: 0, lines: 4, bbox: { x: 0, y: 0, width: 120, height: 60 } });
    expect(stampLikeness(rect, W, H)?.shape).toBe("rectangular");
    expect(stampLikeness({ ...rect, hasText: false, text: "" }, W, H)).toBeNull();
  });

  it("circulo sin texto si cuenta (sellos redondos graficos) pero con menos confianza", () => {
    const plain = stampLikeness(form({ hasText: false, text: "" }), W, H);
    expect(plain?.shape).toBe("circular");
    expect(plain?.confidence).toBeLessThan(stampLikeness(form(), W, H)?.confidence as number);
  });

  it("descarta por color, reparto de color, tamano y forma", () => {
    expect(stampLikeness(form({ dominantColor: "#666666" }), W, H)).toBeNull();
    expect(stampLikeness(form({ dominantColor: null }), W, H)).toBeNull();
    expect(stampLikeness(form({ dominantShare: 0.59 }), W, H)).toBeNull();
    expect(stampLikeness(form({ paints: 0 }), W, H)).toBeNull();
    expect(stampLikeness(form({ bbox: { x: 0, y: 0, width: 11, height: 11 } }), W, H)).toBeNull(); // diminuto
    expect(stampLikeness(form({ bbox: { x: 0, y: 0, width: 440, height: 440 } }), W, H)).toBeNull(); // mas del 70 % del ancho
    expect(stampLikeness(form({ curves: 0, lines: 4, bbox: { x: 0, y: 0, width: 440, height: 150 } }), W, H)).toBeNull(); // banda casi de ancho de pagina
    expect(stampLikeness(form({ curves: 0, lines: 1 }), W, H)).toBeNull(); // una raya
    expect(stampLikeness(form({ curves: 0, lines: 0 }), W, H)).toBeNull(); // solo texto
    expect(stampLikeness(form({ curves: 4, bbox: { x: 0, y: 0, width: 300, height: 50 } }), W, H)).toBeNull(); // aspecto de banda
  });

  it("los limites de area se respetan", () => {
    const area = (fraction: number) => {
      const side = Math.sqrt(fraction * W * H);
      return form({ bbox: { x: 0, y: 0, width: side, height: side } });
    };
    expect(stampLikeness(area(STAMP_MIN_AREA * 0.8), W, H)).toBeNull();
    expect(stampLikeness(area(STAMP_MIN_AREA * 3), W, H)).not.toBeNull();
    expect(stampLikeness(area(STAMP_MAX_AREA * 0.9), W, H)).not.toBeNull();
    expect(stampLikeness(area(STAMP_MAX_AREA * 1.1), W, H)).toBeNull();
  });
});

describe("unmixStampColor", () => {
  const image = (pixels: Array<[number, number, number, number]>): RasterImage => ({ width: pixels.length, height: 1, data: Uint8ClampedArray.from(pixels.flat()) });

  it("el color del sello se queda con su alfa; lo transparente sigue transparente", () => {
    const out = unmixStampColor(image([[217, 13, 13, 255], [0, 0, 0, 0]]), "#d90d0d");
    expect([...out.data.subarray(0, 4)]).toEqual([217, 13, 13, 255]);
    expect(out.data[7]).toBe(0);
  });

  it("un trazo antialias del color del sello conserva el color y baja el alfa", () => {
    const out = unmixStampColor(image([[217, 13, 13, 128]]), "#d90d0d");
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([217, 13, 13]);
    expect(Math.abs(out.data[3] - 128)).toBeLessThanOrEqual(4);
  });

  it("quita el texto negro, el gris translucido y otras tintas que hay debajo", () => {
    const out = unmixStampColor(image([[0, 0, 0, 255], [128, 128, 128, 46], [20, 40, 200, 255], [217, 13, 13, 255]]), "#d90d0d");
    expect(out.data[3]).toBe(0); // negro
    expect(out.data[7]).toBe(0); // gris translucido (el caso del texto de marca de agua bajo el sello)
    expect(out.data[11]).toBe(0); // azul
    expect(out.data[15]).toBe(255); // el rojo del sello
  });

  it("un color casi blanco no se puede separar del papel: queda vacio", () => {
    const out = unmixStampColor(image([[250, 250, 250, 255]]), "#fafafa");
    expect(out.data.every((v) => v === 0)).toBe(true);
  });
});

describe("groupFormStamps", () => {
  const occurrence = (pageIndex: number, over: Partial<FormCandidate> = {}): FormStampOccurrence => {
    const f = form(over);
    return { env: { pageIndex } as never, form: f, likeness: stampLikeness(f, W, H) as never };
  };

  it("agrupa el mismo sello (huella, color y tamano) de varias paginas y separa los distintos", () => {
    const groups = groupFormStamps([occurrence(0), occurrence(1), occurrence(2, { fingerprint: "otro" }), occurrence(3, { dominantColor: "#0d1ab2" }), occurrence(4, { bbox: { x: 0, y: 0, width: 150, height: 150 } })]);
    expect(groups.map((g) => g.map((o) => o.env.pageIndex))).toEqual([[0, 1], [2], [3], [4]]);
  });

  it("tolera diferencias de 1-2 pt de tamano entre paginas", () => {
    const groups = groupFormStamps([occurrence(0), occurrence(1, { bbox: { x: 100, y: 100, width: 100.9, height: 99.4 } })]);
    expect(groups).toHaveLength(1);
  });
});
