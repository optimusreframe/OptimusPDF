import { describe, expect, it } from "vitest";
import type { EditDraftSummary } from "@/app/edit-pdf/editDrafts";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import { buildUnfinishedItems, hiddenByUnfinished, type UnfinishedItem } from "@/app/recent/unfinishedWork";
import type { DraftEntry, DraftMeta, SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import { resumeHref } from "@/lib/resumeLinks";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const HEX_D = "d".repeat(64);

function session(overrides: Partial<SessionDraftMeta> = {}): DraftEntry {
  const meta = {
    kind: "session",
    id: "s-mgx4k2w1-1a2b3c4d",
    savedAt: "2026-10-14T10:00:00.000Z",
    mode: "multi",
    signMode: "independent",
    signers: [],
    blocks: [],
    documents: [
      { id: "doc-1", fileName: "Contrato A.pdf", fileSize: 10 },
      { id: "doc-2", fileName: "Anexo B.pdf", fileSize: 10 },
    ],
    docStates: {},
    activeDocId: "doc-1",
    step: "sign",
    fileSize: 20,
    fileName: "Contrato A.pdf",
    documentCount: 2,
    ...overrides,
  } as SessionDraftMeta;
  return { kind: "session", meta };
}

function single(overrides: Partial<DraftMeta> = {}): DraftEntry {
  const meta = {
    id: HEX_A,
    fileName: "Poder.pdf",
    fileSize: 10,
    savedAt: "2026-10-14T09:00:00.000Z",
    mode: "single",
    signers: [],
    fields: [],
    textFields: [],
    textValues: {},
    step: "document",
    captures: {},
    textFieldsDetectedFor: null,
    ...overrides,
  } as DraftMeta;
  return { kind: "document", meta };
}

function edit(overrides: Partial<EditDraftSummary> = {}): EditDraftSummary {
  return {
    schema: 1,
    id: HEX_B,
    fileName: "informe.pdf",
    fileSize: 10,
    totalBytes: 10,
    savedAt: "2026-10-14T11:00:00.000Z",
    pageCount: 2,
    currentPage: 0,
    pendingCount: 3,
    ...overrides,
  };
}

function pro(overrides: Partial<ProDraftSummary> = {}): ProDraftSummary {
  return {
    schema: 1,
    id: HEX_C,
    fileName: "factura.pdf",
    fileSize: 10,
    savedAt: "2026-10-14T08:00:00.000Z",
    pageCount: 2,
    currentPage: 0,
    steps: 2,
    ...overrides,
  };
}

describe("buildUnfinishedItems", () => {
  it("junta los tres almacenes, del mas reciente al mas antiguo, con su herramienta y su enlace", () => {
    const items = buildUnfinishedItems({ sign: [session(), single()], edit: [edit()], pro: [pro()] });
    expect(items.map((item) => [item.slug, item.fileName])).toEqual([
      ["edit-pdf", "informe.pdf"],
      ["sign-pdf", "Contrato A.pdf"],
      ["sign-pdf", "Poder.pdf"],
      ["pdf-pro", "factura.pdf"],
    ]);
    expect(items.map((item) => item.href)).toEqual([
      `/edit-pdf?resume=edit:${HEX_B}`,
      "/sign-pdf?resume=session:s-mgx4k2w1-1a2b3c4d",
      `/sign-pdf?resume=sign:${HEX_A}`,
      `/pdf-pro?resume=pro:${HEX_C}`,
    ]);
    for (const item of items) expect(item.href).toBe(resumeHref(item.target));
    expect(items.map((item) => item.key)).toEqual([
      `edit:${HEX_B}`,
      "session:s-mgx4k2w1-1a2b3c4d",
      `sign:${HEX_A}`,
      `pro:${HEX_C}`,
    ]);
  });

  it("lleva los datos que se muestran: documentos de la sesion y cambios de Editar y PDF Pro", () => {
    const items = buildUnfinishedItems({ sign: [session()], edit: [edit({ pendingCount: 5 })], pro: [pro({ steps: 7 })] });
    const byTool = Object.fromEntries(items.map((item) => [item.slug, item]));
    expect(byTool["sign-pdf"].documents).toBe(2);
    expect(byTool["edit-pdf"].changes).toBe(5);
    expect(byTool["pdf-pro"].changes).toBe(7);
    expect(byTool["pdf-pro"].pro?.id).toBe(HEX_C);
    expect(byTool["edit-pdf"].pro).toBeUndefined();
  });

  it("sin borradores no hay filas", () => {
    expect(buildUnfinishedItems({ sign: [], edit: [], pro: [] })).toEqual([]);
  });

  it("no lista lo que la herramienta no sabria restaurar (para no prometer un «Continuar» vacio)", () => {
    const items = buildUnfinishedItems({
      sign: [
        session({ id: "no-es-una-sesion" }),
        session({ id: "s-ok-ok1", documents: [] }),
        single({ id: "no-es-hex" }),
        single({ id: HEX_D.toUpperCase() }),
      ],
      edit: [edit({ id: "../../x" }), edit({ id: HEX_A, pendingCount: 0 })],
      pro: [pro({ id: "corto" })],
    });
    expect(items).toEqual([]);
  });

  it("una sesion sin nombre propio usa el de su primer documento", () => {
    const items = buildUnfinishedItems({ sign: [session({ fileName: undefined as unknown as string })], edit: [], pro: [] });
    expect(items[0].fileName).toBe("Contrato A.pdf");
  });

  it("con la misma fecha conserva el orden de llegada", () => {
    const savedAt = "2026-10-14T10:00:00.000Z";
    const items = buildUnfinishedItems({ sign: [single({ savedAt })], edit: [edit({ savedAt })], pro: [pro({ savedAt })] });
    expect(items.map((item) => item.slug)).toEqual(["sign-pdf", "edit-pdf", "pdf-pro"]);
  });

  it("un sign suelto y un edit con la misma huella no se confunden: la clave lleva el tipo", () => {
    const items = buildUnfinishedItems({ sign: [single({ id: HEX_A })], edit: [edit({ id: HEX_A })], pro: [pro({ id: HEX_A })] });
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
  });
});

describe("hiddenByUnfinished", () => {
  const items = buildUnfinishedItems({ sign: [], edit: [], pro: [pro()] });
  const entry = (id: string, resume?: UnfinishedItem["target"]) => ({ id, resume });

  it("oculta del historial lo que ya se ofrece en «Sin terminar» (mismo tipo e id)", () => {
    const rows = [entry("a", { kind: "pro", id: HEX_C }), entry("b", { kind: "pro", id: HEX_D }), entry("c")];
    expect(hiddenByUnfinished(rows, items).map((row) => row.id)).toEqual(["b", "c"]);
  });

  it("el mismo id con otro tipo no lo oculta", () => {
    const rows = [entry("a", { kind: "edit", id: HEX_C })];
    expect(hiddenByUnfinished(rows, items)).toHaveLength(1);
  });

  it("sin borradores vivos todo el historial se queda", () => {
    const rows = [entry("a", { kind: "pro", id: HEX_C })];
    expect(hiddenByUnfinished(rows, [])).toHaveLength(1);
  });
});
