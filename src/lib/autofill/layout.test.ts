import { describe, expect, it } from "vitest";
import { buildLines, isContiguous, overlapFraction, pastedBoxes, type TextBox } from "@/lib/autofill/layout";

const box = (text: string, x0: number, x1: number, y0: number, y1: number, confidence?: number): TextBox => ({ text, x0, x1, y0, y1, confidence });

describe("buildLines", () => {
  it("agrupa por linea y ordena por x, sea cual sea el orden de entrada", () => {
    const lines = buildLines([box("World", 60, 100, 0, 10), box("Hello", 10, 55, 0, 10), box("Second", 10, 60, 20, 30)]);
    expect(lines.map((line) => line.text)).toEqual(["Hello World", "Second"]);
    expect(lines[0].index).toBe(0);
    expect(lines[1].index).toBe(1);
  });

  it("tolera un valor escrito un poco mas arriba que la etiqueta (sobre la raya)", () => {
    const lines = buildLines([box("Insured:", 10, 50, 0, 10), box("______", 54, 150, 0, 10), box("Maria Perez", 58, 120, -3, 7)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("Maria Perez");
  });

  it("lineas contiguas pero distintas no se mezclan", () => {
    expect(buildLines([box("A", 0, 10, 0, 10), box("B", 0, 10, 13, 23)])).toHaveLength(2);
  });

  it("un hueco grande separa celdas (tabulador); uno pequeno, no", () => {
    const [line] = buildLines([box("Label:", 10, 50, 0, 10), box("Value", 60, 100, 0, 10), box("Col2", 300, 340, 0, 10)]);
    expect(line.cells.map((cell) => cell.text)).toEqual(["Label: Value", "Col2"]);
    expect(line.text).toBe("Label: Value\tCol2");
    expect(line.starts).toEqual([0, 13]);
  });

  it("tramos casi pegados se unen sin espacio (palabra partida por el lector)", () => {
    const [line] = buildLines([box("Loss A", 10, 40, 0, 10), box("ddress:", 40.4, 80, 0, 10)]);
    expect(line.text).toBe("Loss Address:");
  });

  it("respeta los espacios que ya trae el texto y colapsa los dobles", () => {
    const [line] = buildLines([box("Insured: ", 10, 50, 0, 10), box("  Maria   Perez", 50, 120, 0, 10)]);
    expect(line.text).toBe("Insured: Maria Perez");
  });

  it("conserva la menor confianza de la celda (OCR)", () => {
    const [line] = buildLines([box("Policy", 10, 40, 0, 10, 90), box("12345", 44, 80, 0, 10, 41)]);
    expect(line.cells[0].confidence).toBe(41);
  });

  it("descarta cajas vacias o con coordenadas no finitas, y no revienta con vacio", () => {
    expect(buildLines([])).toEqual([]);
    expect(buildLines([box("  ", 0, 5, 0, 10), box("x", Number.NaN, 5, 0, 10), box("y", 0, Infinity, 0, 10)])).toEqual([]);
  });

  it("limita las cajas por pagina", () => {
    const many = Array.from({ length: 50 }, (_, i) => box(`w${i}`, i * 10, i * 10 + 8, 0, 10));
    expect(buildLines(many, 10)[0].cells.map((c) => c.text).join(" ").split(" ")).toHaveLength(10);
  });

  it("normaliza comillas y NBSP", () => {
    const [line] = buildLines([box("Insured’s Name", 0, 80, 0, 10)]);
    expect(line.text).toBe("Insured's Name");
  });
});

describe("pastedBoxes", () => {
  it("una caja por celda; filas separadas por una linea en blanco dejan hueco", () => {
    const lines = buildLines(pastedBoxes("Name:   Maria Perez\nPhone: 305-555-0100\n\nNext block"));
    expect(lines.map((line) => line.text)).toEqual(["Name:\tMaria Perez", "Phone: 305-555-0100", "Next block"]);
    expect(isContiguous(lines[0], lines[1])).toBe(true);
    expect(isContiguous(lines[1], lines[2])).toBe(false);
  });

  it("tabuladores y barras cuentan como separador de celdas", () => {
    const [line] = buildLines(pastedBoxes("Policy\t12-AB-3456 | Claim\t999"));
    expect(line.cells.length).toBeGreaterThanOrEqual(3);
  });

  it("CRLF y texto vacio", () => {
    expect(pastedBoxes("")).toEqual([]);
    expect(buildLines(pastedBoxes("A\r\nB"))).toHaveLength(2);
  });
});

describe("geometria", () => {
  it("overlapFraction", () => {
    expect(overlapFraction({ x0: 0, x1: 10 }, { x0: 5, x1: 15 })).toBeCloseTo(0.5);
    expect(overlapFraction({ x0: 0, x1: 10 }, { x0: 20, x1: 30 })).toBe(0);
    expect(overlapFraction({ x0: 0, x1: 10 }, { x0: 0, x1: 100 })).toBe(1);
  });

  it("isContiguous exige que la siguiente este debajo y cerca", () => {
    const [a, b] = buildLines([box("A", 0, 10, 0, 10), box("B", 0, 10, 14, 24)]);
    expect(isContiguous(a, b)).toBe(true);
    expect(isContiguous(b, a)).toBe(false);
    expect(isContiguous(a, undefined)).toBe(false);
  });
});
