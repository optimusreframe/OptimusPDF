import { describe, expect, it } from "vitest";
import { EMPTY_DOC_STATE, copiesOf, setDocCopies, type DocState } from "@/app/sign-pdf/docSet";

/** Copias por documento en `DocState` (U1.1): ausente = 1, 1..5, se guarda solo cuando vale mas de 1. */
describe("copiesOf", () => {
  it("ausente, sin estado o raro = 1", () => {
    expect(copiesOf(undefined)).toBe(1);
    expect(copiesOf(EMPTY_DOC_STATE)).toBe(1);
    expect(copiesOf({ copies: undefined })).toBe(1);
    expect(copiesOf({ copies: 0 })).toBe(1);
    expect(copiesOf({ copies: Number.NaN })).toBe(1);
  });

  it("lee 2..5 y lleva lo que se pasa de rango al tope", () => {
    expect([2, 3, 4, 5].map((copies) => copiesOf({ copies }))).toEqual([2, 3, 4, 5]);
    expect(copiesOf({ copies: 9 })).toBe(5);
  });
});

describe("setDocCopies", () => {
  const docs: Record<string, DocState> = { a: { ...EMPTY_DOC_STATE, sealedKey: "ka" }, b: { ...EMPTY_DOC_STATE } };

  it("fija las copias de UN documento sin tocar los demas ni el resto de su estado", () => {
    const next = setDocCopies(docs, "a", 3);
    expect(next).not.toBe(docs);
    expect(next.a).toEqual({ ...docs.a, copies: 3 });
    expect(next.b).toBe(docs.b);
    expect(docs.a.copies).toBeUndefined();
  });

  it("1 se guarda como «sin dato»: el estado vuelve a ser identico al de siempre", () => {
    const three = setDocCopies(docs, "a", 3);
    const back = setDocCopies(three, "a", 1);
    expect(back.a).toEqual(docs.a);
    expect("copies" in back.a).toBe(false);
  });

  it("lleva el valor a 1..5", () => {
    expect(setDocCopies(docs, "a", 9).a.copies).toBe(5);
    expect("copies" in setDocCopies(docs, "a", 0).a).toBe(false);
    expect("copies" in setDocCopies(docs, "a", -3).a).toBe(false);
    expect(setDocCopies(docs, "a", 2.9).a.copies).toBe(2);
    expect("copies" in setDocCopies(docs, "a", Number.NaN).a).toBe(false);
  });

  it("devuelve la MISMA tabla si no cambia nada", () => {
    expect(setDocCopies(docs, "a", 1)).toBe(docs);
    const three = setDocCopies(docs, "a", 3);
    expect(setDocCopies(three, "a", 3)).toBe(three);
    expect(setDocCopies(three, "a", 3.4)).toBe(three);
  });

  it("un documento sin estado se crea en blanco solo si hay copias que guardar", () => {
    expect(setDocCopies(docs, "nuevo", 1)).toBe(docs);
    const made = setDocCopies(docs, "nuevo", 2);
    expect(made.nuevo).toEqual({ ...EMPTY_DOC_STATE, copies: 2 });
  });
});
