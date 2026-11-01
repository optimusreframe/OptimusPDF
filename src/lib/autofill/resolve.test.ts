import { describe, expect, it } from "vitest";
import { HIGH_CONFIDENCE, MAX_VALUES_PER_KEY, resolveCandidates } from "@/lib/autofill/resolve";
import type { Candidate } from "@/lib/autofill/rules";

function candidate(partial: Partial<Candidate> & { key: string; value: string }): Candidate {
  return {
    sourceIndex: 0,
    pageIndex: 0,
    lineIndex: 0,
    origin: "text-layer",
    labeled: true,
    labelText: "Label:",
    labelWeight: 1,
    valueStrength: 1,
    layout: "inline",
    flags: [],
    snippet: "Label: value",
    order: 0,
    ...partial,
  };
}

describe("nivel y confianza", () => {
  it("alto: etiqueta clara + formato valido + sin banderas", () => {
    const [value] = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142" })], "en");
    expect(value.tier).toBe("high");
    expect(value.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    expect(value.confidence).toBeLessThanOrEqual(0.98);
  });

  it("sin etiqueta: siempre revision y por debajo de 0,75", () => {
    const [value] = resolveCandidates([candidate({ key: "email", value: "a@b.co", labeled: false, labelWeight: 0.72, layout: "free", freeKind: "email", flags: ["unlabeled"] })], "en");
    expect(value.tier).toBe("review");
    expect(value.confidence).toBeLessThan(0.75);
  });

  it.each(["ambiguous-date", "single-word", "lowercase", "margin", "ocr-low", "generic-mailbox", "multi-name"] as const)("la bandera %s impide el nivel alto", (flag) => {
    const [value] = resolveCandidates([candidate({ key: "lossDate", value: "03/04/2026", flags: [flag] })], "en");
    expect(value.tier).toBe("review");
    expect(value.confidence).toBeLessThan(HIGH_CONFIDENCE);
  });

  it("apellido compartido sigue siendo alto pero con la nota en la razon", () => {
    const [value] = resolveCandidates([candidate({ key: "insuredName1", value: "Juan Perez", flags: ["shared-surname"] })], "es");
    expect(value.tier).toBe("high");
    expect(value.reason).toMatch(/apellido compartido/);
  });

  it("OCR resta confianza; la confianza nunca sale de 0..1 y la revision no pasa de 0,84", () => {
    const high = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142", origin: "ocr" })], "en")[0];
    const clean = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142" })], "en")[0];
    expect(high.confidence).toBeLessThan(clean.confidence);
    const review = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142", flags: ["margin"] })], "en")[0];
    expect(review.confidence).toBeLessThanOrEqual(0.84);
    expect(review.confidence).toBeGreaterThan(0);
  });

  it("techo de confianza por clave (un nombre no llega a donde llega un correo)", () => {
    const name = resolveCandidates([candidate({ key: "insuredName1", value: "Maria Perez" })], "en")[0];
    const email = resolveCandidates([candidate({ key: "email", value: "m@x.com" })], "en")[0];
    expect(name.confidence).toBeLessThanOrEqual(0.95);
    expect(email.confidence).toBeGreaterThan(name.confidence);
  });
});

describe("repetidos y conflictos", () => {
  it("el mismo valor (aunque cambie mayusculas, tildes o signos) es uno solo, con la mejor evidencia", () => {
    const list = resolveCandidates(
      [
        candidate({ key: "insuredName1", value: "María Pérez", order: 5, pageIndex: 2, snippet: "late" }),
        candidate({ key: "insuredName1", value: "Maria Perez", order: 1, pageIndex: 0, snippet: "early" }),
      ],
      "es",
    );
    expect(list).toHaveLength(1);
    expect(list[0].evidence.snippet).toBe("early");
    expect(list[0].tier).toBe("high");
  });

  it("repetirse suma un poco de confianza, con tope", () => {
    const one = resolveCandidates([candidate({ key: "address", value: "1 A St, X, FL 33166", labelWeight: 0.9 })], "en")[0];
    const three = resolveCandidates(Array.from({ length: 3 }, (_, i) => candidate({ key: "address", value: "1 A St, X, FL 33166", labelWeight: 0.9, order: i })), "en")[0];
    expect(three.confidence).toBeGreaterThan(one.confidence);
    expect(three.confidence - one.confidence).toBeLessThanOrEqual(0.05);
  });

  it("dos valores distintos: ambos revision, el de mayor confianza primero", () => {
    const list = resolveCandidates([candidate({ key: "policyNumber", value: "AAA-111", valueStrength: 0.9 }), candidate({ key: "policyNumber", value: "BBB-222", order: 2 })], "en");
    expect(list.map((value) => value.value)).toEqual(["BBB-222", "AAA-111"]);
    expect(list.every((value) => value.tier === "review")).toBe(true);
  });

  it("empate de confianza: gana el que aparece antes", () => {
    const list = resolveCandidates([candidate({ key: "claimNumber", value: "B-1111", order: 9 }), candidate({ key: "claimNumber", value: "A-1111", order: 3 })], "en");
    expect(list.map((value) => value.value)).toEqual(["A-1111", "B-1111"]);
  });

  it("un nombre contenido en otro mas completo se fusiona en el mas completo", () => {
    const list = resolveCandidates([candidate({ key: "insuredName1", value: "Maria Perez" }), candidate({ key: "insuredName1", value: "Maria Perez Lopez", order: 2 })], "en");
    expect(list.map((value) => value.value)).toEqual(["Maria Perez Lopez"]);
  });

  it("nombres distintos de personas distintas SI son conflicto", () => {
    const list = resolveCandidates([candidate({ key: "insuredName1", value: "Maria Perez" }), candidate({ key: "insuredName1", value: "Jose Gomez", order: 2 })], "en");
    expect(list).toHaveLength(2);
    expect(list.every((value) => value.tier === "review")).toBe(true);
  });

  it("un candidato libre cede ante uno con etiqueta (salvo que coincidan)", () => {
    const list = resolveCandidates(
      [candidate({ key: "phone", value: "(305) 555-0142" }), candidate({ key: "phone", value: "(407) 555-0199", labeled: false, labelWeight: 0.72, layout: "free", flags: ["unlabeled"] })],
      "en",
    );
    expect(list.map((value) => value.value)).toEqual(["(305) 555-0142"]);
    expect(list[0].tier).toBe("high");
  });

  it("limita los valores por clave", () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate({ key: "claimNumber", value: `CLM-${1000 + i}`, order: i }));
    expect(resolveCandidates(many, "en")).toHaveLength(MAX_VALUES_PER_KEY);
  });
});

describe("orden e identificadores", () => {
  it("claves en orden estable; ids sucesivos; determinista", () => {
    const input = [
      candidate({ key: "lossDate", value: "03/14/2026" }),
      candidate({ key: "insuredName1", value: "Maria Perez" }),
      candidate({ key: "x.custom", value: "algo" }),
      candidate({ key: "phone", value: "(305) 555-0142" }),
    ];
    const a = resolveCandidates(input, "en");
    const b = resolveCandidates([...input].reverse(), "en");
    expect(a.map((value) => value.key)).toEqual(["insuredName1", "phone", "lossDate", "x.custom"]);
    expect(a.map((value) => value.id)).toEqual(["ev-0", "ev-1", "ev-2", "ev-3"]);
    expect(b).toEqual(a);
  });

  it("el snippet no pasa de 120 caracteres y la razon nunca lleva el valor", () => {
    const [value] = resolveCandidates([candidate({ key: "insuredName1", value: "Maria Perez", snippet: "x".repeat(400), labelText: "Insured:" })], "en");
    expect(value.evidence.snippet.length).toBeLessThanOrEqual(120);
    expect(value.reason).not.toContain("Maria");
    expect(value.reason).toContain("Insured");
  });

  it("razones en espanol e ingles", () => {
    const es = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142", labelText: "Teléfono:" })], "es")[0];
    const en = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142", labelText: "Phone:", layout: "below" })], "en")[0];
    expect(es.reason).toBe("Junto a «Teléfono» (página 1)");
    expect(en.reason).toBe("Below “Phone” (page 1)");
    const pasted = resolveCandidates([candidate({ key: "phone", value: "(305) 555-0142", origin: "pasted" })], "es")[0];
    expect(pasted.reason).toContain("texto pegado");
  });

  it("entrada vacia", () => {
    expect(resolveCandidates([], "en")).toEqual([]);
  });
});
