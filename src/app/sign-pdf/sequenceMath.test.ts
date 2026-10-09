import { describe, expect, it } from "vitest";
import {
  findPendingInOtherDocs,
  hasPendingInOtherDocs,
  isPendingElsewhere,
  pendingCount,
  planSoloPlacements,
  sequencePosition,
  soloPlacedCount,
  soloPlacement,
  stepPage,
} from "@/app/sign-pdf/sequenceMath";
import { defaultSoloRect } from "@/app/sign-pdf/soloSignature";
import type { DetectedField } from "@/lib/pdf/detectFields";

const ORDER = ["doc-1", "doc-2", "doc-3"];
const COUNTS = { "doc-1": 2, "doc-2": 3, "doc-3": 1 };

function field(
  id: string,
  pageIndex: number,
  y: number,
  extra: Partial<DetectedField> = {},
): DetectedField {
  return {
    id,
    pageIndex,
    rect: { x: 0.1, y, width: 0.3, height: 0.05 },
    source: "manual",
    confidence: "high",
    ...extra,
  };
}

describe("sequencePosition — numeracion global de la vista continua", () => {
  it("suma las paginas de los documentos anteriores: pagina 2 del segundo es la 4 de 6", () => {
    const position = sequencePosition(ORDER, COUNTS, "doc-2", 1);
    expect(position).toMatchObject({
      docNumber: 2,
      docCount: 3,
      local: 2,
      localTotal: 3,
      global: 4,
      total: 6,
    });
  });

  it("la primera pagina del primer documento es la 1 y la ultima del ultimo es la 6", () => {
    expect(sequencePosition(ORDER, COUNTS, "doc-1", 0).global).toBe(1);
    expect(sequencePosition(ORDER, COUNTS, "doc-3", 0).global).toBe(6);
  });

  it("mientras falte el recuento de algun documento no hay numero global (ni total)", () => {
    const partial = { "doc-1": 2, "doc-3": 1 };
    const position = sequencePosition(ORDER, partial, "doc-3", 0);
    expect(position.global).toBeNull();
    expect(position.total).toBeNull();
    expect(position.local).toBe(1);
    expect(position.localTotal).toBe(1);
  });

  it("el recuento propio puede faltar sin romper la posicion local", () => {
    const position = sequencePosition(ORDER, {}, "doc-2", 0);
    expect(position.localTotal).toBeNull();
    expect(position.docNumber).toBe(2);
  });
});

describe("stepPage — cruzar de un documento al vecino", () => {
  it("dentro del documento avanza y retrocede una pagina", () => {
    expect(stepPage(ORDER, COUNTS, { docId: "doc-2", pageIndex: 0 }, 1)).toEqual({
      docId: "doc-2",
      pageIndex: 1,
    });
    expect(stepPage(ORDER, COUNTS, { docId: "doc-2", pageIndex: 2 }, -1)).toEqual({
      docId: "doc-2",
      pageIndex: 1,
    });
  });

  it("en la ultima pagina de un documento pasa a la primera del siguiente", () => {
    expect(stepPage(ORDER, COUNTS, { docId: "doc-1", pageIndex: 1 }, 1)).toEqual({
      docId: "doc-2",
      pageIndex: 0,
    });
  });

  it("en la primera pagina de un documento vuelve a la ULTIMA del anterior", () => {
    expect(stepPage(ORDER, COUNTS, { docId: "doc-3", pageIndex: 0 }, -1)).toEqual({
      docId: "doc-2",
      pageIndex: 2,
    });
  });

  it("no hay pagina antes de la primera ni despues de la ultima del conjunto", () => {
    expect(stepPage(ORDER, COUNTS, { docId: "doc-1", pageIndex: 0 }, -1)).toBeNull();
    expect(stepPage(ORDER, COUNTS, { docId: "doc-3", pageIndex: 0 }, 1)).toBeNull();
  });

  it("retroceder al documento anterior sin su recuento no se puede todavia (no se inventa la pagina)", () => {
    expect(
      stepPage(ORDER, { "doc-3": 1 }, { docId: "doc-3", pageIndex: 0 }, -1),
    ).toBeNull();
  });

  it("avanzar sin el recuento del documento actual no se puede todavia", () => {
    expect(stepPage(ORDER, {}, { docId: "doc-1", pageIndex: 0 }, 1)).toBeNull();
  });

  it("un documento que no esta en la cola no tiene vecinos", () => {
    expect(stepPage(ORDER, COUNTS, { docId: "nope", pageIndex: 0 }, 1)).toBeNull();
  });
});

describe("campos pendientes entre documentos", () => {
  const docs = {
    "doc-1": { textFields: [field("a1", 0, 0.1)], textValues: { a1: "Ana" } },
    "doc-2": {
      textFields: [field("b2", 1, 0.5), field("b1", 0, 0.2), field("b3", 2, 0.1)],
      textValues: { b3: "ok" },
    },
    "doc-3": { textFields: [field("c1", 0, 0.3)], textValues: {} },
  };

  it("un campo vacio es pendiente; con texto no; una casilla sin marcar tambien lo es", () => {
    expect(isPendingElsewhere(field("x", 0, 0), {})).toBe(true);
    expect(isPendingElsewhere(field("x", 0, 0), { x: "  " })).toBe(true);
    expect(isPendingElsewhere(field("x", 0, 0), { x: "Ana" })).toBe(false);
    expect(isPendingElsewhere(field("c", 0, 0, { type: "checkbox" }), {})).toBe(true);
    expect(isPendingElsewhere(field("c", 0, 0, { type: "checkbox" }), { c: "true" })).toBe(false);
  });

  it("pendingCount cuenta solo los vacios del documento", () => {
    expect(pendingCount(docs["doc-2"])).toBe(2);
    expect(pendingCount(docs["doc-1"])).toBe(0);
  });

  it("hacia delante: el PRIMERO en orden de lectura del siguiente documento con pendientes (salta los rellenos)", () => {
    expect(findPendingInOtherDocs(ORDER, docs, "doc-1", 1)).toEqual({
      docId: "doc-2",
      fieldId: "b1",
      pageIndex: 0,
    });
  });

  it("hacia atras: el ULTIMO pendiente del documento anterior que tenga", () => {
    expect(findPendingInOtherDocs(ORDER, docs, "doc-3", -1)).toEqual({
      docId: "doc-2",
      fieldId: "b2",
      pageIndex: 1,
    });
  });

  it("da la vuelta a la cola: desde el ultimo documento hacia delante llega al primero que tenga", () => {
    expect(findPendingInOtherDocs(ORDER, docs, "doc-3", 1)).toEqual({
      docId: "doc-2",
      fieldId: "b1",
      pageIndex: 0,
    });
  });

  it("nunca mira el documento de partida: si solo el tiene pendientes, no hay destino", () => {
    const only = { ...docs, "doc-2": { textFields: [], textValues: {} }, "doc-3": { textFields: [], textValues: {} } };
    const mine = { ...only, "doc-1": { textFields: [field("z", 0, 0)], textValues: {} } };
    expect(findPendingInOtherDocs(ORDER, mine, "doc-1", 1)).toBeNull();
    expect(findPendingInOtherDocs(ORDER, mine, "doc-1", -1)).toBeNull();
  });

  it("hasPendingInOtherDocs distingue lo del propio documento de lo ajeno", () => {
    expect(hasPendingInOtherDocs(ORDER, docs, "doc-1")).toBe(true);
    const alone = { ...docs, "doc-2": { textFields: [], textValues: {} }, "doc-3": { textFields: [], textValues: {} } };
    expect(hasPendingInOtherDocs(ORDER, alone, "doc-1")).toBe(false);
  });
});

describe("«Solo yo»: colocacion de la firma por documento", () => {
  it("soloPlacement: width 0 es pendiente; con ancho, colocada", () => {
    expect(soloPlacement(undefined)).toBe("pending");
    expect(soloPlacement({ rect: { x: 0, y: 0, width: 0, height: 0 } })).toBe("pending");
    expect(soloPlacement({ rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } })).toBe("placed");
  });

  it("soloPlacedCount cuenta los documentos con firma", () => {
    const placed = { rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } };
    const empty = { rect: { x: 0, y: 0, width: 0, height: 0 } };
    expect(soloPlacedCount(ORDER, { "doc-1": placed, "doc-2": empty })).toBe(1);
  });

  it("sin referencia usa defaultSoloRect con la proporcion de la pagina de CADA documento", () => {
    const plan = planSoloPlacements(0.25, null, [
      { docId: "doc-1", visiblePage: 0, info: { count: 2, aspect: 0.75 } },
      { docId: "doc-2", visiblePage: 1, info: { count: 3, aspect: 1.5 } },
    ]);
    expect(plan["doc-1"].rect).toEqual(defaultSoloRect(0.25, 0.75));
    expect(plan["doc-2"].rect).toEqual(defaultSoloRect(0.25, 1.5));
    // La apaisada es mas alta en fraccion de pagina: la firma conserva su forma fisica.
    expect(plan["doc-2"].rect.height).toBeGreaterThan(plan["doc-1"].rect.height);
    expect(plan["doc-1"].pageIndex).toBe(0);
    expect(plan["doc-2"].pageIndex).toBe(1);
  });

  it("con referencia copia posicion y ancho, recalcula el alto por documento y acota la pagina al final", () => {
    const reference = {
      rect: { x: 0.4, y: 0.6, width: 0.3, height: 0.1 },
      pageIndex: 3,
    };
    const plan = planSoloPlacements(0.25, reference, [
      { docId: "doc-2", visiblePage: 0, info: { count: 5, aspect: 0.75 } },
      { docId: "doc-3", visiblePage: 0, info: { count: 2, aspect: 1.5 } },
    ]);
    expect(plan["doc-2"].pageIndex).toBe(3);
    expect(plan["doc-3"].pageIndex).toBe(1);
    expect(plan["doc-2"].rect.x).toBe(0.4);
    expect(plan["doc-2"].rect.width).toBe(0.3);
    expect(plan["doc-3"].rect.height).toBeCloseTo(0.3 * 0.25 * 1.5, 6);
    // Nunca se sale de la pagina por abajo.
    for (const placement of Object.values(plan)) {
      expect(placement.rect.y + placement.rect.height).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("una pagina que no se pudo leer usa la proporcion por defecto 0,75 y no acota la pagina", () => {
    const plan = planSoloPlacements(0.25, null, [
      { docId: "doc-1", visiblePage: 4, info: null },
    ]);
    expect(plan["doc-1"].rect).toEqual(defaultSoloRect(0.25, 0.75));
    expect(plan["doc-1"].pageIndex).toBe(4);
  });

  it("sin firma creada (proporcion 0) no hay nada que colocar", () => {
    expect(
      planSoloPlacements(0, null, [
        { docId: "doc-1", visiblePage: 0, info: { count: 1, aspect: 0.75 } },
      ]),
    ).toEqual({});
  });
});
