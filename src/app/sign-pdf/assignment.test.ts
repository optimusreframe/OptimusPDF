import { describe, expect, it } from "vitest";
import {
  allSameGroup,
  applyMatrix,
  blockGroups,
  blocksFromMatrix,
  byGroups,
  canonicalMatrix,
  groupDisplayName,
  groupIdAt,
  groupIndexOf,
  groupsMatrix,
  groupsOf,
  matrixEqual,
  nextGroup,
  oneGroupPerDocument,
  setCell,
  summarize,
  type AssignmentMatrix,
  type GroupId,
} from "@/app/sign-pdf/assignment";
import { addBlock, blockStampsValid } from "@/app/sign-pdf/blockModel";
import { captureStamp } from "@/app/sign-pdf/captures";
import {
  ensureBlocks,
  normalizeBlocks,
  setBlockScope,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";

/*
 * Tabla «¿Quien firma que?» (U1.1): ida y vuelta con los bloques SIN perdida, trazos que se conservan, atajos, resumen.
 * Las pruebas de propiedad usan un generador propio con semilla fija (el proyecto no trae fast-check): cada caso sale de
 * `mulberry32(seed)` y es reproducible. Cubren 1-10 documentos x 1-2 firmantes x grupos A..D.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rand: () => number, min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const docsOf = (n: number) => Array.from({ length: n }, (_, i) => `d${i + 1}`);
const SIGNERS = [{ id: "sg-1" }, { id: "sg-2" }];
const LABELS = ["A", "B", "C", "D"];
const SIG = { dataUrl: "data:image/png;base64,SIG1", ratio: 0.3 };
const SIG_B = { dataUrl: "data:image/png;base64,SIG2", ratio: 0.4 };
const INI = { dataUrl: "data:image/png;base64,INI1", ratio: 0.5 };

/** `blockStampsValid` con documentos sin huecos y las huellas dadas: lo que `captureStamp` sellaria. */
function blockStampsValidFor(b: SignerBlock, keys: Record<string, string>, signerId: string): boolean {
  return blockStampsValid(b, { signers: [{ id: signerId, name: "", color: "" }], docs: {}, keys });
}

function counterMint(prefix = "n") {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Tabla al azar: etiquetas A..D sin orden canonico y algun «no firma». */
function randomMatrix(rand: () => number, docs: string[], signerIds: string[], nulls = true): AssignmentMatrix {
  return {
    docIds: docs,
    signerIds,
    cells: docs.map(() =>
      signerIds.map(() => (nulls && rand() < 0.15 ? null : LABELS[int(rand, 0, LABELS.length - 1)])),
    ),
  };
}

function matrixOf(signerIds: string[], docs: string[], columns: (string | null)[][]): AssignmentMatrix {
  // `columns[col][row]`: mas legible al escribirlo a mano que `cells[row][col]`.
  return {
    docIds: docs,
    signerIds,
    cells: docs.map((_, row) => signerIds.map((__, col) => columns[col][row])),
  };
}

function block(
  id: string,
  signerId: string,
  appliesTo: string[],
  over: Partial<SignerBlock> = {},
): SignerBlock {
  return { id, signerId, appliesTo, signature: null, initials: null, stamps: {}, auto: false, ...over };
}

/** Los bloques sin ids: por firmante, el alcance de cada uno en orden y su `auto`. Es lo que debe sobrevivir al viaje. */
function shape(blocks: readonly SignerBlock[]) {
  return blocks
    .map((b) => ({ signerId: b.signerId, appliesTo: [...b.appliesTo], auto: b.auto }))
    .sort((a, b) => a.signerId.localeCompare(b.signerId) || a.appliesTo[0].localeCompare(b.appliesTo[0], undefined, { numeric: true }));
}

function expectInvariant(blocks: readonly SignerBlock[], docs: readonly string[]) {
  expect(normalizeBlocks(blocks, docs).warnings).toEqual([]);
  for (const b of blocks) {
    expect(b.appliesTo.length).toBeGreaterThan(0);
    const positions = b.appliesTo.map((id) => docs.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  }
}

describe("letras de grupo", () => {
  it("A..Z y despues AA, AB...", () => {
    expect([0, 1, 2, 25, 26, 27, 51, 52, 701, 702].map(groupIdAt)).toEqual([
      "A", "B", "C", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA",
    ]);
  });

  it("groupIndexOf es el inverso de groupIdAt y rechaza lo que no es una letra", () => {
    for (let i = 0; i < 800; i += 1) expect(groupIndexOf(groupIdAt(i))).toBe(i);
    expect(groupIndexOf("a")).toBe(-1);
    expect(groupIndexOf("")).toBe(-1);
    expect(groupIndexOf("A1")).toBe(-1);
  });

  it("groupDisplayName: «Firma A» / «Signature A» y nombre propio configurable", () => {
    expect(groupDisplayName("A", "es")).toBe("Firma A");
    expect(groupDisplayName("B", "en")).toBe("Signature B");
    expect(groupDisplayName("B", "es", { B: "  Firma de Luis  " })).toBe("Firma de Luis");
    expect(groupDisplayName("A", "es", { B: "otra" })).toBe("Firma A");
    expect(groupDisplayName("A", "es", { A: "   " })).toBe("Firma A");
  });
});

describe("groupsMatrix — de los bloques a la tabla", () => {
  it("el caso del usuario: 4 documentos, un firmante, A,A,B,B", () => {
    const docs = docsOf(4);
    const blocks = [
      block("bk-1", "sg-1", ["d1", "d2"]),
      block("bk-2", "sg-1", ["d3", "d4"]),
    ];
    const matrix = groupsMatrix(blocks, docs, [{ id: "sg-1" }]);
    expect(matrix.cells).toEqual([["A"], ["A"], ["B"], ["B"]]);
    expect(blockGroups(blocks, docs, [{ id: "sg-1" }])).toEqual({ "bk-1": "A", "bk-2": "B" });
  });

  it("«Mismas»: un bloque por firmante para todos = todo A; «Distintas»: A, B, C, D", () => {
    const docs = docsOf(4);
    const same = ensureBlocks(SIGNERS, docs, "same", [], counterMint());
    expect(groupsMatrix(same, docs, SIGNERS).cells).toEqual([
      ["A", "A"], ["A", "A"], ["A", "A"], ["A", "A"],
    ]);
    const independent = ensureBlocks(SIGNERS, docs, "independent", [], counterMint());
    expect(groupsMatrix(independent, docs, SIGNERS).cells).toEqual([
      ["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"],
    ]);
  });

  it("las letras son locales a cada firmante y salen por orden de aparicion, no de lista de bloques", () => {
    const docs = docsOf(3);
    // El bloque de los documentos 2 y 3 esta ANTES en la lista, pero la letra A es del que cubre el documento 1.
    const blocks = [
      block("bk-2", "sg-1", ["d2", "d3"]),
      block("bk-1", "sg-1", ["d1"]),
      block("bk-3", "sg-2", ["d2"]),
    ];
    const matrix = groupsMatrix(blocks, docs, SIGNERS);
    expect(matrix.cells).toEqual([["A", null], ["B", "A"], ["B", null]]);
  });

  it("un documento sin bloque es «no firma» y sin `signers` las columnas salen de los bloques", () => {
    const docs = docsOf(2);
    const matrix = groupsMatrix([block("bk-1", "sg-2", ["d2"])], docs);
    expect(matrix.signerIds).toEqual(["sg-2"]);
    expect(matrix.cells).toEqual([[null], ["A"]]);
  });

  it("ignora los documentos que ya no estan en la cola y acepta documentos como objetos", () => {
    const matrix = groupsMatrix(
      [block("bk-1", "sg-1", ["d1", "gone", "d2"])],
      [{ id: "d1" }, { id: "d2" }],
      [{ id: "sg-1" }],
    );
    expect(matrix.docIds).toEqual(["d1", "d2"]);
    expect(matrix.cells).toEqual([["A"], ["A"]]);
  });

  it("dato corrupto: dos bloques del mismo firmante reclaman un documento; gana el primero (como resolveBlock)", () => {
    const blocks = [block("bk-1", "sg-1", ["d1", "d2"]), block("bk-2", "sg-1", ["d2", "d3"])];
    const matrix = groupsMatrix(blocks, docsOf(3), [{ id: "sg-1" }]);
    expect(matrix.cells).toEqual([["A"], ["A"], ["B"]]);
  });
});

describe("canonicalMatrix, matrixEqual, groupsOf, nextGroup, setCell", () => {
  it("canonicaliza por columna por orden de aparicion y es idempotente", () => {
    const docs = docsOf(4);
    const raw = matrixOf(["sg-1", "sg-2"], docs, [
      ["C", "C", "A", null],
      ["D", "B", "D", "B"],
    ]);
    const canonical = canonicalMatrix(raw);
    expect(canonical.cells).toEqual([["A", "A"], ["A", "B"], ["B", "A"], [null, "B"]]);
    expect(matrixEqual(canonicalMatrix(canonical), canonical)).toBe(true);
    // No toca la entrada.
    expect(raw.cells[0]).toEqual(["C", "D"]);
  });

  it("matrixEqual distingue filas, columnas y celdas", () => {
    const a = matrixOf(["sg-1"], ["d1", "d2"], [["A", "B"]]);
    expect(matrixEqual(a, matrixOf(["sg-1"], ["d1", "d2"], [["A", "B"]]))).toBe(true);
    expect(matrixEqual(a, matrixOf(["sg-1"], ["d1", "d2"], [["A", "A"]]))).toBe(false);
    expect(matrixEqual(a, matrixOf(["sg-1"], ["d1", "d3"], [["A", "B"]]))).toBe(false);
    expect(matrixEqual(a, matrixOf(["sg-2"], ["d1", "d2"], [["A", "B"]]))).toBe(false);
    expect(matrixEqual(a, matrixOf(["sg-1"], ["d1"], [["A"]]))).toBe(false);
  });

  it("groupsOf lista los grupos y sus documentos; nextGroup da la primera letra libre", () => {
    const m = matrixOf(["sg-1"], docsOf(4), [["A", "B", "A", null]]);
    expect(groupsOf(m, "sg-1")).toEqual([
      { group: "A", docIds: ["d1", "d3"] },
      { group: "B", docIds: ["d2"] },
    ]);
    expect(groupsOf(m, "nadie")).toEqual([]);
    expect(nextGroup(m, "sg-1")).toBe("C");
    expect(nextGroup(matrixOf(["sg-1"], docsOf(2), [[null, null]]), "sg-1")).toBe("A");
  });

  it("setCell cambia una celda, canonicaliza y devuelve la MISMA tabla si no cambia nada", () => {
    const m = matrixOf(["sg-1"], docsOf(4), [["A", "A", "A", "A"]]);
    const split = setCell(m, "d3", "sg-1", nextGroup(m, "sg-1"));
    expect(split.cells).toEqual([["A"], ["A"], ["B"], ["A"]]);
    expect(setCell(m, "d3", "sg-1", "A")).toBe(m);
    expect(setCell(m, "zzz", "sg-1", "B")).toBe(m);
    expect(setCell(m, "d1", "zzz", "B")).toBe(m);
    expect(setCell(m, "d2", "sg-1", null).cells).toEqual([["A"], [null], ["A"], ["A"]]);
    // Poner la primera celda en un grupo nuevo hace que ESA pase a ser la «A» (la canonica sigue el orden de arriba abajo).
    expect(setCell(m, "d1", "sg-1", "Z").cells).toEqual([["A"], ["B"], ["B"], ["B"]]);
  });
});

describe("blocksFromMatrix — de la tabla a los bloques", () => {
  it("el caso del usuario: A,A,B,B para un firmante = 2 trazos (2 bloques) en UN turno", () => {
    const docs = docsOf(4);
    const matrix = matrixOf(["sg-1"], docs, [["A", "A", "B", "B"]]);
    const blocks = blocksFromMatrix(matrix, [{ id: "sg-1" }], { mint: counterMint() });
    expect(blocks).toEqual([
      block("n-1", "sg-1", ["d1", "d2"]),
      block("n-2", "sg-1", ["d3", "d4"]),
    ]);
  });

  it("el mismo caso con DOS firmantes: Ana A,A,B,B y Luis una firma para todos", () => {
    const docs = docsOf(4);
    const matrix = matrixOf(["sg-1", "sg-2"], docs, [
      ["A", "A", "B", "B"],
      ["A", "A", "A", "A"],
    ]);
    const blocks = blocksFromMatrix(matrix, SIGNERS, { mint: counterMint() });
    expect(blocks.map((b) => [b.signerId, b.appliesTo, b.auto])).toEqual([
      ["sg-1", ["d1", "d2"], false],
      ["sg-1", ["d3", "d4"], false],
      ["sg-2", ["d1", "d2", "d3", "d4"], true],
    ]);
    expectInvariant(blocks, docs);
    // Y vuelve a ser la misma tabla.
    expect(matrixEqual(groupsMatrix(blocks, docs, SIGNERS), matrix)).toBe(true);
  });

  it("`auto` solo con UN grupo que cubre todos los documentos (los nuevos se suman solos, como en «Mismas»)", () => {
    const all = blocksFromMatrix(matrixOf(["sg-1"], docsOf(3), [["A", "A", "A"]]), [{ id: "sg-1" }]);
    expect(all.map((b) => b.auto)).toEqual([true]);
    const partial = blocksFromMatrix(matrixOf(["sg-1"], docsOf(3), [["A", "A", null]]), [{ id: "sg-1" }]);
    expect(partial.map((b) => b.auto)).toEqual([false]);
    const two = blocksFromMatrix(matrixOf(["sg-1"], docsOf(3), [["A", "B", "A"]]), [{ id: "sg-1" }]);
    expect(two.map((b) => b.auto)).toEqual([false, false]);
  });

  it("los documentos de cada bloque salen en el orden de la cola y los bloques por firmante, en el orden de `signers`", () => {
    const matrix = matrixOf(["sg-1", "sg-2"], docsOf(3), [
      ["A", "B", "A"],
      ["A", "A", "B"],
    ]);
    const blocks = blocksFromMatrix(matrix, [{ id: "sg-2" }, { id: "sg-1" }], { mint: counterMint() });
    expect(blocks.map((b) => [b.signerId, b.appliesTo])).toEqual([
      ["sg-2", ["d1", "d2"]],
      ["sg-2", ["d3"]],
      ["sg-1", ["d1", "d3"]],
      ["sg-1", ["d2"]],
    ]);
  });

  it("una celda vacia no crea bloque; una tabla sin ninguna celda no crea ninguno", () => {
    const blocks = blocksFromMatrix(matrixOf(["sg-1"], docsOf(2), [[null, "A"]]), [{ id: "sg-1" }]);
    expect(blocks.map((b) => b.appliesTo)).toEqual([["d2"]]);
    expect(blocksFromMatrix(matrixOf(["sg-1"], docsOf(2), [[null, null]]), [{ id: "sg-1" }])).toEqual([]);
    expect(blocksFromMatrix({ docIds: [], signerIds: ["sg-1"], cells: [] }, [{ id: "sg-1" }])).toEqual([]);
  });

  it("tolera una tabla a medias (filas o celdas que faltan, etiquetas vacias): lo que falta es «no firma»", () => {
    const broken = {
      docIds: ["d1", "d2", "d3"],
      signerIds: ["sg-1"],
      cells: [["A"], [""], undefined as unknown as (string | null)[]],
    };
    const blocks = blocksFromMatrix(broken, [{ id: "sg-1" }]);
    expect(blocks.map((b) => b.appliesTo)).toEqual([["d1"]]);
  });

  it("un firmante que no esta en `signers` se ignora; uno de `signers` que no esta en la tabla no recibe bloques nuevos", () => {
    const matrix = matrixOf(["sg-1", "sg-2"], docsOf(2), [["A", "A"], ["A", "A"]]);
    expect(blocksFromMatrix(matrix, [{ id: "sg-1" }]).map((b) => b.signerId)).toEqual(["sg-1"]);
    expect(blocksFromMatrix(matrix, [{ id: "sg-1" }, { id: "sg-3" }]).map((b) => b.signerId)).toEqual(["sg-1"]);
  });

  it("usa `mint` solo para los bloques NUEVOS y por orden", () => {
    const previous = [block("bk-7", "sg-1", ["d1", "d2"])];
    const minted: string[] = [];
    const mint = () => {
      const id = `m-${minted.length + 1}`;
      minted.push(id);
      return id;
    };
    const matrix = matrixOf(["sg-1"], docsOf(4), [["A", "A", "B", "C"]]);
    const blocks = blocksFromMatrix(matrix, [{ id: "sg-1" }], { previous, mint });
    expect(blocks.map((b) => b.id)).toEqual(["bk-7", "m-1", "m-2"]);
    expect(minted).toEqual(["m-1", "m-2"]);
  });
});

describe("ida y vuelta sin perdida (propiedad, semilla fija)", () => {
  it("tabla -> bloques -> tabla = la tabla canonica; si ya era canonica, la misma (300 casos, 1-10 docs, 1-2 firmantes, A..D)", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = mulberry32(seed);
      const docs = docsOf(int(rand, 1, 10));
      const signers = SIGNERS.slice(0, int(rand, 1, 2));
      const signerIds = signers.map((s) => s.id);
      const raw = randomMatrix(rand, docs, signerIds);
      const blocks = blocksFromMatrix(raw, signers, { mint: counterMint() });
      expectInvariant(blocks, docs);
      const back = groupsMatrix(blocks, docs, signers);
      expect(matrixEqual(back, canonicalMatrix(raw))).toBe(true);
      // canonica en, canonica fuera: la propiedad de la letra.
      const canonical = canonicalMatrix(raw);
      expect(matrixEqual(groupsMatrix(blocksFromMatrix(canonical, signers), docs, signers), canonical)).toBe(true);
      // Un bloque por grupo distinto de cada columna, y ningun documento en dos.
      for (const signerId of signerIds) {
        const labels = new Set(groupsOf(raw, signerId).map((g) => g.group));
        expect(blocks.filter((b) => b.signerId === signerId)).toHaveLength(labels.size);
      }
    }
  });

  it("bloques -> tabla -> bloques: con los bloques de antes en `previous` salen IDENTICOS (ids, trazos, sellos y auto)", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = mulberry32(1000 + seed);
      const docs = docsOf(int(rand, 1, 10));
      const signers = SIGNERS.slice(0, int(rand, 1, 2));
      const raw = randomMatrix(rand, docs, signers.map((s) => s.id));
      // Bloques con trazos y sellos al azar (los sellos solo para sus documentos).
      const base = blocksFromMatrix(raw, signers, { mint: counterMint("bk") }).map((b, index) => ({
        ...b,
        signature: rand() < 0.7 ? { ...SIG, dataUrl: `${SIG.dataUrl}-${index}` } : null,
        initials: rand() < 0.4 ? INI : null,
        stamps: Object.fromEntries(b.appliesTo.filter(() => rand() < 0.8).map((id) => [id, `stamp-${id}-${index}`])),
        auto: rand() < 0.5,
      }));
      const matrix = groupsMatrix(base, docs, signers);
      const result = applyMatrix(base, matrix, signers, counterMint("zz"));
      expect(result.blocks).toEqual(base);
      expect(result.impacts).toEqual([]);
      // Sin `previous`: la misma forma (alcances), con ids nuevos y sin trazos.
      const fresh = blocksFromMatrix(matrix, signers, { mint: counterMint("zz") });
      expect(shape(fresh).map((b) => [b.signerId, b.appliesTo])).toEqual(shape(base).map((b) => [b.signerId, b.appliesTo]));
      expect(fresh.every((b) => !b.signature && !b.initials && Object.keys(b.stamps).length === 0)).toBe(true);
    }
  });

  it("bloques REALES de docSet (ensureBlocks + setBlockScope + addBlock): ida y vuelta identica y compatible con ensureBlocks", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(5000 + seed);
      const docs = docsOf(int(rand, 1, 10));
      const signers = SIGNERS.slice(0, int(rand, 1, 2));
      const mode = rand() < 0.5 ? "same" : "independent";
      let blocks = ensureBlocks(signers, docs, mode, [], counterMint("bk"));
      for (let step = 0; step < int(rand, 0, 5); step += 1) {
        const target = blocks[int(rand, 0, blocks.length - 1)];
        const scope = docs.filter(() => rand() < 0.5);
        if (scope.length > 0) blocks = setBlockScope(blocks, target.id, scope, docs).blocks;
        if (rand() < 0.3) {
          const added = addBlock(blocks, signers[int(rand, 0, signers.length - 1)].id, docs, undefined, counterMint(`ad${step}`));
          blocks = added.blocks;
        }
      }
      // Trazos al azar en algunos bloques.
      blocks = blocks.map((b, index) => (rand() < 0.5 ? { ...b, signature: SIG, stamps: { [b.appliesTo[0]]: `s-${index}` } } : b));

      const matrix = groupsMatrix(blocks, docs, signers);
      const back = blocksFromMatrix(matrix, signers, { previous: blocks, mint: counterMint("zz") });
      expect(shape(back)).toEqual(shape(blocks));
      for (const original of blocks) expect(back).toContainEqual(original);
      expect(back).toHaveLength(blocks.length);
      // Compatible con las invariantes de ensureBlocks: no hay que corregir nada (la misma lista) o, si la tabla dejo
      // documentos sin firmante, solo ANADE los bloques que faltan y no toca ninguno de los que hay.
      const ensured = ensureBlocks(signers, docs, "independent", back, counterMint("zz"));
      if (matrix.cells.flat().every((cell) => cell !== null)) expect(ensured).toBe(back);
      else for (const kept of back) expect(ensured).toContain(kept);
      expect(normalizeBlocks(back, docs).blocks).toBe(back);
    }
  });
});

describe("blocksFromMatrix — trazos y sellos al cambiar el alcance", () => {
  const docs = docsOf(4);
  const signers = [{ id: "sg-1" }];
  const stampsFor = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `stamp-${id}`]));

  it("si el conjunto de documentos de un grupo no cambia, su bloque queda intacto (mismo objeto)", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"], { signature: SIG, initials: INI, stamps: stampsFor(["d1", "d2"]), auto: true }),
      block("bk-2", "sg-1", ["d3", "d4"], { signature: SIG_B, stamps: stampsFor(["d3", "d4"]) }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "B", "B"]]), signers);
    expect(result.blocks[0]).toBe(previous[0]);
    expect(result.blocks[1]).toBe(previous[1]);
    expect(result.impacts).toEqual([]);
  });

  it("«Una firma para todos» -> separar d3 y d4: el grupo A conserva trazos y sellos de d1/d2; B es NUEVO y sin trazos", () => {
    const previous = [
      block("bk-1", "sg-1", docs, { signature: SIG, initials: INI, stamps: stampsFor(docs), auto: true }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "B", "B"]]), signers, counterMint());
    const [a, b] = result.blocks;
    expect(a).toMatchObject({ id: "bk-1", appliesTo: ["d1", "d2"], signature: SIG, initials: INI, auto: false });
    expect(a.stamps).toEqual(stampsFor(["d1", "d2"]));
    // Dos firmas distintas no pueden parecer la misma por un atajo: B no hereda el trazo de A.
    expect(b).toMatchObject({ id: "n-1", appliesTo: ["d3", "d4"], signature: null, initials: null, stamps: {}, auto: false });
    // Reducir el alcance no pierde nada: no hay nada que avisar.
    expect(result.impacts).toEqual([]);
  });

  it("agrandar el alcance conserva el trazo pero los documentos nuevos no traen sello: hay que confirmarlo", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"], { signature: SIG, stamps: stampsFor(["d1", "d2"]) }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", null]]), signers);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ id: "bk-1", appliesTo: ["d1", "d2", "d3"], signature: SIG });
    expect(result.blocks[0].stamps).toEqual(stampsFor(["d1", "d2"]));
    expect(result.impacts).toEqual([
      {
        signerId: "sg-1",
        blockId: "bk-1",
        types: ["signature"],
        outcome: "needsConfirm",
        before: ["d1", "d2"],
        after: ["d1", "d2", "d3"],
        docsToConfirm: ["d3"],
      },
    ]);
  });

  it("el sello de un documento nuevo del grupo NO vale: blockStampsValidFor lo detecta y los antiguos siguen valiendo", () => {
    const keys = { d1: "k1", d2: "k2", d3: "k3" };
    const fieldsOf = () => [] as never[];
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"], {
        signature: SIG,
        stamps: { d1: captureStamp("k1", fieldsOf(), "sg-1"), d2: captureStamp("k2", fieldsOf(), "sg-1") },
      }),
    ];
    expect(blockStampsValidFor(previous[0], keys, "sg-1")).toBe(true);
    const grown = applyMatrix(previous, matrixOf(["sg-1"], docsOf(3), [["A", "A", "A"]]), signers).blocks[0];
    expect(blockStampsValidFor(grown, keys, "sg-1")).toBe(false);
    const shrunk = applyMatrix(previous, matrixOf(["sg-1"], docsOf(3), [["A", null, null]]), signers).blocks[0];
    expect(blockStampsValidFor(shrunk, keys, "sg-1")).toBe(true);
  });

  it("unir A y B en un solo grupo: se queda con los trazos del bloque con mas documentos en comun (el primero en un empate) y el otro se PIERDE y se avisa", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"], { signature: SIG, stamps: stampsFor(["d1", "d2"]) }),
      block("bk-2", "sg-1", ["d3", "d4"], { signature: SIG_B, stamps: stampsFor(["d3", "d4"]) }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", "A"]]), signers);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ id: "bk-1", appliesTo: docs, signature: SIG, auto: true });
    expect(result.blocks[0].stamps).toEqual(stampsFor(["d1", "d2"]));
    expect(result.impacts).toEqual([
      {
        signerId: "sg-1",
        blockId: "bk-1",
        types: ["signature"],
        outcome: "needsConfirm",
        before: ["d1", "d2"],
        after: docs,
        docsToConfirm: ["d3", "d4"],
      },
      {
        signerId: "sg-1",
        blockId: "bk-2",
        types: ["signature"],
        outcome: "lost",
        before: ["d3", "d4"],
        after: [],
        docsToConfirm: [],
      },
    ]);
  });

  it("en un empate manda el bloque que SI tiene trazos, aunque este despues", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"]),
      block("bk-2", "sg-1", ["d3", "d4"], { signature: SIG_B, stamps: stampsFor(["d3", "d4"]) }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", "A"]]), signers);
    expect(result.blocks[0]).toMatchObject({ id: "bk-2", signature: SIG_B });
    // El bloque vacio que se descarta no tenia trazos: nada que avisar de el.
    expect(result.impacts.filter((i) => i.outcome === "lost")).toEqual([]);
  });

  it("con MAS documentos en comun gana ese bloque, aunque el otro tenga trazos", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1"], { signature: SIG }),
      block("bk-2", "sg-1", ["d2", "d3", "d4"], { signature: SIG_B }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", "A"]]), signers);
    expect(result.blocks[0]).toMatchObject({ id: "bk-2", signature: SIG_B });
    expect(result.impacts.find((i) => i.outcome === "lost")).toMatchObject({ blockId: "bk-1", types: ["signature"] });
  });

  it("las iniciales que le faltan al bloque que se queda se toman del bloque descartado (como switchMode) y entonces no se pierden", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"], { signature: SIG }),
      block("bk-2", "sg-1", ["d3", "d4"], { signature: SIG_B, initials: INI }),
    ];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", "A"]]), signers);
    expect(result.blocks[0]).toMatchObject({ id: "bk-1", signature: SIG, initials: INI });
    const lost = result.impacts.find((i) => i.outcome === "lost");
    // Solo la FIRMA de bk-2 se descarta (las iniciales se cedieron).
    expect(lost).toMatchObject({ blockId: "bk-2", types: ["signature"] });
  });

  it("si el bloque descartado cede todo lo que tenia, no se avisa de el", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d2"]),
      block("bk-2", "sg-1", ["d3", "d4"], { initials: INI }),
    ];
    // bk-2 (con trazos) hereda; bk-1 vacio no cede nada y no tiene nada que perder.
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", "A"]]), signers);
    expect(result.impacts.filter((i) => i.outcome === "lost")).toEqual([]);
  });

  it("un grupo sin ningun documento en comun con los bloques de antes es NUEVO; el trazo de antes se pierde y se avisa", () => {
    const previous = [block("bk-1", "sg-1", ["d1"], { signature: SIG, initials: INI, stamps: stampsFor(["d1"]) })];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [[null, "A", null, null]]), signers, counterMint());
    expect(result.blocks).toEqual([block("n-1", "sg-1", ["d2"])]);
    expect(result.impacts).toEqual([
      { signerId: "sg-1", blockId: "bk-1", types: ["signature", "initials"], outcome: "lost", before: ["d1"], after: [], docsToConfirm: [] },
    ]);
  });

  it("quitar a un firmante de todos los documentos (toda su columna a «no firma») pierde sus trazos con aviso", () => {
    const previous = [block("bk-1", "sg-1", docs, { signature: SIG, auto: true, stamps: stampsFor(docs) })];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [[null, null, null, null]]), signers);
    expect(result.blocks).toEqual([]);
    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0]).toMatchObject({ outcome: "lost", types: ["signature"] });
  });

  it("los sellos de documentos que ya no estan en la tabla se quitan del bloque que se queda", () => {
    const previous = [block("bk-1", "sg-1", ["d1", "d2", "gone"], { signature: SIG, stamps: stampsFor(["d1", "d2", "gone"]) })];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docsOf(2), [["A", "A"]]), signers);
    expect(result.blocks[0].appliesTo).toEqual(["d1", "d2"]);
    expect(result.blocks[0].stamps).toEqual(stampsFor(["d1", "d2"]));
    expect(result.impacts).toEqual([]);
  });

  it("un bloque con un documento REPETIDO en su alcance (dato sucio) no cuenta como identico: se rehace limpio", () => {
    const dirty = block("bk-1", "sg-1", ["d1", "d1", "d2"], { signature: SIG });
    const result = applyMatrix([dirty], matrixOf(["sg-1"], docsOf(2), [["A", "A"]]), signers);
    expect(result.blocks[0]).not.toBe(dirty);
    expect(result.blocks[0]).toMatchObject({ id: "bk-1", appliesTo: ["d1", "d2"], signature: SIG });
  });

  it("un trazo que cede un bloque descartado va a UN solo heredero, no a todos", () => {
    const previous = [
      block("bk-1", "sg-1", ["d1", "d4"], { signature: SIG }),
      block("bk-2", "sg-1", ["d2", "d5"], { signature: SIG_B }),
      block("bk-3", "sg-1", ["d3"], { initials: INI }),
    ];
    // Los dos primeros ENCOGEN (heredan) y el tercero desaparece: sus iniciales van al primero que las necesita.
    const result = applyMatrix(previous, matrixOf(["sg-1"], docsOf(5), [["A", "B", null, null, null]]), signers);
    expect(result.blocks.map((b) => [b.id, b.initials])).toEqual([["bk-1", INI], ["bk-2", null]]);
    expect(result.impacts).toEqual([]);
  });

  it("un bloque SIN trazos que crece no genera ningun aviso", () => {
    const previous = [block("bk-1", "sg-1", ["d1"])];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docsOf(3), [["A", "A", "A"]]), signers);
    expect(result.blocks[0]).toMatchObject({ id: "bk-1", appliesTo: ["d1", "d2", "d3"] });
    expect(result.impacts).toEqual([]);
  });

  it("los bloques de otro firmante no se tocan, aunque cambie el alcance de este", () => {
    const luis = block("bk-9", "sg-2", docs, { signature: SIG_B, auto: true });
    const previous = [block("bk-1", "sg-1", docs, { signature: SIG, auto: true }), luis];
    const result = applyMatrix(
      previous,
      matrixOf(["sg-1", "sg-2"], docs, [["A", "A", "B", "B"], ["A", "A", "A", "A"]]),
      SIGNERS,
      counterMint(),
    );
    expect(result.blocks.filter((b) => b.signerId === "sg-2")).toEqual([luis]);
    expect(result.blocks.find((b) => b.signerId === "sg-2")).toBe(luis);
  });

  it("un firmante que esta en `signers` pero no en la tabla conserva sus bloques; el que ya no esta en `signers` los pierde", () => {
    const keep = block("bk-3", "sg-2", docs, { signature: SIG });
    const gone = block("bk-4", "sg-3", docs, { signature: SIG });
    const previous = [block("bk-1", "sg-1", docs), keep, gone];
    const result = applyMatrix(previous, matrixOf(["sg-1"], docs, [["A", "A", "A", "A"]]), SIGNERS);
    expect(result.blocks.map((b) => b.id)).toEqual(["bk-1", "bk-3"]);
    expect(result.blocks[1]).toBe(keep);
  });

  it("blocksFromMatrix(previous) es applyMatrix(...).blocks", () => {
    const previous = [block("bk-1", "sg-1", docs, { signature: SIG, auto: true })];
    const matrix = matrixOf(["sg-1"], docs, [["A", "A", "B", "B"]]);
    expect(blocksFromMatrix(matrix, signers, { previous, mint: counterMint() })).toEqual(
      applyMatrix(previous, matrix, signers, counterMint()).blocks,
    );
  });
});

describe("atajos", () => {
  const docs = docsOf(4);
  const base = matrixOf(["sg-1", "sg-2"], docs, [
    ["A", "B", null, "C"],
    ["B", null, "B", "A"],
  ]);

  it("allSameGroup: todo A, tambien las celdas vacias (una firma para todos)", () => {
    const m = allSameGroup(base);
    expect(m.cells.flat().every((cell) => cell === "A")).toBe(true);
    expect(m.docIds).toEqual(docs);
    expect(m.signerIds).toEqual(["sg-1", "sg-2"]);
    // No toca la entrada.
    expect(base.cells[2][0]).toBeNull();
  });

  it("allSameGroup con keepEmpty respeta los «no firma»", () => {
    const m = allSameGroup(base, { keepEmpty: true });
    expect(m.cells).toEqual([["A", "A"], ["A", null], [null, "A"], ["A", "A"]]);
  });

  it("oneGroupPerDocument: un trazo por documento, A, B, C, D de arriba abajo", () => {
    expect(oneGroupPerDocument(base).cells).toEqual([["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"]]);
  });

  it("oneGroupPerDocument con keepEmpty: las letras siguen el orden de los que firman", () => {
    expect(oneGroupPerDocument(base, { keepEmpty: true }).cells).toEqual([
      ["A", "A"], ["B", null], [null, "B"], ["C", "C"],
    ]);
  });

  it("byGroups: [[d1,d2],[d3,d4]] -> A,A,B,B para todos los firmantes (el caso del usuario)", () => {
    const m = byGroups(base, [["d1", "d2"], ["d3", "d4"]]);
    expect(m.cells).toEqual([["A", "A"], ["A", "A"], ["B", "B"], ["B", "B"]]);
  });

  it("byGroups solo a algunos firmantes: el resto de columnas no cambia", () => {
    const m = byGroups(base, [["d1", "d2"], ["d3", "d4"]], { signerIds: ["sg-1"] });
    expect(m.cells.map((row) => row[0])).toEqual(["A", "A", "B", "B"]);
    expect(m.cells.map((row) => row[1])).toEqual(canonicalMatrix(base).cells.map((row) => row[1]));
  });

  it("byGroups: los documentos que no estan en ninguna lista conservan su agrupacion pero NO se mezclan con los grupos nuevos", () => {
    const m = byGroups(matrixOf(["sg-1"], docs, [["A", "A", "A", null]]), [["d1"], ["d2"]]);
    // d1 y d2 son grupos nuevos (A, B); d3 era «A» con ellos y se queda aparte (C); d4 sigue sin firmar.
    expect(m.cells).toEqual([["A"], ["B"], ["C"], [null]]);
  });

  it("byGroups: un documento repetido se queda con la primera lista; keepEmpty respeta los vacios", () => {
    const m = byGroups(base, [["d1", "d2"], ["d2", "d3"]], { keepEmpty: true });
    // d4 no esta en ninguna lista: conserva su agrupacion (sg-1 «C», sg-2 «A») pero aparte de los grupos nuevos.
    expect(m.cells).toEqual([["A", "A"], ["A", null], [null, "B"], ["B", "C"]]);
  });

  it("los atajos devuelven tablas canonicas y bloques validos", () => {
    for (const m of [allSameGroup(base), oneGroupPerDocument(base), byGroups(base, [["d1", "d3"], ["d2", "d4"]])]) {
      expect(matrixEqual(m, canonicalMatrix(m))).toBe(true);
      const blocks = blocksFromMatrix(m, SIGNERS, { mint: counterMint() });
      expectInvariant(blocks, docs);
      expect(matrixEqual(groupsMatrix(blocks, docs, SIGNERS), m)).toBe(true);
    }
  });
});

describe("summarize", () => {
  const docs = [
    { id: "d1", name: "Contrato.pdf" },
    { id: "d2", name: "Anexo.pdf" },
    { id: "d3", name: "Carta.pdf" },
    { id: "d4", name: "Autorizacion.pdf" },
  ];
  const signers = [
    { id: "sg-1", name: "Ana" },
    { id: "sg-2", name: " Luis " },
  ];
  // El ejemplo del plan: Ana firma los 4 con 2 firmas (A: Contrato, Anexo; B: Carta, Autorizacion); Luis 2 con 1 firma.
  const matrix = matrixOf(["sg-1", "sg-2"], docsOf(4), [
    ["A", "A", "B", "B"],
    ["A", "A", null, null],
  ]);

  it("quien firma cuantos documentos con cuantas firmas, y que grupo es cada una", () => {
    const summary = summarize(matrix, signers, docs, { d1: 2, d2: 2, d3: 2, d4: 2 });
    expect(summary.signers).toEqual([
      {
        signerId: "sg-1",
        name: "Ana",
        documentCount: 4,
        groupCount: 2,
        groups: [
          { group: "A", label: "Firma A", docIds: ["d1", "d2"], docNames: ["Contrato.pdf", "Anexo.pdf"] },
          { group: "B", label: "Firma B", docIds: ["d3", "d4"], docNames: ["Carta.pdf", "Autorizacion.pdf"] },
        ],
      },
      {
        signerId: "sg-2",
        name: "Luis",
        documentCount: 2,
        groupCount: 1,
        groups: [{ group: "A", label: "Firma A", docIds: ["d1", "d2"], docNames: ["Contrato.pdf", "Anexo.pdf"] }],
      },
    ]);
  });

  it("4 documentos x 2 copias = 8 archivos (ZIP), y dice cuales llevan copias", () => {
    const summary = summarize(matrix, signers, docs, { d1: 2, d2: 2, d3: 2, d4: 2 });
    expect(summary.documentCount).toBe(4);
    expect(summary.fileCount).toBe(8);
    expect(summary.deliversZip).toBe(true);
    expect(summary.exceedsFileLimit).toBe(false);
    expect(summary.copies.map((c) => [c.docId, c.name, c.copies])).toEqual([
      ["d1", "Contrato.pdf", 2], ["d2", "Anexo.pdf", 2], ["d3", "Carta.pdf", 2], ["d4", "Autorizacion.pdf", 2],
    ]);
  });

  it("sin copias: 4 archivos; un solo documento sin copias: PDF suelto; un documento con copias: ZIP", () => {
    expect(summarize(matrix, signers, docs).fileCount).toBe(4);
    expect(summarize(matrix, signers, docs).copies).toEqual([]);
    const one = matrixOf(["sg-1"], ["d1"], [["A"]]);
    expect(summarize(one, signers, docs).deliversZip).toBe(false);
    expect(summarize(one, signers, docs).fileCount).toBe(1);
    expect(summarize(one, signers, docs, { d1: 3 })).toMatchObject({ fileCount: 3, deliversZip: true });
  });

  it("las copias fuera de rango se llevan a 1..5 y pasar de 50 archivos lo marca", () => {
    const ten = docsOf(10);
    const big = matrixOf(["sg-1"], ten, [ten.map(() => "A")]);
    const named = ten.map((id) => ({ id, name: id }));
    const five = Object.fromEntries(ten.map((id) => [id, 5]));
    expect(summarize(big, signers, named, five)).toMatchObject({ fileCount: 50, exceedsFileLimit: false });
    expect(summarize(big, signers, named, { ...five, d1: 6 })).toMatchObject({ fileCount: 50, exceedsFileLimit: false });
    const eleven = [...ten, "d11"];
    const bigger = matrixOf(["sg-1"], eleven, [eleven.map(() => "A")]);
    const namedMore = eleven.map((id) => ({ id, name: id }));
    expect(summarize(bigger, signers, namedMore, { ...five, d11: 5 })).toMatchObject({ fileCount: 55, exceedsFileLimit: true });
    expect(summarize(big, signers, named, { d1: -3, d2: Number.NaN, d3: 99 }).fileCount).toBe(1 + 1 + 5 + 7);
  });

  it("etiquetas por idioma y nombres de grupo configurables", () => {
    const en = summarize(matrix, signers, docs, {}, { lang: "en" });
    expect(en.signers[0].groups.map((g) => g.label)).toEqual(["Signature A", "Signature B"]);
    const named = summarize(matrix, signers, docs, {}, { groupNames: { B: "Firma de cierre" } });
    expect(named.signers[0].groups.map((g) => g.label)).toEqual(["Firma A", "Firma de cierre"]);
  });

  it("documentos que nadie firma y firmantes que no estan en la lista", () => {
    const m = matrixOf(["sg-1", "sg-2"], docsOf(4), [["A", null, "A", null], ["A", null, null, null]]);
    expect(summarize(m, signers, docs).unassignedDocIds).toEqual(["d2", "d4"]);
    const onlyAna = summarize(m, [signers[0]], docs);
    expect(onlyAna.signers.map((s) => s.signerId)).toEqual(["sg-1"]);
  });

  it("resume la tabla canonica: etiquetas sueltas dan los mismos grupos", () => {
    const raw = matrixOf(["sg-1"], docsOf(4), [["C", "C", "A", "A"]]);
    const summary = summarize(raw, [signers[0]], docs);
    expect(summary.signers[0].groups.map((g) => [g.group, g.docIds])).toEqual([
      ["A", ["d1", "d2"]],
      ["B", ["d3", "d4"]],
    ]);
  });
});

describe("tipos auxiliares", () => {
  it("GroupId es una cadena", () => {
    const g: GroupId = groupIdAt(0);
    expect(g).toBe("A");
  });
});
