import { describe, expect, it } from "vitest";
import {
  EMPTY_DOC_STATE,
  applyCaptures,
  coverageIssues,
  docIdOf,
  docIdsOf,
  docStateOf,
  duplicateGroups,
  ensureBlocks,
  liveFields,
  migrateCaptures,
  nextActiveDoc,
  normalizeBlocks,
  projectCaptures,
  pruneDocs,
  reserveBlockIds,
  nextBlockId,
  resolveBlock,
  setBlockScope,
  switchMode,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import {
  captureStamp,
  isSignerComplete,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/captures";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#e5484d" };
const DRAFT_A = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const DRAFT_B = { dataUrl: "data:image/png;base64,BBBB", ratio: 0.4 };
const INITIALS = { dataUrl: "data:image/png;base64,IIII", ratio: 0.5 };

/** Contador propio: los ids de los bloques de cada prueba son predecibles. */
function minter(): () => string {
  let n = 100;
  return () => `bk-${(n += 1)}`;
}

function field(id: string, signerId: string): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function block(over: Partial<SignerBlock> & Pick<SignerBlock, "id" | "signerId">): SignerBlock {
  return {
    appliesTo: [],
    signature: null,
    initials: null,
    stamps: {},
    auto: false,
    ...over,
  };
}

describe("docIdOf — src/app/sign-pdf/docSet.ts", () => {
  it("es estable para el mismo File y distinto para dos Files, aunque sean identicos", () => {
    const a = new File([new Uint8Array([1])], "a.pdf");
    const b = new File([new Uint8Array([1])], "a.pdf");
    expect(docIdOf(a)).toBe(docIdOf(a));
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });

  it("no depende de la huella ni del contenido: tiene forma doc-N", () => {
    expect(docIdOf(new File([], "x.pdf"))).toMatch(/^doc-\d+$/);
  });

  it("docIdsOf conserva el orden de la cola", () => {
    const files = [new File([], "1.pdf"), new File([], "2.pdf"), new File([], "3.pdf")];
    expect(docIdsOf(files)).toEqual(files.map(docIdOf));
    expect(docIdsOf([...files].reverse())).toEqual(files.map(docIdOf).reverse());
  });
});

describe("bloques — ids", () => {
  it("nextBlockId da ids bk-N distintos y reserveBlockIds evita repetir los restaurados", () => {
    reserveBlockIds(["bk-500", "bk-7", "otro"]);
    const next = nextBlockId();
    expect(next).toMatch(/^bk-\d+$/);
    expect(Number(next.slice(3))).toBeGreaterThan(500);
    expect(nextBlockId()).not.toBe(next);
  });
});

describe("ensureBlocks", () => {
  it("'same': un bloque automatico por firmante que cubre todos los documentos", () => {
    const blocks = ensureBlocks([ANA, LUIS], ["d1", "d2"], "same", [], minter());
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.signerId)).toEqual(["sg-1", "sg-2"]);
    for (const b of blocks) {
      expect(b.appliesTo).toEqual(["d1", "d2"]);
      expect(b.auto).toBe(true);
      expect(b.signature).toBeNull();
    }
  });

  it("'independent': un bloque por (firmante, documento)", () => {
    const blocks = ensureBlocks([ANA, LUIS], ["d1", "d2"], "independent", [], minter());
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b.appliesTo.length === 1 && !b.auto)).toBe(true);
    expect(blocks.filter((b) => b.signerId === "sg-1").map((b) => b.appliesTo[0])).toEqual(["d1", "d2"]);
  });

  it("es idempotente: si ya esta coherente devuelve la MISMA lista", () => {
    const first = ensureBlocks([ANA], ["d1", "d2"], "same", [], minter());
    expect(ensureBlocks([ANA], ["d1", "d2"], "same", first, minter())).toBe(first);
    const indep = ensureBlocks([ANA], ["d1", "d2"], "independent", [], minter());
    expect(ensureBlocks([ANA], ["d1", "d2"], "independent", indep, minter())).toBe(indep);
  });

  it("un documento nuevo se suma solo al bloque automatico", () => {
    const first = ensureBlocks([ANA], ["d1"], "same", [], minter());
    const grown = ensureBlocks([ANA], ["d1", "d2", "d3"], "same", first, minter());
    expect(grown).toHaveLength(1);
    expect(grown[0].appliesTo).toEqual(["d1", "d2", "d3"]);
    expect(grown[0].id).toBe(first[0].id);
  });

  it("si el bloque ya no es automatico, el documento nuevo queda con hueco", () => {
    const manual = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], auto: false })];
    const next = ensureBlocks([ANA], ["d1", "d2"], "same", manual, minter());
    expect(next[0].appliesTo).toEqual(["d1"]);
    expect(resolveBlock(next, "sg-1", "d2").block).toBeNull();
  });

  it("quita los bloques de firmantes que ya no estan", () => {
    const blocks = ensureBlocks([ANA, LUIS], ["d1"], "same", [], minter());
    const next = ensureBlocks([ANA], ["d1"], "same", blocks, minter());
    expect(next.map((b) => b.signerId)).toEqual(["sg-1"]);
  });

  it("poda del alcance los documentos quitados, con sus sellos, y descarta bloques vacios", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], stamps: { d1: "s1", d2: "s2" }, auto: true, signature: DRAFT_A }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d3"], auto: false }),
    ];
    const next = ensureBlocks([ANA], ["d2"], "same", blocks, minter());
    expect(next).toHaveLength(1);
    expect(next[0].appliesTo).toEqual(["d2"]);
    expect(next[0].stamps).toEqual({ d2: "s2" });
    expect(next[0].signature).toEqual(DRAFT_A);
  });

  it("sin documentos cargados no poda nada (no es 'borra todo')", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A })];
    expect(ensureBlocks([ANA], [], "same", blocks, minter())).toBe(blocks);
  });

  it("'independent' crea solo los bloques que faltan", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A })];
    const next = ensureBlocks([ANA], ["d1", "d2"], "independent", blocks, minter());
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(blocks[0]);
    expect(next[1].appliesTo).toEqual(["d2"]);
  });

  it("mantiene el orden de la cola al sumar documentos", () => {
    const first = ensureBlocks([ANA], ["d2", "d3"], "same", [], minter());
    const next = ensureBlocks([ANA], ["d1", "d2", "d3"], "same", first, minter());
    expect(next[0].appliesTo).toEqual(["d1", "d2", "d3"]);
  });
});

describe("resolveBlock", () => {
  const blocks = [
    block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"] }),
    block({ id: "bk-2", signerId: "sg-2", appliesTo: ["d1"] }),
  ];

  it("encuentra el bloque del firmante para el documento", () => {
    expect(resolveBlock(blocks, "sg-1", "d2")).toEqual({ block: blocks[0], ambiguous: false });
    expect(resolveBlock(blocks, "sg-2", "d1").block?.id).toBe("bk-2");
  });

  it("sin bloque que lo cubra: null", () => {
    expect(resolveBlock(blocks, "sg-2", "d2")).toEqual({ block: null, ambiguous: false });
    expect(resolveBlock(blocks, "nadie", "d1").block).toBeNull();
  });

  it("si hay mas de uno, gana el primero y avisa", () => {
    const dup = [
      block({ id: "bk-9", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-8", signerId: "sg-1", appliesTo: ["d1"] }),
    ];
    const result = resolveBlock(dup, "sg-1", "d1");
    expect(result.block?.id).toBe("bk-9");
    expect(result.ambiguous).toBe(true);
    // Determinista: el mismo resultado siempre.
    expect(resolveBlock(dup, "sg-1", "d1").block?.id).toBe("bk-9");
  });
});

describe("setBlockScope — invariante: un documento, a lo sumo un bloque por firmante", () => {
  it("al marcar un documento en otro bloque, se lo quita al anterior y lo cuenta", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], stamps: { d1: "a", d2: "b" }, auto: true }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d3"] }),
    ];
    const result = setBlockScope(blocks, "bk-2", ["d2", "d3"]);
    expect(result.moved).toEqual([{ docId: "d2", fromBlockId: "bk-1", toBlockId: "bk-2" }]);
    const first = result.blocks.find((b) => b.id === "bk-1");
    const second = result.blocks.find((b) => b.id === "bk-2");
    expect(first?.appliesTo).toEqual(["d1"]);
    expect(first?.stamps).toEqual({ d1: "a" });
    expect(second?.appliesTo).toEqual(["d2", "d3"]);
    expect(second?.auto).toBe(false);
  });

  it("no toca a los bloques de otro firmante", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-2", signerId: "sg-2", appliesTo: ["d1"] }),
      block({ id: "bk-3", signerId: "sg-1", appliesTo: ["d2"] }),
    ];
    const result = setBlockScope(blocks, "bk-3", ["d2", "d1"]);
    expect(result.moved).toHaveLength(1);
    expect(result.blocks.find((b) => b.id === "bk-2")?.appliesTo).toEqual(["d1"]);
  });

  it("retira el bloque que se queda sin documentos y lo informa", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d2"] }),
    ];
    const result = setBlockScope(blocks, "bk-2", ["d1", "d2"]);
    expect(result.removed).toEqual(["bk-1"]);
    expect(result.blocks.map((b) => b.id)).toEqual(["bk-2"]);
  });

  it("al dejar un documento fuera del alcance, ese documento queda con hueco", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], auto: true })];
    const result = setBlockScope(blocks, "bk-1", ["d1"]);
    expect(resolveBlock(result.blocks, "sg-1", "d2").block).toBeNull();
    expect(result.moved).toEqual([]);
  });

  it("un alcance vacio o un bloque inexistente no cambian nada", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] })];
    expect(setBlockScope(blocks, "bk-1", []).blocks).toBe(blocks);
    expect(setBlockScope(blocks, "bk-404", ["d1"]).blocks).toBe(blocks);
  });

  it("respeta el orden de la cola si se le da", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] })];
    const result = setBlockScope(blocks, "bk-1", ["d3", "d1", "d2"], ["d1", "d2", "d3"]);
    expect(result.blocks[0].appliesTo).toEqual(["d1", "d2", "d3"]);
  });

  it("tras cualquier cambio, ningun documento queda en dos bloques del mismo firmante", () => {
    let blocks = ensureBlocks([ANA, LUIS], ["d1", "d2", "d3"], "independent", [], minter());
    const target = blocks.find((b) => b.signerId === "sg-1" && b.appliesTo[0] === "d1")!;
    blocks = setBlockScope(blocks, target.id, ["d1", "d2", "d3"]).blocks;
    for (const signerId of ["sg-1", "sg-2"]) {
      for (const doc of ["d1", "d2", "d3"]) {
        const owners = blocks.filter((b) => b.signerId === signerId && b.appliesTo.includes(doc));
        expect(owners.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("normalizeBlocks", () => {
  it("sin conflictos devuelve la misma lista y ningun aviso", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] })];
    const result = normalizeBlocks(blocks);
    expect(result.blocks).toBe(blocks);
    expect(result.warnings).toEqual([]);
  });

  it("un borrador corrupto con un documento en dos bloques: gana el primero y avisa", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d1", "d2"], stamps: { d1: "x", d2: "y" } }),
    ];
    const result = normalizeBlocks(blocks);
    expect(result.warnings).toEqual([
      { signerId: "sg-1", docId: "d1", keptBlockId: "bk-1", droppedBlockId: "bk-2" },
    ]);
    expect(result.blocks[1].appliesTo).toEqual(["d2"]);
    expect(result.blocks[1].stamps).toEqual({ d2: "y" });
  });

  it("descarta el bloque que se queda sin nada", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d1"] }),
    ];
    expect(normalizeBlocks(blocks).blocks.map((b) => b.id)).toEqual(["bk-1"]);
  });

  it("el mismo documento en bloques de firmantes distintos NO es conflicto", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-2", signerId: "sg-2", appliesTo: ["d1"] }),
    ];
    expect(normalizeBlocks(blocks).warnings).toEqual([]);
  });

  it("deduplica el mismo documento repetido DENTRO de un bloque, sin aviso (no es un conflicto)", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d1", "d2", "d1"], stamps: { d1: "x" } })];
    const result = normalizeBlocks(blocks);
    expect(result.blocks[0].appliesTo).toEqual(["d1", "d2"]);
    expect(result.blocks[0].stamps).toEqual({ d1: "x" });
    expect(result.warnings).toEqual([]);
    expect(result.blocks).not.toBe(blocks);
  });

  it("con el contexto conocido descarta los documentos inexistentes y sus sellos", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "fantasma"], stamps: { d1: "x", fantasma: "y" } }),
    ];
    const result = normalizeBlocks(blocks, ["d1", "d2"]);
    expect(result.blocks[0].appliesTo).toEqual(["d1"]);
    expect(result.blocks[0].stamps).toEqual({ d1: "x" });
    expect(result.warnings).toEqual([]);
  });

  it("un bloque que solo reclamaba documentos inexistentes desaparece", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["fantasma"] })];
    expect(normalizeBlocks(blocks, ["d1"]).blocks).toEqual([]);
  });

  it("sin contexto conocido no descarta ningun id; con todo conocido devuelve la misma lista", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "zz"] })];
    expect(normalizeBlocks(blocks).blocks).toBe(blocks);
    expect(normalizeBlocks(blocks, ["d1", "zz"]).blocks).toBe(blocks);
  });
});

describe("coverageIssues", () => {
  const docs = {
    d1: { fields: [field("f1", "sg-1"), field("f2", "sg-2")] },
    d2: { fields: [field("f3", "sg-1")] },
  };

  it("sin huecos de cobertura: lista vacia", () => {
    const blocks = ensureBlocks([ANA, LUIS], ["d1", "d2"], "same", [], minter());
    expect(coverageIssues([ANA, LUIS], ["d1", "d2"], docs, blocks)).toEqual([]);
  });

  it("firmante con huecos en un documento y sin bloque que lo cubra", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] }),
      block({ id: "bk-2", signerId: "sg-2", appliesTo: ["d1"] }),
    ];
    expect(coverageIssues([ANA, LUIS], ["d1", "d2"], docs, blocks)).toEqual([
      { signerId: "sg-1", docId: "d2" },
    ]);
  });

  it("un firmante sin huecos en ese documento no genera aviso aunque no tenga bloque", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"] })];
    expect(coverageIssues([ANA, LUIS], ["d1", "d2"], docs, blocks)).toEqual([
      { signerId: "sg-2", docId: "d1" },
    ]);
  });

  it("ordena por documento y, dentro, por firmante", () => {
    const issues = coverageIssues([ANA, LUIS], ["d1", "d2"], docs, []);
    expect(issues).toEqual([
      { signerId: "sg-1", docId: "d1" },
      { signerId: "sg-2", docId: "d1" },
      { signerId: "sg-1", docId: "d2" },
    ]);
  });

  it("un documento sin estado se trata como sin huecos", () => {
    expect(coverageIssues([ANA], ["dX"], docs, [])).toEqual([]);
  });
});

describe("projectCaptures / applyCaptures", () => {
  it("proyecta el CaptureMap de siempre para UN documento, con el sello de ese documento", () => {
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], signature: DRAFT_A, initials: INITIALS, stamps: { d1: "s1", d2: "s2" } }),
    ];
    expect(projectCaptures(blocks, "d1")).toEqual({
      "sg-1": { signature: DRAFT_A, initials: INITIALS, stamp: "s1" },
    });
    expect(projectCaptures(blocks, "d2")["sg-1"].stamp).toBe("s2");
  });

  it("un bloque sin trazo ni sello no aparece (el CaptureMap vacio de antes)", () => {
    const blocks = ensureBlocks([ANA], ["d1"], "same", [], minter());
    expect(projectCaptures(blocks, "d1")).toEqual({});
  });

  it("documento sin sello en el bloque: la captura llega con sello vacio y validCapture no la da por buena", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], signature: DRAFT_A, stamps: { d1: captureStamp("k1", [field("f1", "sg-1")], "sg-1") } })];
    const projected = projectCaptures(blocks, "d2");
    expect(projected["sg-1"].stamp).toBe("");
    expect(validCapture(projected, [field("f1", "sg-1")], "sg-1", "k2").signature).toBeNull();
  });

  it("los flujos existentes (pendingSigners, isSignerComplete) funcionan igual sobre la proyeccion", () => {
    const fields = [field("f1", "sg-1")];
    const stamp = captureStamp("k1", fields, "sg-1");
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A, stamps: { d1: stamp } })];
    const captures = projectCaptures(blocks, "d1");
    expect(isSignerComplete(fields, captures, "sg-1", "k1")).toBe(true);
    expect(pendingSigners([ANA], fields, captures, "k1")).toHaveLength(0);
    expect(pendingSigners([ANA], fields, captures, "otra-huella")).toHaveLength(1);
  });

  it("applyCaptures vuelca una captura nueva en el bloque y su sello en SU documento", () => {
    const blocks = ensureBlocks([ANA], ["d1", "d2"], "same", [], minter());
    const next: CaptureMap = { "sg-1": { signature: DRAFT_A, initials: null, stamp: "s-d1" } };
    const updated = applyCaptures(blocks, "d1", next);
    expect(updated[0].signature).toEqual(DRAFT_A);
    expect(updated[0].stamps).toEqual({ d1: "s-d1" });
    // Round trip.
    expect(projectCaptures(updated, "d1")).toEqual(next);
  });

  it("applyCaptures no cambia nada (misma referencia) si la captura es igual por valor", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A, stamps: { d1: "s" } })];
    const same: CaptureMap = { "sg-1": { signature: { ...DRAFT_A }, initials: null, stamp: "s" } };
    expect(applyCaptures(blocks, "d1", same)).toBe(blocks);
  });

  it("captura que desaparece: borra el sello de ese documento y, en un bloque de un solo documento, los trazos", () => {
    const solo = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A, stamps: { d1: "s" } })];
    const cleared = applyCaptures(solo, "d1", {});
    expect(cleared[0].signature).toBeNull();
    expect(cleared[0].stamps).toEqual({});
  });

  it("captura que desaparece en un bloque compartido: los trazos se quedan para los demas documentos", () => {
    const shared = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], signature: DRAFT_A, stamps: { d1: "s1", d2: "s2" } })];
    const cleared = applyCaptures(shared, "d1", {});
    expect(cleared[0].signature).toEqual(DRAFT_A);
    expect(cleared[0].stamps).toEqual({ d2: "s2" });
  });

  it("ignora un firmante sin bloque para ese documento", () => {
    const blocks = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"] })];
    const next: CaptureMap = { "sg-2": { signature: DRAFT_A, initials: null, stamp: "s" } };
    expect(applyCaptures(blocks, "d1", next)).toBe(blocks);
  });

  it("en 'independent' cada documento guarda su propio trazo sin pisar a los otros", () => {
    let blocks = ensureBlocks([ANA], ["d1", "d2"], "independent", [], minter());
    blocks = applyCaptures(blocks, "d1", { "sg-1": { signature: DRAFT_A, initials: null, stamp: "s1" } });
    blocks = applyCaptures(blocks, "d2", { "sg-1": { signature: DRAFT_B, initials: null, stamp: "s2" } });
    expect(projectCaptures(blocks, "d1")["sg-1"].signature).toEqual(DRAFT_A);
    expect(projectCaptures(blocks, "d2")["sg-1"].signature).toEqual(DRAFT_B);
  });
});

describe("migrateCaptures — borradores v1", () => {
  it("cada captura pasa a un bloque automatico de ese documento con su sello", () => {
    const captures: CaptureMap = {
      "sg-1": { signature: DRAFT_A, initials: INITIALS, stamp: "huella-v1" },
      "sg-2": { signature: null, initials: null, stamp: "" },
    };
    const blocks = migrateCaptures(captures, "d1", minter());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      signerId: "sg-1",
      appliesTo: ["d1"],
      signature: DRAFT_A,
      initials: INITIALS,
      stamps: { d1: "huella-v1" },
      auto: true,
    });
  });

  it("v1 -> bloques -> proyeccion devuelve el mismo CaptureMap", () => {
    const captures: CaptureMap = {
      "sg-1": { signature: DRAFT_A, initials: null, stamp: "s" },
    };
    expect(projectCaptures(migrateCaptures(captures, "d1", minter()), "d1")).toEqual(captures);
  });

  it("un CaptureMap vacio no crea bloques", () => {
    expect(migrateCaptures({}, "d1", minter())).toEqual([]);
  });
});

describe("switchMode", () => {
  it("Mismas -> Distintas conserva los trazos en cada documento y reparte los sellos", () => {
    const same = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], signature: DRAFT_A, initials: INITIALS, stamps: { d1: "s1", d2: "s2" }, auto: true }),
    ];
    const result = switchMode(same, [ANA], ["d1", "d2"], "independent", minter());
    expect(result.discarded).toEqual([]);
    expect(result.blocks).toHaveLength(2);
    const [first, second] = result.blocks;
    expect(first.id).toBe("bk-1");
    expect(first.appliesTo).toEqual(["d1"]);
    expect(first.stamps).toEqual({ d1: "s1" });
    expect(second.appliesTo).toEqual(["d2"]);
    expect(second.stamps).toEqual({ d2: "s2" });
    expect(second.signature).toEqual(DRAFT_A);
    expect(result.blocks.every((b) => !b.auto)).toBe(true);
  });

  it("Mismas -> Distintas con los ids de los bloques nuevos distintos entre si", () => {
    const same = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2", "d3"], auto: true })];
    const ids = switchMode(same, [ANA], ["d1", "d2", "d3"], "independent", minter()).blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("Distintas -> Mismas fusiona en un bloque automatico con todos los documentos", () => {
    const independent = ensureBlocks([ANA], ["d1", "d2"], "independent", [], minter());
    const result = switchMode(independent, [ANA], ["d1", "d2"], "same", minter());
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].appliesTo).toEqual(["d1", "d2"]);
    expect(result.blocks[0].auto).toBe(true);
    expect(result.discarded).toEqual([]);
  });

  it("Distintas -> Mismas: se queda con el primer trazo y devuelve lo descartado para 'Deshacer'", () => {
    const independent = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A, stamps: { d1: "s1" } }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d2"], signature: DRAFT_B, stamps: { d2: "s2" } }),
    ];
    const result = switchMode(independent, [ANA], ["d1", "d2"], "same", minter());
    expect(result.blocks[0].signature).toEqual(DRAFT_A);
    expect(result.discarded.map((b) => b.id)).toEqual(["bk-2"]);
    // El sello de d2 se descarta: ese documento no ha visto ESTE trazo.
    expect(result.blocks[0].stamps).toEqual({ d1: "s1" });
  });

  it("Distintas -> Mismas: trazos iguales conservan todos los sellos y no hay nada que deshacer", () => {
    const independent = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A, stamps: { d1: "s1" } }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d2"], signature: { ...DRAFT_A }, stamps: { d2: "s2" } }),
    ];
    const result = switchMode(independent, [ANA], ["d1", "d2"], "same", minter());
    expect(result.discarded).toEqual([]);
    expect(result.blocks[0].stamps).toEqual({ d1: "s1", d2: "s2" });
  });

  it("Distintas -> Mismas completa las iniciales con las del primer bloque que las tenga", () => {
    const independent = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1"], signature: DRAFT_A }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: ["d2"], initials: INITIALS }),
    ];
    const merged = switchMode(independent, [ANA], ["d1", "d2"], "same", minter()).blocks[0];
    expect(merged.signature).toEqual(DRAFT_A);
    expect(merged.initials).toEqual(INITIALS);
  });

  it("cada firmante se fusiona por separado", () => {
    const independent = ensureBlocks([ANA, LUIS], ["d1", "d2"], "independent", [], minter());
    const merged = switchMode(independent, [ANA, LUIS], ["d1", "d2"], "same", minter()).blocks;
    expect(merged.map((b) => b.signerId).sort()).toEqual(["sg-1", "sg-2"]);
  });

  it("ida y vuelta Mismas -> Distintas -> Mismas no pierde el trazo", () => {
    const same = [block({ id: "bk-1", signerId: "sg-1", appliesTo: ["d1", "d2"], signature: DRAFT_A, stamps: { d1: "s1", d2: "s2" }, auto: true })];
    const split = switchMode(same, [ANA], ["d1", "d2"], "independent", minter());
    const back = switchMode(split.blocks, [ANA], ["d1", "d2"], "same", minter());
    expect(back.discarded).toEqual([]);
    expect(back.blocks[0].signature).toEqual(DRAFT_A);
    expect(back.blocks[0].stamps).toEqual({ d1: "s1", d2: "s2" });
    expect(back.blocks[0].appliesTo).toEqual(["d1", "d2"]);
  });

  it("firmantes sin bloques reciben los suyos al cambiar de modo", () => {
    const result = switchMode([], [ANA], ["d1", "d2"], "independent", minter());
    expect(result.blocks).toHaveLength(2);
    expect(switchMode([], [ANA], ["d1", "d2"], "same", minter()).blocks).toHaveLength(1);
  });
});

describe("estado por documento — utilidades", () => {
  it("docStateOf devuelve el estado en blanco para un documento sin entrada", () => {
    expect(docStateOf({}, "dX")).toBe(EMPTY_DOC_STATE);
    const state: DocState = { ...EMPTY_DOC_STATE, sealedKey: "k" };
    expect(docStateOf({ d1: state }, "d1")).toBe(state);
  });

  it("pruneDocs quita lo de documentos que ya no estan y devuelve el mismo objeto si no hay nada que quitar", () => {
    const docs = { d1: EMPTY_DOC_STATE, d2: EMPTY_DOC_STATE };
    expect(pruneDocs(docs, ["d1", "d2", "d3"])).toBe(docs);
    expect(Object.keys(pruneDocs(docs, ["d2"]))).toEqual(["d2"]);
  });

  it("liveFields oculta los huecos de firmantes quitados, y es la MISMA lista si no oculta nada", () => {
    const fields = [field("f1", "sg-1"), field("f2", "sg-2")];
    expect(liveFields({ fields }, [ANA, LUIS])).toBe(fields);
    expect(liveFields({ fields }, [ANA]).map((f) => f.id)).toEqual(["f1"]);
  });

  it("nextActiveDoc: se queda si sigue, pasa al vecino si se quito, null sin documentos", () => {
    expect(nextActiveDoc(["a", "b", "c"], ["a", "b", "c"], "b")).toBe("b");
    expect(nextActiveDoc(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(nextActiveDoc(["a", "b", "c"], ["a", "b"], "c")).toBe("b");
    expect(nextActiveDoc(["a"], [], "a")).toBeNull();
    expect(nextActiveDoc([], ["x", "y"], null)).toBe("x");
    expect(nextActiveDoc(["a"], ["x", "y"], "a")).toBe("x");
  });
});

describe("duplicateGroups", () => {
  it("agrupa los documentos con la misma huella (copias identicas)", () => {
    expect(duplicateGroups({ d1: "h1", d2: "h2", d3: "h1" })).toEqual([["d1", "d3"]]);
  });

  it("ignora los que aun no tienen huella y los unicos", () => {
    expect(duplicateGroups({ d1: null, d2: null, d3: "h" })).toEqual([]);
  });

  it("respeta el orden de la cola si se le da", () => {
    expect(
      duplicateGroups({ d1: "h", d2: "h", d3: "h" }, ["d3", "d1", "d2"]),
    ).toEqual([["d3", "d1", "d2"]]);
  });

  it("varios grupos independientes", () => {
    const groups = duplicateGroups({ a: "x", b: "y", c: "x", d: "y", e: "z" });
    expect(groups).toEqual([["a", "c"], ["b", "d"]]);
  });
});
