import { describe, expect, it } from "vitest";
import { applyMatrix, groupsMatrix, type AssignmentMatrix } from "@/app/sign-pdf/assignment";
import {
  copiesMap,
  cycleCell,
  describeImpacts,
  groupDocsText,
  groupsInHalves,
  signModeFor,
  stepAllCopies,
  stepCopies,
  totalFiles,
  uniformCopies,
} from "@/app/sign-pdf/assignmentUi";
import { EMPTY_DOC_STATE, type SignerBlock } from "@/app/sign-pdf/docSet";

/*
 * Logica pura de la tabla «¿Quien firma que?» (U1.2): que pasa al tocar una celda, «Por grupos», el modo derivado, las
 * copias con sus topes y la descripcion de los trazos que un cambio se llevaria.
 */

const D = ["d1", "d2", "d3", "d4"];
const matrix = (cells: (string | null)[][], docIds = D.slice(0, cells.length), signerIds = ["s1"]): AssignmentMatrix => ({
  docIds,
  signerIds,
  cells,
});
const column = (m: AssignmentMatrix, col = 0) => m.cells.map((row) => row[col]);
const tap = (m: AssignmentMatrix, docId: string, signerId = "s1") => cycleCell(m, docId, signerId);

describe("cycleCell — que pasa al tocar una celda", () => {
  it("en A A A A, la tercera pasa a un grupo nuevo (B), luego a «no firma» y luego vuelve a A", () => {
    let m = matrix([["A"], ["A"], ["A"], ["A"]]);
    m = tap(m, "d3").matrix;
    expect(column(m)).toEqual(["A", "A", "B", "A"]);
    m = tap(m, "d3").matrix;
    expect(column(m)).toEqual(["A", "A", null, "A"]);
    m = tap(m, "d3").matrix;
    expect(column(m)).toEqual(["A", "A", "A", "A"]);
  });

  it("el caso del usuario: tocar la tercera y la cuarta de A A A A da A A B B (DOS toques)", () => {
    let m = matrix([["A"], ["A"], ["A"], ["A"]]);
    m = tap(m, "d3").matrix;
    m = tap(m, "d4").matrix;
    expect(column(m)).toEqual(["A", "A", "B", "B"]);
  });

  it("una celda que comparte grupo con otras pasa al SIGUIENTE grupo existente antes de abrir uno nuevo", () => {
    // A B A B: las opciones de la 1ª son A, B, «nuevo» (C) y «no firma»; desde A toca B (ya existe), no C.
    const m = matrix([["A"], ["B"], ["A"], ["B"]]);
    expect(column(tap(m, "d1").matrix)).toEqual(["A", "A", "B", "A"]); // d1 pasa a B: B B A B -> canonica A A B A
    // Desde B (la 2ª) toca C: abre un grupo nuevo, porque A y B ya existen.
    expect(column(tap(m, "d2").matrix)).toEqual(["A", "B", "A", "C"]); // d2 queda sola en B y d4 pasa a C (canonica)
  });

  it("tocar una celda que es la UNICA de su grupo la lleva a «no firma» (no abre otro grupo)", () => {
    const m = matrix([["A"], ["A"], ["B"], ["A"]]);
    expect(column(tap(m, "d3").matrix)).toEqual(["A", "A", null, "A"]);
  });

  it("desde «no firma» vuelve al primer grupo del firmante", () => {
    const m = matrix([["A"], ["A"], [null], ["A"]]);
    expect(column(tap(m, "d3").matrix)).toEqual(["A", "A", "A", "A"]);
  });

  it("la ultima celda con firma de un firmante no puede quedar vacia: no cambia y lo dice (`lastCell`)", () => {
    const m = matrix([["A"], [null], [null]]);
    const result = tap(m, "d1");
    expect(result.lastCell).toBe(true);
    expect(result.matrix).toBe(m);
  });

  it("si tiene otra celda con firma, quitarla SI se puede", () => {
    const m = matrix([["A"], ["A"], [null]]);
    const once = tap(m, "d2").matrix; // A -> B
    expect(column(once)).toEqual(["A", "B", null]);
    const twice = tap(once, "d2");
    expect(twice.lastCell).toBe(false);
    expect(column(twice.matrix)).toEqual(["A", null, null]);
  });

  it("solo toca la columna de ese firmante", () => {
    const m = matrix(
      [["A", "A"], ["A", "A"], ["A", "A"]],
      D.slice(0, 3),
      ["s1", "s2"],
    );
    const next = tap(m, "d2", "s2").matrix;
    expect(column(next, 0)).toEqual(["A", "A", "A"]);
    expect(column(next, 1)).toEqual(["A", "B", "A"]);
  });

  it("devuelve la tabla CANONICA: las letras salen por orden de aparicion", () => {
    // Tocar la primera de A A A: las otras dos pasan a B (la tocada sigue siendo A).
    const next = tap(matrix([["A"], ["A"], ["A"]]), "d1").matrix;
    expect(column(next)).toEqual(["A", "B", "B"]);
  });

  it("un documento o firmante que no estan en la tabla no cambian nada", () => {
    const m = matrix([["A"], ["A"]]);
    expect(tap(m, "nope").matrix).toBe(m);
    expect(tap(m, "d1", "nadie").matrix).toBe(m);
  });

  it("recorrer todas las opciones de una celda vuelve al principio (ciclo cerrado)", () => {
    let m = matrix([["A"], ["A"], ["A"]]);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 6; i += 1) {
      m = tap(m, "d3").matrix;
      seen.push(m.cells[2][0]);
    }
    expect(seen).toEqual(["B", null, "A", "B", null, "A"]);
  });
});

describe("groupsInHalves — «Por grupos»", () => {
  it("4 documentos -> A A B B para todos los firmantes", () => {
    const m = matrix([["A", "A"], ["A", "A"], ["A", "A"], ["A", "A"]], D, ["s1", "s2"]);
    const next = groupsInHalves(m);
    expect(column(next, 0)).toEqual(["A", "A", "B", "B"]);
    expect(column(next, 1)).toEqual(["A", "A", "B", "B"]);
  });

  it("3 documentos -> la mitad mayor primero: A A B", () => {
    expect(column(groupsInHalves(matrix([["A"], ["A"], ["A"]])))).toEqual(["A", "A", "B"]);
  });

  it("5 documentos -> A A A B B; 2 documentos -> A B", () => {
    expect(column(groupsInHalves(matrix([["A"], ["A"], ["A"], ["A"], ["A"]], ["d1", "d2", "d3", "d4", "d5"])))).toEqual(["A", "A", "A", "B", "B"]);
    expect(column(groupsInHalves(matrix([["A"], ["A"]])))).toEqual(["A", "B"]);
  });
});

describe("signModeFor — el modo se deduce de la tabla", () => {
  it("un grupo por documento y sin celdas vacias es «independent»", () => {
    expect(signModeFor(matrix([["A"], ["B"], ["C"]]))).toBe("independent");
  });
  it("cualquier otra cosa es «same» (incluida una celda vacia, que `ensureBlocks` repararia en «independent»)", () => {
    expect(signModeFor(matrix([["A"], ["A"], ["A"]]))).toBe("same");
    expect(signModeFor(matrix([["A"], ["B"], [null]]))).toBe("same");
    expect(signModeFor(matrix([["A"], ["A"], ["B"]]))).toBe("same");
  });
  it("con un solo documento o sin firmantes es «same»", () => {
    expect(signModeFor(matrix([["A"]]))).toBe("same");
    expect(signModeFor({ docIds: D, signerIds: [], cells: [[], []] })).toBe("same");
  });
  it("con dos firmantes hace falta que AMBOS sean uno por documento", () => {
    expect(signModeFor(matrix([["A", "A"], ["B", "B"]], D.slice(0, 2), ["s1", "s2"]))).toBe("independent");
    expect(signModeFor(matrix([["A", "A"], ["B", "A"]], D.slice(0, 2), ["s1", "s2"]))).toBe("same");
  });
});

describe("copias", () => {
  const ids = ["d1", "d2", "d3"];
  const copies = { d1: 1, d2: 2, d3: 1 };

  it("copiesMap lee `copies` de cada documento (1 si no hay)", () => {
    expect(copiesMap({ d1: { ...EMPTY_DOC_STATE, copies: 3 }, d2: EMPTY_DOC_STATE }, ["d1", "d2", "d3"])).toEqual({ d1: 3, d2: 1, d3: 1 });
  });
  it("totalFiles suma las copias y uniformCopies dice si todas son iguales", () => {
    expect(totalFiles(copies, ids)).toBe(4);
    expect(uniformCopies(copies, ids)).toBeNull();
    expect(uniformCopies({ d1: 2, d2: 2, d3: 2 }, ids)).toBe(2);
    expect(uniformCopies({}, [])).toBeNull();
  });
  it("sube de 1 en 1 hasta 5 y despues dice que es el tope por documento", () => {
    expect(stepCopies({ d1: 1 }, ["d1"], "d1", 1)).toEqual({ value: 2, blocked: "none" });
    expect(stepCopies({ d1: 4 }, ["d1"], "d1", 1)).toEqual({ value: 5, blocked: "none" });
    expect(stepCopies({ d1: 5 }, ["d1"], "d1", 1)).toEqual({ value: 5, blocked: "perDocument" });
  });
  it("baja de 1 en 1 y no pasa de 1", () => {
    expect(stepCopies({ d1: 3 }, ["d1"], "d1", -1)).toEqual({ value: 2, blocked: "none" });
    expect(stepCopies({ d1: 1 }, ["d1"], "d1", -1)).toEqual({ value: 1, blocked: "none" });
  });
  it("no deja pasar de 50 archivos en total (10 documentos x 5 = exacto; uno mas, no)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `d${i}`);
    const full = Object.fromEntries(ten.map((id) => [id, 5]));
    expect(totalFiles(full, ten)).toBe(50);
    expect(stepCopies({ ...full, d0: 4 }, ten, "d0", 1)).toEqual({ value: 5, blocked: "none" });
    const eleven = [...ten, "d10"];
    expect(stepCopies({ ...full, d10: 1 }, eleven, "d10", 1)).toEqual({ value: 1, blocked: "totalFiles" });
  });
  it("«Copias de todos» parte del mayor numero y deja todos iguales", () => {
    const up = stepAllCopies(copies, ids, 1);
    expect(up).toEqual({ copies: { d1: 3, d2: 3, d3: 3 }, value: 3, blocked: "none" });
    const down = stepAllCopies(copies, ids, -1);
    expect(down.copies).toEqual({ d1: 1, d2: 1, d3: 1 });
    expect(stepAllCopies({ d1: 1, d2: 1, d3: 1 }, ids, -1).value).toBe(1);
  });
  it("«Copias de todos» respeta el tope por documento y el de 50 archivos", () => {
    expect(stepAllCopies({ d1: 5, d2: 5, d3: 5 }, ids, 1).blocked).toBe("perDocument");
    const eleven = Array.from({ length: 11 }, (_, i) => `d${i}`);
    const four = Object.fromEntries(eleven.map((id) => [id, 4]));
    // 11 x 5 = 55 > 50
    const blocked = stepAllCopies(four, eleven, 1);
    expect(blocked.blocked).toBe("totalFiles");
    expect(blocked.copies).toEqual(four);
    // 10 x 5 = 50 cabe.
    const ten = eleven.slice(0, 10);
    expect(stepAllCopies(Object.fromEntries(ten.map((id) => [id, 4])), ten, 1).value).toBe(5);
  });
});

describe("describeImpacts — lo que un cambio se llevaria", () => {
  const block = (id: string, appliesTo: string[], extra: Partial<SignerBlock> = {}): SignerBlock => ({
    id, signerId: "s1", appliesTo, signature: null, initials: null, stamps: {}, auto: false, ...extra,
  });
  const SIG = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.5 };

  it("un grupo con firma que desaparece sale como `lost` con su letra de ANTES y los documentos que perdia", () => {
    const before = [
      block("b1", ["d1"], { signature: SIG, stamps: { d1: "x" } }),
      block("b2", ["d2", "d3"], { signature: SIG, stamps: { d2: "y", d3: "z" } }),
    ];
    const target: AssignmentMatrix = { docIds: ["d1", "d2", "d3"], signerIds: ["s1"], cells: [["A"], ["A"], ["A"]] };
    const { impacts } = applyMatrix(before, target, [{ id: "s1" }]);
    const lines = describeImpacts(impacts, before, ["d1", "d2", "d3"], [{ id: "s1" }]);
    const lost = lines.find((line) => line.kind === "lost");
    // d1 (A) tenia su propia firma y pierde: el grupo que hereda es el de d2-d3 (B), que ya tiene la suya.
    expect(lost).toMatchObject({ signerId: "s1", group: "A", docs: 1, strokes: ["signature"] });
    expect(lines.find((line) => line.kind === "reconfirm")).toMatchObject({ group: "B", docs: 1 });
  });

  it("un grupo que crece sin sello para los documentos nuevos sale como `reconfirm` con cuantos son", () => {
    const before = [block("b1", ["d1", "d2"], { signature: SIG, stamps: { d1: "x", d2: "y" } }), block("b2", ["d3"])];
    const target: AssignmentMatrix = { docIds: ["d1", "d2", "d3"], signerIds: ["s1"], cells: [["A"], ["A"], ["A"]] };
    const { impacts } = applyMatrix(before, target, [{ id: "s1" }]);
    const lines = describeImpacts(impacts, before, ["d1", "d2", "d3"], [{ id: "s1" }]);
    expect(lines).toEqual([{ kind: "reconfirm", signerId: "s1", group: "A", docs: 1, strokes: ["signature"] }]);
  });

  it("un bloque que ya no esta en la cola de documentos se rotula «A» (nunca «undefined»)", () => {
    const before = [block("b1", ["d9"], { signature: SIG, stamps: { d9: "x" } })];
    const target: AssignmentMatrix = { docIds: ["d1"], signerIds: ["s1"], cells: [["A"]] };
    const { impacts } = applyMatrix(before, target, [{ id: "s1" }]);
    expect(describeImpacts(impacts, before, ["d1"], [{ id: "s1" }])).toEqual([
      { kind: "lost", signerId: "s1", group: "A", docs: 1, strokes: ["signature"] },
    ]);
  });

  it("sin trazos no hay nada que confirmar", () => {
    const before = [block("b1", ["d1"]), block("b2", ["d2"])];
    const target: AssignmentMatrix = { docIds: ["d1", "d2"], signerIds: ["s1"], cells: [["A"], ["A"]] };
    expect(describeImpacts(applyMatrix(before, target, [{ id: "s1" }]).impacts, before, ["d1", "d2"], [{ id: "s1" }])).toEqual([]);
    expect(groupsMatrix(before, ["d1", "d2"], [{ id: "s1" }]).cells).toEqual([["A"], ["B"]]);
  });
});

describe("groupDocsText — documentos de un grupo", () => {
  const docs = [
    { id: "d1", name: "Contrato.pdf" },
    { id: "d2", name: "Anexo.pdf" },
    { id: "d3", name: "Carta.pdf" },
    { id: "d4", name: "Acta.pdf" },
    { id: "d5", name: "Poder.pdf" },
    { id: "d6", name: "Nota.pdf" },
  ];
  it("nombra los documentos del grupo en el orden de la cola, sin `.pdf`", () => {
    expect(groupDocsText({ appliesTo: ["d2", "d1"] }, docs)).toBe("Contrato, Anexo");
  });
  it("con mas de cuatro resume el resto como «+N»", () => {
    expect(groupDocsText({ appliesTo: docs.map((doc) => doc.id) }, docs)).toBe("Contrato, Anexo, Carta, Acta +2");
    expect(groupDocsText({ appliesTo: ["d1", "d2", "d3", "d4"] }, docs)).toBe("Contrato, Anexo, Carta, Acta");
  });
});
