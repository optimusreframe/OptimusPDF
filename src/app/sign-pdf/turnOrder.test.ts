import { describe, expect, it } from "vitest";
import { moveTurn, orderedQueue, sanitizeTurnOrder } from "@/app/sign-pdf/turnOrder";

const Q = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("orderedQueue", () => {
  it("sin orden devuelve la cola tal cual (otra lista, mismos elementos)", () => {
    const out = orderedQueue(Q);
    expect(out).toEqual(Q);
    expect(out).not.toBe(Q);
    expect(orderedQueue(Q, null)).toEqual(Q);
    expect(orderedQueue(Q, [])).toEqual(Q);
  });
  it("pone primero a los nombrados y despues a los demas en su orden", () => {
    expect(orderedQueue(Q, ["c", "a"]).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(orderedQueue(Q, ["b"]).map((s) => s.id)).toEqual(["b", "a", "c"]);
  });
  it("ignora ids repetidos o que no estan en la cola", () => {
    expect(orderedQueue(Q, ["c", "c", "zzz", "b"]).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });
});

describe("sanitizeTurnOrder", () => {
  it("deja solo ids de firmantes que existen, sin repetir, y nada si no queda ninguno", () => {
    expect(sanitizeTurnOrder(["b", "a", "b", "x"], ["a", "b"])).toEqual(["b", "a"]);
    expect(sanitizeTurnOrder(["x"], ["a"])).toBeUndefined();
    expect(sanitizeTurnOrder([], ["a"])).toBeUndefined();
  });
  it("lo que no es una lista de textos se descarta", () => {
    expect(sanitizeTurnOrder("a", ["a"])).toBeUndefined();
    expect(sanitizeTurnOrder(null, ["a"])).toBeUndefined();
    expect(sanitizeTurnOrder([1, {}, "a"], ["a"])).toEqual(["a"]);
  });
});

describe("moveTurn", () => {
  it("sube y baja un puesto", () => {
    expect(moveTurn(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveTurn(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });
  it("en los extremos o con un id que no esta no hay nada que mover", () => {
    expect(moveTurn(["a", "b"], "a", -1)).toBeNull();
    expect(moveTurn(["a", "b"], "b", 1)).toBeNull();
    expect(moveTurn(["a", "b"], "z", 1)).toBeNull();
  });
  it("no modifica la lista de entrada", () => {
    const input = ["a", "b"];
    moveTurn(input, "a", 1);
    expect(input).toEqual(["a", "b"]);
  });
});
