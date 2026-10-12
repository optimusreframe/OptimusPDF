import { describe, expect, it } from "vitest";
import type { PageEntry } from "@/lib/pdf/pageAssembly";
import { identityPlan } from "@/lib/pdf/pageAssembly";
import {
  appendDocument,
  deletePages,
  duplicatePages,
  ensureIds,
  idsByParity,
  idsInRange,
  insertBlankPages,
  insertExternalPages,
  insertImagePages,
  movePages,
  neighbourBlankSize,
  rotatePages,
  selectedEntries,
  shiftPages,
  summarizePlan,
} from "@/lib/pdf/pageAssemblyPlan";

let counter = 0;
const makeId = () => `n${(counter += 1)}`;
const plan = (count: number): PageEntry[] => identityPlan(count, (i) => `p${i}`);
const order = (entries: readonly PageEntry[]) =>
  entries.map((entry) => (entry.kind === "existing" ? `${entry.copy ? "c" : ""}${entry.sourceIndex}` : entry.kind[0]));

describe("ensureIds", () => {
  it("da id solo a quien no lo tiene y no cambia los demas", () => {
    const base: PageEntry[] = [
      { kind: "existing", sourceIndex: 0, rotation: 0, id: "a" },
      { kind: "existing", sourceIndex: 1, rotation: 0 },
    ];
    const out = ensureIds(base, () => "nuevo");
    expect(out.map((entry) => entry.id)).toEqual(["a", "nuevo"]);
    expect(out[0]).toBe(base[0]);
  });
});

describe("movePages", () => {
  it("mueve una pagina al principio", () => {
    expect(order(movePages(plan(5), ["p3"], 0))).toEqual(["3", "0", "1", "2", "4"]);
  });

  it("mueve una pagina al final", () => {
    expect(order(movePages(plan(5), ["p1"], 5))).toEqual(["0", "2", "3", "4", "1"]);
  });

  it("mover hacia delante cuenta la posicion sobre el plan ORIGINAL (antes de quitar)", () => {
    // Soltar la pagina 0 «antes de la 3»: queda entre la 2 y la 3.
    expect(order(movePages(plan(5), ["p0"], 3))).toEqual(["1", "2", "0", "3", "4"]);
  });

  it("mueve un bloque seleccionado junto y en su orden relativo", () => {
    expect(order(movePages(plan(6), ["p4", "p1"], 3))).toEqual(["0", "2", "1", "4", "3", "5"]);
  });

  it("soltar justo donde ya esta no cambia nada y devuelve el MISMO plan", () => {
    const base = plan(4);
    expect(movePages(base, ["p1"], 1)).toBe(base);
    expect(movePages(base, ["p1"], 2)).toBe(base);
  });

  it("una seleccion vacia o con ids desconocidos devuelve el mismo plan", () => {
    const base = plan(3);
    expect(movePages(base, [], 0)).toBe(base);
    expect(movePages(base, ["nada"], 0)).toBe(base);
  });

  it("limita la posicion al rango del plan", () => {
    expect(order(movePages(plan(3), ["p0"], 99))).toEqual(["1", "2", "0"]);
    expect(order(movePages(plan(3), ["p2"], -5))).toEqual(["2", "0", "1"]);
  });

  it("acepta un Set como seleccion", () => {
    expect(order(movePages(plan(3), new Set(["p2"]), 0))).toEqual(["2", "0", "1"]);
  });

  it("no muta el plan de entrada", () => {
    const base = plan(4);
    const snapshot = [...base];
    movePages(base, ["p3"], 0);
    expect(base).toEqual(snapshot);
  });
});

describe("shiftPages (Mover antes / despues)", () => {
  it("mueve una pagina una posicion hacia atras y hacia delante", () => {
    expect(order(shiftPages(plan(4), ["p2"], -1))).toEqual(["0", "2", "1", "3"]);
    expect(order(shiftPages(plan(4), ["p1"], 1))).toEqual(["0", "2", "1", "3"]);
  });

  it("la primera no puede ir mas atras (mismo plan) ni la ultima mas adelante", () => {
    const base = plan(3);
    expect(shiftPages(base, ["p0"], -1)).toBe(base);
    expect(shiftPages(base, ["p2"], 1)).toBe(base);
  });

  it("un bloque contiguo se desplaza entero", () => {
    expect(order(shiftPages(plan(5), ["p2", "p3"], -1))).toEqual(["0", "2", "3", "1", "4"]);
    expect(order(shiftPages(plan(5), ["p1", "p2"], 1))).toEqual(["0", "3", "1", "2", "4"]);
  });

  it("dos paginas separadas se desplazan a la vez", () => {
    expect(order(shiftPages(plan(6), ["p1", "p4"], 1))).toEqual(["0", "2", "1", "3", "5", "4"]);
  });

  it("todo seleccionado no cambia nada", () => {
    const base = plan(3);
    expect(shiftPages(base, ["p0", "p1", "p2"], 1)).toBe(base);
  });
});

describe("rotatePages", () => {
  it("suma 90 grados a las seleccionadas", () => {
    const out = rotatePages(plan(3), ["p1"], 90);
    expect(out.map((entry) => entry.rotation)).toEqual([0, 90, 0]);
  });

  it("es aditivo: 90 + 90 = 180 y 270 + 90 = 0", () => {
    let current = rotatePages(plan(1), ["p0"], 90);
    current = rotatePages(current, ["p0"], 90);
    expect(current[0].rotation).toBe(180);
    current = rotatePages(current, ["p0"], 90);
    current = rotatePages(current, ["p0"], 90);
    expect(current[0].rotation).toBe(0);
  });

  it("-90 equivale a 270", () => {
    expect(rotatePages(plan(1), ["p0"], -90)[0].rotation).toBe(270);
  });

  it("0 o 360 devuelven el mismo plan", () => {
    const base = plan(2);
    expect(rotatePages(base, ["p0"], 0)).toBe(base);
    expect(rotatePages(base, ["p0"], 360)).toBe(base);
  });

  it("solo cambia las seleccionadas y devuelve entradas nuevas solo para ellas", () => {
    const base = plan(3);
    const out = rotatePages(base, ["p0", "p2"], 180);
    expect(out[1]).toBe(base[1]);
    expect(out[0]).not.toBe(base[0]);
    expect(out.map((entry) => entry.rotation)).toEqual([180, 0, 180]);
  });

  it("sin seleccion valida devuelve el mismo plan", () => {
    const base = plan(2);
    expect(rotatePages(base, ["nada"], 90)).toBe(base);
  });

  it("rota paginas en blanco, de otro PDF e imagenes", () => {
    const mixed: PageEntry[] = [
      { kind: "blank", width: 1, height: 1, rotation: 0, id: "b" },
      { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0, id: "e" },
      { kind: "image", sourceId: "i", rotation: 0, id: "i" },
    ];
    expect(rotatePages(mixed, ["b", "e", "i"], 90).map((entry) => entry.rotation)).toEqual([90, 90, 90]);
  });
});

describe("deletePages", () => {
  it("quita las seleccionadas", () => {
    expect(order(deletePages(plan(5), ["p1", "p3"]))).toEqual(["0", "2", "4"]);
  });

  it("sin coincidencias devuelve el mismo plan", () => {
    const base = plan(2);
    expect(deletePages(base, ["x"])).toBe(base);
  });

  it("quitarlas todas lanza `empty` (nunca un PDF sin paginas)", () => {
    expect(() => deletePages(plan(2), ["p0", "p1"])).toThrowError(expect.objectContaining({ code: "empty" }));
  });
});

describe("duplicatePages", () => {
  it("la copia va justo despues y esta marcada como copia", () => {
    const out = duplicatePages(plan(3), ["p1"], makeId);
    expect(order(out)).toEqual(["0", "1", "c1", "2"]);
    expect(out[2].id).not.toBe(out[1].id);
  });

  it("un bloque contiguo se copia entero detras de si mismo", () => {
    expect(order(duplicatePages(plan(5), ["p1", "p2"], makeId))).toEqual(["0", "1", "2", "c1", "c2", "3", "4"]);
  });

  it("bloques separados se copian cada uno tras su bloque", () => {
    expect(order(duplicatePages(plan(5), ["p0", "p3"], makeId))).toEqual(["0", "c0", "1", "2", "3", "c3", "4"]);
  });

  it("la copia conserva la rotacion de la original", () => {
    const rotated = rotatePages(plan(2), ["p0"], 90);
    const out = duplicatePages(rotated, ["p0"], makeId);
    expect(out.map((entry) => entry.rotation)).toEqual([90, 90, 0]);
  });

  it("duplicar una copia da otra copia", () => {
    const once = duplicatePages(plan(1), ["p0"], makeId);
    const twice = duplicatePages(once, [once[1].id as string], makeId);
    expect(order(twice)).toEqual(["0", "c0", "c0"]);
  });

  it("duplica entradas en blanco, externas e imagenes sin marca `copy`", () => {
    const mixed: PageEntry[] = [
      { kind: "blank", width: 5, height: 6, rotation: 0, id: "b" },
      { kind: "external", sourceId: "x", sourceIndex: 2, rotation: 90, id: "e" },
      { kind: "image", sourceId: "i", rotation: 0, id: "i" },
    ];
    const out = duplicatePages(mixed, ["b", "e", "i"], makeId);
    expect(out.length).toBe(6);
    expect(out[3]).toMatchObject({ kind: "blank", width: 5, height: 6 });
    expect(out[4]).toMatchObject({ kind: "external", sourceIndex: 2, rotation: 90 });
    expect("copy" in out[3]).toBe(false);
  });

  it("sin seleccion valida devuelve el mismo plan", () => {
    const base = plan(2);
    expect(duplicatePages(base, ["x"], makeId)).toBe(base);
  });
});

describe("insertar", () => {
  it("inserta una pagina en blanco en la posicion pedida", () => {
    const out = insertBlankPages(plan(3), 1, { width: 100, height: 200 }, 1, makeId);
    expect(order(out)).toEqual(["0", "b", "1", "2"]);
    expect(out[1]).toMatchObject({ kind: "blank", width: 100, height: 200, rotation: 0 });
  });

  it("inserta varias en blanco y limita la posicion", () => {
    const out = insertBlankPages(plan(2), 99, { width: 10, height: 10 }, 3, makeId);
    expect(order(out)).toEqual(["0", "1", "b", "b", "b"]);
  });

  it("cero paginas en blanco no cambia el plan", () => {
    const base = plan(2);
    expect(insertBlankPages(base, 0, { width: 1, height: 1 }, 0, makeId)).toBe(base);
  });

  it("el tamano en blanco hereda el de la pagina ANTERIOR del plan (con su giro)", () => {
    const sizeOf = (entry: PageEntry) =>
      entry.kind === "existing" ? { width: 100 + entry.sourceIndex, height: 200 } : null;
    const rotated = rotatePages(plan(3), ["p1"], 90);
    expect(neighbourBlankSize(rotated, 2, sizeOf)).toEqual({ width: 200, height: 101 });
    expect(neighbourBlankSize(rotated, 1, sizeOf)).toEqual({ width: 100, height: 200 });
  });

  it("al principio hereda de la siguiente y sin vecinas usa A4", () => {
    const sizeOf = (entry: PageEntry) =>
      entry.kind === "existing" ? { width: 300, height: 400 } : null;
    expect(neighbourBlankSize(plan(2), 0, sizeOf)).toEqual({ width: 300, height: 400 });
    expect(neighbourBlankSize([], 0, sizeOf)).toEqual({ width: 595.28, height: 841.89 });
  });

  it("salta vecinas de tamano desconocido hasta encontrar una conocida", () => {
    const only: PageEntry[] = [
      { kind: "existing", sourceIndex: 0, rotation: 0, id: "a" },
      { kind: "image", sourceId: "i", rotation: 0, id: "i" },
    ];
    const sizeOf = (entry: PageEntry) => (entry.kind === "existing" ? { width: 50, height: 60 } : null);
    expect(neighbourBlankSize(only, 2, sizeOf)).toEqual({ width: 50, height: 60 });
  });

  it("inserta paginas de otro PDF en orden", () => {
    const out = insertExternalPages(plan(2), 1, "x", [3, 4], makeId);
    expect(order(out)).toEqual(["0", "e", "e", "1"]);
    expect(out[1]).toMatchObject({ kind: "external", sourceId: "x", sourceIndex: 3 });
    expect(out[2]).toMatchObject({ sourceIndex: 4 });
  });

  it("sin indices no cambia el plan", () => {
    const base = plan(2);
    expect(insertExternalPages(base, 0, "x", [], makeId)).toBe(base);
  });

  it("`appendDocument` anade todas las paginas al final por defecto o en una posicion", () => {
    expect(order(appendDocument(plan(2), "x", 3, undefined, makeId))).toEqual(["0", "1", "e", "e", "e"]);
    expect(order(appendDocument(plan(2), "x", 2, 0, makeId))).toEqual(["e", "e", "0", "1"]);
  });

  it("inserta imagenes con su formato de pagina", () => {
    const out = insertImagePages(plan(1), 1, ["i1", "i2"], { pageSize: "letter" }, makeId);
    expect(out.length).toBe(3);
    expect(out[1]).toMatchObject({ kind: "image", sourceId: "i1", layout: { pageSize: "letter" } });
    expect(out[2]).toMatchObject({ kind: "image", sourceId: "i2" });
  });

  it("`selectedEntries` devuelve las seleccionadas en el orden del plan", () => {
    expect(order(selectedEntries(plan(5), ["p4", "p1"]))).toEqual(["1", "4"]);
  });
});

describe("seleccion por posicion", () => {
  it("pares e impares se cuentan por la posicion que se VE, no por el numero original", () => {
    const moved = movePages(plan(5), ["p4"], 0); // 4 0 1 2 3
    expect(idsByParity(moved, "odd")).toEqual(["p4", "p1", "p3"]);
    expect(idsByParity(moved, "even")).toEqual(["p0", "p2"]);
  });

  it("un rango de posiciones es inclusivo y tolera extremos cruzados o fuera de rango", () => {
    expect(idsInRange(plan(6), 2, 4)).toEqual(["p1", "p2", "p3"]);
    expect(idsInRange(plan(6), 4, 2)).toEqual(["p1", "p2", "p3"]);
    expect(idsInRange(plan(3), 2, 99)).toEqual(["p1", "p2"]);
    expect(idsInRange(plan(3), -3, 1)).toEqual(["p0"]);
  });
});

describe("summarizePlan", () => {
  it("el plan identidad no tiene cambios", () => {
    const summary = summarizePlan(plan(5), 5);
    expect(summary.identity).toBe(true);
    expect(summary).toMatchObject({ moved: 0, rotated: 0, deleted: 0, duplicated: 0, blanks: 0 });
  });

  it("cuenta el minimo de paginas movidas (subsecuencia creciente mas larga)", () => {
    // 1 2 3 0 4: solo la 0 cambia de sitio.
    const out = movePages(plan(5), ["p0"], 4);
    expect(summarizePlan(out, 5).moved).toBe(1);
    // Invertir 5: hay que mover 4.
    expect(summarizePlan(plan(5).reverse(), 5).moved).toBe(4);
  });

  it("cuenta eliminadas, rotadas, duplicadas, blancos, externas e imagenes", () => {
    let current = plan(6);
    current = deletePages(current, ["p4", "p5"]);
    current = rotatePages(current, ["p0", "p1"], 90);
    current = duplicatePages(current, ["p2"], makeId);
    current = insertBlankPages(current, 0, { width: 1, height: 1 }, 2, makeId);
    current = insertExternalPages(current, 0, "x", [0, 1, 2], makeId);
    current = insertImagePages(current, 0, ["i"], undefined, makeId);
    const summary = summarizePlan(current, 6);
    expect(summary).toMatchObject({ deleted: 2, rotated: 2, duplicated: 1, blanks: 2, external: 3, images: 1, identity: false });
  });

  it("rotar y volver a rotar a 0 es identidad", () => {
    let current = rotatePages(plan(2), ["p0"], 90);
    current = rotatePages(current, ["p0"], 270);
    expect(summarizePlan(current, 2).identity).toBe(true);
  });

  it("una copia por si sola ya no es identidad", () => {
    const out = duplicatePages(plan(2), ["p0"], makeId);
    expect(summarizePlan(out, 2).identity).toBe(false);
    expect(summarizePlan(out, 2).duplicated).toBe(1);
  });

  it("repetir una pagina sin marca `copy` cuenta como duplicada", () => {
    const repeated: PageEntry[] = [
      { kind: "existing", sourceIndex: 0, rotation: 0 },
      { kind: "existing", sourceIndex: 0, rotation: 0 },
    ];
    expect(summarizePlan(repeated, 1).duplicated).toBe(1);
  });
});
