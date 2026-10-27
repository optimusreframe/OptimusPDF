import { describe, expect, it } from "vitest";
import { findLabels, nearestLabel } from "./classifyText";
import { line } from "./classify.testUtils";

/** H7: variantes de etiqueta que se tomaban por iniciales o no se reconocian (ES/EN). */

const kindOf = (text: string) => findLabels([line(text, 56, 600, 120, 10)])[0];

describe("etiquetas de firma (H7)", () => {
  it.each(["Signature:", "Signed by:", "Signatory", "Firmado por:", "Firmante", "Firma autógrafa", "Autógrafo:", "Autografo", "Autograph:", "Insured", "Assured", "Signature of the Insured", "Customer Signature", "Sign here"])("«%s» es etiqueta de FIRMA", (text) => {
    const found = kindOf(text);
    expect(found?.kind, text).toBe("signature");
    expect(found?.alsoSignature).toBeUndefined();
  });
  it("«Autógrafo» dentro de una frase larga es prosa, no una etiqueta", () => {
    expect(findLabels([line("El presente documento lleva el autógrafo de cada una de las partes interesadas en el contrato", 56, 600, 400, 10)])).toEqual([]);
  });
});

describe("etiquetas de iniciales", () => {
  it.each(["Initials:", "Iniciales", "Initial here", "Init.", "Paraf:", "Paraphe", "Parafo"])("«%s» es etiqueta de INICIALES", (text) => {
    expect(kindOf(text)?.kind, text).toBe("initials");
  });
  it("«Rúbrica» es iniciales Y TAMBIEN firma (la forma de la imagen decide): lleva `alsoSignature`", () => {
    const rubrica = kindOf("Rúbrica:");
    expect(rubrica?.kind).toBe("initials");
    expect(rubrica?.alsoSignature).toBe(true);
    expect(kindOf("Rubrica")?.alsoSignature).toBe(true);
    expect(kindOf("Initials:")?.alsoSignature).toBeUndefined();
  });
  it("«Paraf» dentro de una frase larga no cuenta", () => {
    expect(findLabels([line("Paraf is the name of the village where the parties first signed the original of this long agreement", 56, 600, 400, 10)]).filter((label) => label.kind === "initials")).toEqual([]);
  });
});

describe("nearestLabel con «Rúbrica»", () => {
  const rubrica = findLabels([line("Rúbrica:", 56, 600, 60, 10)]);
  const box = { x: 130, y: 590, width: 150, height: 40 };
  it("la encuentra como etiqueta de iniciales Y de firma", () => {
    expect(nearestLabel(box, rubrica, 612, "initials")).not.toBeNull();
    expect(nearestLabel(box, rubrica, 612, "signature")?.label.text).toContain("brica");
  });
  it("las etiquetas de iniciales normales NO se cuentan como de firma", () => {
    const initials = findLabels([line("Initials:", 56, 600, 60, 10)]);
    expect(nearestLabel(box, initials, 612, "signature")).toBeNull();
  });
});
