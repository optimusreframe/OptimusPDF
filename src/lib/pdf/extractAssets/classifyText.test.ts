import { describe, expect, it } from "vitest";
import { LEADING, buildTextLines, findLabels, labelReason, labelsByPage, nearestLabel, type RawTextPiece } from "./classifyText";
import { label, line, page } from "./classify.testUtils";

/** Texto cercano: lineas, etiquetas de firma e iniciales (ES/EN) y la regla de «a <= 2 lineas». */

const piece = (text: string, left: number, right: number, baseline: number, height = 10): RawTextPiece => ({ text, raw: text, left, right, baseline, height });

describe("buildTextLines", () => {
  it("une los trozos de una misma linea (misma base, hueco corto) con un espacio si hace falta", () => {
    const lines = buildTextLines([piece("Firma", 72, 100, 700), piece("del", 104, 120, 700), piece("Asegurado:", 124, 190, 700)], 792);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Firma del Asegurado:");
    expect(lines[0].x).toBe(72);
    expect(lines[0].width).toBe(118);
  });

  it("convierte al origen ARRIBA-izquierda (y = alto - base - 0,85 x cuerpo)", () => {
    const [first] = buildTextLines([piece("Hola", 50, 80, 700, 10)], 792);
    expect(first.y).toBeCloseTo(792 - 700 - 8.5, 5);
    expect(first.height).toBe(10);
  });

  it("separa lineas con distinta base y trozos con un hueco enorme", () => {
    const lines = buildTextLines([piece("Uno", 72, 90, 700), piece("Dos", 72, 90, 680), piece("Lejos", 300, 330, 700)], 792);
    expect(lines.map((l) => l.text).sort()).toEqual(["Dos", "Lejos", "Uno"]);
  });

  it("ignora texto vacio y no mezcla alturas muy distintas en la misma base", () => {
    const lines = buildTextLines([piece("   ", 10, 20, 700), piece("Grande", 72, 150, 700, 24), piece("peq", 154, 170, 650, 8)], 792);
    expect(lines.map((l) => l.text)).toEqual(["Grande", "peq"]);
  });

  it("une trozos pegados sin anadir espacios de mas", () => {
    const [first] = buildTextLines([piece("Fir", 72, 88, 700), piece("ma:", 88.5, 106, 700)], 792);
    expect(first.text).toBe("Firma:");
  });
});

describe("findLabels", () => {
  const kinds = (text: string): Array<[string, number]> => findLabels([line(text, 72, 700)]).map((l) => [l.kind, l.strength]);

  it("etiquetas de firma en espanol e ingles", () => {
    expect(kinds("Firma:")).toEqual([["signature", 1]]);
    expect(kinds("Firma del Asegurado")[0][0]).toBe("signature");
    expect(kinds("Signature:")).toEqual([["signature", 1]]);
    expect(kinds("Sign here")[0][0]).toBe("signature");
    expect(kinds("Firmante")[0][0]).toBe("signature");
    expect(kinds("Signature of Insured")[0][0]).toBe("signature");
  });

  it("etiquetas de iniciales en espanol e ingles", () => {
    expect(kinds("Initials:")).toEqual([["initials", 1]]);
    expect(kinds("Iniciales")[0][0]).toBe("initials");
    expect(kinds("Rubrica")[0][0]).toBe("initials");
    expect(kinds("(Initial)")[0][0]).toBe("initials");
  });

  it("«X _____» es la raya de firma en ingles", () => {
    expect(kinds("X ______________")).toEqual([["signature", 1]]);
    expect(kinds("x....")).toEqual([["signature", 1]]);
    expect(kinds("Xavier Lopez")).toEqual([]);
  });

  it("«Insured» y «Assured» sueltos son una etiqueta DEBIL (0,5), solo en una linea corta", () => {
    expect(kinds("Insured")).toEqual([["signature", 0.5]]);
    expect(kinds("Assured:")[0]).toEqual(["signature", 0.5]);
    expect(kinds("Asegurado")).toEqual([["signature", 0.5]]);
    expect(kinds("The insured shall report any loss within seven calendar days of discovery")).toEqual([]);
  });

  it("la prosa no es una etiqueta", () => {
    expect(kinds("El asegurado debe comunicar el siniestro y la firma de las partes se hara despues de la lectura")).toEqual([]);
    expect(kinds("Texto cualquiera sin nada")).toEqual([]);
  });

  it("devuelve la caja, la altura de linea con el interlineado y un texto legible", () => {
    const [found] = findLabels([line("Firma del Asegurado:", 72, 700, 110, 10)]);
    expect(found.box).toEqual({ x: 72, y: 700, width: 110, height: 10 });
    expect(found.lineHeight).toBeCloseTo(10 * LEADING, 5);
    expect(found.text).toBe("Firma del Asegurado");
  });

  it("labelsByPage indexa por pagina", () => {
    const map = labelsByPage([page(0, [line("Firma:", 72, 700)]), page(1, [line("Texto", 72, 700)]), page(2, [line("Initials:", 72, 740)])]);
    expect(map.get(0)).toHaveLength(1);
    expect(map.get(1)).toEqual([]);
    expect(map.get(2)?.[0].kind).toBe("initials");
  });
});

describe("nearestLabel", () => {
  const sig = label("signature", { box: { x: 72, y: 700, width: 60, height: 10 }, lineHeight: 12 });

  it("etiqueta debajo de la caja a <= 2 lineas: cerca; a mas: no", () => {
    // La caja termina en y = 690; la etiqueta empieza en 700: hueco de 10 pt = 0,83 lineas.
    expect(nearestLabel({ x: 72, y: 640, width: 150, height: 50 }, [sig], 612)?.label).toBe(sig);
    // Hueco de 24 pt = 2 lineas exactas (12 x 2): todavia cerca.
    expect(nearestLabel({ x: 72, y: 626, width: 150, height: 50 }, [sig], 612)).not.toBeNull();
    // Hueco de 26 pt: lejos.
    expect(nearestLabel({ x: 72, y: 624, width: 150, height: 50 }, [sig], 612)).toBeNull();
  });

  it("etiqueta encima de la caja tambien cuenta", () => {
    expect(nearestLabel({ x: 72, y: 720, width: 150, height: 40 }, [sig], 612)).not.toBeNull();
    expect(nearestLabel({ x: 72, y: 740, width: 150, height: 40 }, [sig], 612)).toBeNull(); // 30 pt: 2,5 lineas
  });

  it("etiqueta a la izquierda en la misma linea: cerca hasta 90 pt (a escala de carta); mas lejos, no", () => {
    expect(nearestLabel({ x: 200, y: 695, width: 150, height: 40 }, [sig], 612)).not.toBeNull(); // hueco horizontal de 68
    expect(nearestLabel({ x: 230, y: 695, width: 150, height: 40 }, [sig], 612)).toBeNull(); // 98
  });

  it("el limite horizontal escala con el ancho de la pagina", () => {
    expect(nearestLabel({ x: 230, y: 695, width: 150, height: 40 }, [sig], 1224)).not.toBeNull(); // 90 x 2
    expect(nearestLabel({ x: 230, y: 695, width: 150, height: 40 }, [sig], 100)).toBeNull(); // 90 x 0,5 = 45
  });

  it("una etiqueta DENTRO de la caja (firma sobre la raya) tiene distancia 0", () => {
    const found = nearestLabel({ x: 60, y: 690, width: 200, height: 40 }, [sig], 612);
    expect(found?.distance).toBe(0);
  });

  it("filtra por tipo y elige la mas cercana (a igual distancia, la mas fuerte)", () => {
    const ini = label("initials", { box: { x: 72, y: 700, width: 40, height: 10 } });
    const box = { x: 72, y: 640, width: 150, height: 50 };
    expect(nearestLabel(box, [sig, ini], 612, "initials")?.label).toBe(ini);
    expect(nearestLabel(box, [sig, ini], 612, "signature")?.label).toBe(sig);
    const far = label("signature", { box: { x: 72, y: 712, width: 60, height: 10 } });
    expect(nearestLabel(box, [far, sig], 612)?.label).toBe(sig);
    const weak = label("signature", { strength: 0.5 });
    expect(nearestLabel(box, [weak, sig], 612)?.label).toBe(sig);
    expect(nearestLabel(box, [], 612)).toBeNull();
  });
});

describe("labelReason", () => {
  it("«cerca de «Firma»», con el texto recortado a 36 caracteres", () => {
    expect(labelReason(label("signature", { text: "Firma" }))).toBe("cerca de «Firma»");
    const long = labelReason(label("signature", { text: "x".repeat(50) }));
    expect(long).toBe(`cerca de «${"x".repeat(36)}…»`);
  });
});
