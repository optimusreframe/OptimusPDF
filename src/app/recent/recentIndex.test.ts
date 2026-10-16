import { describe, expect, it } from "vitest";
import {
  REOPEN_FROM_LIBRARY_SLUGS,
  buildRecentRows,
  finishedRows,
  unfinishedRows,
  type LibraryRef,
} from "@/app/recent/recentIndex";
import { buildUnfinishedItems, type UnfinishedItem } from "@/app/recent/unfinishedWork";
import type { DraftEntry, DraftMeta, SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import type { RecentEntry } from "@/lib/recent";
import { RESUME_KINDS, resumeHref, resumeKindsOfTool, type ResumeKind } from "@/lib/resumeLinks";
import { TOOL_SLUGS, type ToolSlug } from "@/lib/tools-registry";

const HEX = (c: string) => c.repeat(64);
const SESSION = "s-mgx4k2w1-1a2b3c4d";

function id(kind: ResumeKind): string {
  return kind === "session" ? SESSION : HEX("a");
}

function session(savedAt: string): DraftEntry {
  return {
    kind: "session",
    meta: {
      kind: "session",
      id: SESSION,
      savedAt,
      documents: [{ id: "d1", fileName: "Contrato A.pdf", fileSize: 1 }],
      fileName: "Contrato A.pdf",
    } as unknown as SessionDraftMeta,
  };
}
function single(savedAt: string): DraftEntry {
  return { kind: "document", meta: { id: HEX("a"), fileName: "Poder.pdf", fileSize: 1, savedAt } as unknown as DraftMeta };
}

const entry = (over: Partial<RecentEntry> & { id: string }): RecentEntry => ({
  slug: "merge-pdf",
  fileName: "viejo.pdf",
  date: "2026-10-10T00:00:00.000Z",
  ...over,
});

function unfinished(): UnfinishedItem[] {
  return buildUnfinishedItems({
    sign: [session("2026-10-14T10:00:00.000Z"), single("2026-10-14T08:00:00.000Z")],
    edit: [{ schema: 1, id: HEX("b"), fileName: "informe.pdf", fileSize: 1, totalBytes: 1, savedAt: "2026-10-14T09:00:00.000Z", pageCount: 1, currentPage: 0, pendingCount: 2 }],
    pro: [],
  });
}

describe("buildRecentRows - la union ordenada por fecha", () => {
  it("junta borradores e historial y los ordena del mas reciente al mas antiguo", () => {
    const rows = buildRecentRows({
      unfinished: unfinished(),
      history: [
        entry({ id: "h1", fileName: "h1.pdf", date: "2026-10-14T09:30:00.000Z" }),
        entry({ id: "h2", fileName: "h2.pdf", date: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    expect(rows.map((r) => r.fileName)).toEqual(["Contrato A.pdf", "h1.pdf", "informe.pdf", "Poder.pdf", "h2.pdf"]);
    expect(rows.map((r) => r.origin)).toEqual(["draft", "history", "draft", "draft", "history"]);
  });

  it("estado: borrador = sin terminar, historial = terminado; los grupos conservan el orden", () => {
    const rows = buildRecentRows({
      unfinished: unfinished(),
      history: [entry({ id: "h1", date: "2026-10-14T09:30:00.000Z" })],
    });
    expect(unfinishedRows(rows).every((r) => r.status === "unfinished" && r.origin === "draft")).toBe(true);
    expect(finishedRows(rows).every((r) => r.status === "finished" && r.origin === "history")).toBe(true);
    expect(unfinishedRows(rows).map((r) => r.fileName)).toEqual(["Contrato A.pdf", "informe.pdf", "Poder.pdf"]);
  });

  it("un historial que apunta a un borrador VIVO no se repite (sale solo como borrador)", () => {
    const rows = buildRecentRows({
      unfinished: unfinished(),
      history: [
        entry({ id: "h1", slug: "edit-pdf", fileName: "informe.pdf", resume: { kind: "edit", id: HEX("b") } }),
        entry({ id: "h2", slug: "edit-pdf", fileName: "otro.pdf", resume: { kind: "edit", id: HEX("c") } }),
      ],
    });
    expect(rows.filter((r) => r.fileName === "informe.pdf")).toHaveLength(1);
    expect(rows.find((r) => r.fileName === "informe.pdf")?.origin).toBe("draft");
    expect(rows.find((r) => r.fileName === "otro.pdf")?.origin).toBe("history");
  });

  it("fechas corruptas van al final y no rompen el orden de las demas", () => {
    const rows = buildRecentRows({
      unfinished: [],
      history: [
        entry({ id: "a", fileName: "mala.pdf", date: "no-es-fecha" }),
        entry({ id: "b", fileName: "vieja.pdf", date: "2020-01-01T00:00:00.000Z" }),
        entry({ id: "c", fileName: "nueva.pdf", date: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    expect(rows.map((r) => r.fileName)).toEqual(["nueva.pdf", "vieja.pdf", "mala.pdf"]);
  });

  it("a igual fecha conserva el orden de llegada (borradores primero)", () => {
    const date = "2026-10-14T10:00:00.000Z";
    const rows = buildRecentRows({
      unfinished: buildUnfinishedItems({ sign: [session(date)], edit: [], pro: [] }),
      history: [entry({ id: "x", fileName: "x.pdf", date }), entry({ id: "y", fileName: "y.pdf", date })],
    });
    expect(rows.map((r) => r.fileName)).toEqual(["Contrato A.pdf", "x.pdf", "y.pdf"]);
  });

  it("el historial conserva el limite que le pone `recent.ts`; el indice no recorta ni inventa", () => {
    const history = Array.from({ length: 20 }, (_, i) => entry({ id: `h${i}`, fileName: `f${i}.pdf`, date: new Date(2026, 0, 1 + i).toISOString() }));
    expect(buildRecentRows({ unfinished: [], history })).toHaveLength(20);
  });
});

describe("Mis documentos no aporta filas", () => {
  const library: LibraryRef[] = [
    { id: "d-1", name: "Contrato de servicio", fingerprint: { exact: HEX("e") } },
    { id: "d-2", name: "Otro", fingerprint: { exact: HEX("f") } },
  ];

  it("una biblioteca con documentos y sin trabajos NO produce ninguna fila", () => {
    expect(buildRecentRows({ unfinished: [], history: [], library })).toEqual([]);
  });

  it("los borradores y el historial son las unicas filas, con o sin biblioteca", () => {
    const base = { unfinished: unfinished(), history: [entry({ id: "h1" })] };
    expect(buildRecentRows({ ...base, library }).map((r) => r.key)).toEqual(buildRecentRows(base).map((r) => r.key));
  });
});

describe("«Abrir de nuevo» con la copia de Mis documentos", () => {
  const library: LibraryRef[] = [{ id: "d-1", name: "Contrato de servicio", fingerprint: { exact: HEX("e") } }];

  it("historial de Firmar cuyo puntero tiene la misma huella que un documento: ofrece su copia", () => {
    const [row] = buildRecentRows({
      unfinished: [],
      history: [entry({ id: "h", slug: "sign-pdf", resume: { kind: "sign", id: HEX("e") } })],
      library,
    });
    expect(row.library).toEqual({ id: "d-1", name: "Contrato de servicio" });
    expect(row.continueHref).toBeNull();
  });

  it("sin coincidencia de huella: no hay copia (la herramienta pedira el archivo)", () => {
    const [row] = buildRecentRows({
      unfinished: [],
      history: [entry({ id: "h", slug: "sign-pdf", resume: { kind: "sign", id: HEX("9") } })],
      library,
    });
    expect(row.library).toBeNull();
    expect(row.missingDraft).toEqual({ kind: "sign", id: HEX("9") });
  });

  it("una sesion (id que no es huella) nunca coincide; tampoco un historial sin puntero", () => {
    const rows = buildRecentRows({
      unfinished: [],
      history: [
        entry({ id: "a", slug: "sign-pdf", resume: { kind: "session", id: SESSION } }),
        entry({ id: "b", slug: "sign-pdf" }),
      ],
      library,
    });
    expect(rows.map((r) => r.library)).toEqual([null, null]);
  });

  it("solo Firmar sabe recibir la copia: Editar y PDF Pro con la misma huella no la ofrecen", () => {
    expect(REOPEN_FROM_LIBRARY_SLUGS).toEqual(["sign-pdf"]);
    const rows = buildRecentRows({
      unfinished: [],
      history: [
        entry({ id: "a", slug: "edit-pdf", resume: { kind: "edit", id: HEX("e") } }),
        entry({ id: "b", slug: "pdf-pro", resume: { kind: "pro", id: HEX("e") } }),
      ],
      library,
    });
    expect(rows.map((r) => r.library)).toEqual([null, null]);
  });
});

describe("REGLA: ninguna fila ofrece «Continuar» sin un puntero resume verificable (recorre el registro de herramientas)", () => {
  /** Todos los punteros posibles contra todas las herramientas: validos, de otra herramienta, mal formados. */
  const pointers = (kind: ResumeKind) => [
    { kind, id: id(kind) },
    { kind, id: "no-valido" },
    { kind, id: id(kind).toUpperCase() },
    { kind, id: "" },
  ];

  it.each([...TOOL_SLUGS] as ToolSlug[])("%s: «Continuar» solo con un puntero valido DE ESA herramienta y un borrador vivo", (slug) => {
    for (const kind of RESUME_KINDS) {
      for (const pointer of pointers(kind)) {
        // Historial: nunca «Continuar», tenga el puntero que tenga.
        const [asHistory] = buildRecentRows({
          unfinished: [],
          history: [entry({ id: "h", slug, resume: pointer as RecentEntry["resume"] })],
        });
        expect(asHistory.continueHref, `historial ${slug} ${kind}:${pointer.id}`).toBeNull();
      }
    }
    // Borradores: el unico camino con «Continuar» es un `UnfinishedItem` cuyo puntero es de la herramienta de la fila.
    for (const kind of RESUME_KINDS) {
      const item: UnfinishedItem = {
        key: `${kind}:${id(kind)}`,
        target: { kind, id: id(kind) },
        slug,
        fileName: "x.pdf",
        savedAt: "2026-10-14T10:00:00.000Z",
        href: resumeHref({ kind, id: id(kind) }),
      };
      const [row] = buildRecentRows({ unfinished: [item], history: [] });
      const owns = resumeKindsOfTool(slug).includes(kind);
      expect(row.continueHref, `borrador ${slug} ${kind}`).toBe(owns ? resumeHref({ kind, id: id(kind) }) : null);
    }
  });

  it("ninguna herramienta SIN tipos recuperables llega a ofrecer «Continuar» con ningun puntero", () => {
    const withoutResume = TOOL_SLUGS.filter((slug) => resumeKindsOfTool(slug).length === 0);
    expect(withoutResume.length).toBeGreaterThan(20);
    for (const slug of withoutResume) {
      for (const kind of RESUME_KINDS) {
        const item = {
          key: `${kind}:${id(kind)}`,
          target: { kind, id: id(kind) },
          slug,
          fileName: "x.pdf",
          savedAt: "2026-10-14T10:00:00.000Z",
          href: resumeHref({ kind, id: id(kind) }),
        } as UnfinishedItem;
        expect(buildRecentRows({ unfinished: [item], history: [] })[0].continueHref).toBeNull();
      }
    }
  });

  it("un puntero con id fuera de la expresion de su tipo no ofrece «Continuar» aunque la herramienta sea la suya", () => {
    const item = {
      key: "edit:zzz",
      target: { kind: "edit", id: "../../etc/passwd" },
      slug: "edit-pdf",
      fileName: "x.pdf",
      savedAt: "2026-10-14T10:00:00.000Z",
      href: "/edit-pdf?resume=edit:../../etc/passwd",
    } as UnfinishedItem;
    expect(buildRecentRows({ unfinished: [item], history: [] })[0].continueHref).toBeNull();
  });
});
