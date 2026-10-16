import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";
import { repeatInitials } from "@/lib/docLibrary/templateRepeat";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { DEFAULT_ROLES, TEMPLATE_SCHEMA_VERSION, type DocTemplate } from "@/lib/docLibrary/templateTypes";
import type { MatchResult } from "@/lib/docLibrary/types";
import { isSignerDone } from "@/app/sign-pdf/blockModel";
import { captureStamp } from "@/app/sign-pdf/captures";
import { docIdOf, docIdsOf, docStateOf, liveFields } from "@/app/sign-pdf/docSet";
import { planTemplateApplication } from "@/app/sign-pdf/templateSession";
import { DEFAULT_SESSION, syncSession, type SignSession } from "@/app/sign-pdf/signSession";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { markFromLibrary, markRestored } from "@/app/sign-pdf/templateFileRegistry";
import { REMEMBERED_SIGNERS_KEY } from "@/app/sign-pdf/templatePrefs";
import { useSessionBridge, type SessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { useTemplateController, type TemplateController } from "@/app/sign-pdf/useTemplateController";

const mocks = vi.hoisted(() => ({
  computeFingerprint: vi.fn(),
  findTemplateForFingerprint: vi.fn(),
  getDocument: vi.fn(),
  getTemplateForDocument: vi.fn(),
  autoMapFile: vi.fn(),
  saveTemplateToLibrary: vi.fn(),
}));
vi.mock("@/lib/docLibrary/fingerprint", () => ({ computeFingerprint: mocks.computeFingerprint }));
vi.mock("@/lib/docLibrary/store", () => ({ getDocument: mocks.getDocument, libraryStatus: async () => ({ available: true }) }));
vi.mock("@/lib/docLibrary/templatesStore", () => ({ findTemplateForFingerprint: mocks.findTemplateForFingerprint, getTemplateForDocument: mocks.getTemplateForDocument }));
vi.mock("@/lib/pdf/autoMapFile", () => ({ autoMapFile: mocks.autoMapFile }));
vi.mock("@/app/sign-pdf/templateLibrary", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/app/sign-pdf/templateLibrary")>()), saveTemplateToLibrary: mocks.saveTemplateToLibrary }));

const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const LINE = R(0.74, 0.885, 0.13, 0.045);

function makeTemplate(pages = 4): DocTemplate {
  const two = repeatInitials({ fields: [], textFields: [] }, { signers: 2, base: LINE, fromPage: 0, toPage: pages - 1, pageCount: pages }).variant;
  const one = repeatInitials({ fields: [], textFields: [] }, { signers: 1, base: LINE, fromPage: 0, toPage: pages - 1, pageCount: pages }).variant;
  const sign = (roleIndex: number, x: number) => ({ id: `s${roleIndex}`, roleIndex, pageIndex: pages - 1, type: "signature" as const, rect: R(x, 0.5, 0.3, 0.05), required: true, source: "manual" as const });
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id: "tpl-1",
    documentId: "doc-lib",
    name: "Mold Test",
    version: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    rev: 2,
    roles: DEFAULT_ROLES.map((role) => ({ ...role })),
    variants: { "1": { fields: [...one.fields, sign(0, 0.1)], textFields: [] }, "2": { fields: [...two.fields, sign(0, 0.1), sign(1, 0.55)], textFields: [] } },
  };
}

const matchOf = (level: MatchResult["level"], over: Partial<MatchResult> = {}): MatchResult => ({
  level,
  similarity: level === "similar" ? 0.85 : 1,
  percent: level === "similar" ? 85 : 100,
  pageMatches: [],
  mappedPages: [0, 1, 2, 3],
  reviewPages: [],
  ...over,
});
const lookupOf = (match: MatchResult, template = makeTemplate()) => ({ match, template, document: { id: "doc-lib", pageCount: 4 }, duplicates: [] });
const FINGERPRINT = { pageCount: 4 };
const strings = SIGN_STRINGS.es;

type Props = { files: File[]; initial?: Partial<SignSession>; applyEnabled?: boolean; detectEnabled?: boolean; onStaleSkipped?: (fileName: string) => void };
let api: { controller: TemplateController; bridge: SessionBridge; session: () => SignSession };

function Harness({ files, initial, applyEnabled = true, detectEnabled = true, onStaleSkipped }: Props) {
  const bridge = useSessionBridge();
  const [session, setSession] = useState<SignSession>({ ...DEFAULT_SESSION, ...initial });
  useLayoutEffect(() => {
    bridge.sync(files, session, (patch) => setSession((current) => ({ ...current, ...patch })));
  });
  useEffect(() => {
    const patch = syncSession(session, docIdsOf(files));
    if (Object.keys(patch).length > 0) bridge.commit((current, current_files) => syncSession(current, docIdsOf(current_files)));
  });
  const controller = useTemplateController({ bridge, language: "es", strings, applyEnabled, detectEnabled, onStaleSkipped });
  useLayoutEffect(() => {
    api = { controller, bridge, session: () => bridge.read().session };
  });
  const { notify } = controller;
  useEffect(() => {
    notify(files);
  }, [files, session.mode, session.signers, notify]);
  return null;
}

const pdf = (name = "contrato.pdf") => new File(["%PDF-1.4 test"], name, { type: "application/pdf" });

function field(id: string, over: Partial<AutoMapResult["fields"][number]> = {}): AutoMapResult["fields"][number] {
  return { id, pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.04), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "linea de iniciales", source: "label", ...over };
}
const autoResult = (fields: AutoMapResult["fields"]): AutoMapResult => ({ fields, pages: [], confidenceSummary: { high: 0, review: 0, ignore: 0, byType: { signature: 0, initials: 0, date: 0, text: 0 }, meanHighConfidence: 0, maxPerPage: 0 }, warnings: [] });

beforeEach(() => {
  window.localStorage.clear();
  mocks.computeFingerprint.mockReset().mockResolvedValue(FINGERPRINT);
  mocks.findTemplateForFingerprint.mockReset().mockResolvedValue(null);
  mocks.getDocument.mockReset().mockResolvedValue(null);
  mocks.getTemplateForDocument.mockReset().mockResolvedValue(null);
  mocks.autoMapFile.mockReset().mockResolvedValue(autoResult([]));
});
afterEach(() => cleanup());

const doc = (file: File) => docStateOf(api.session().docs, docIdOf(file));

describe("aplicar plantillas al cargar", () => {
  it("«Coincide»: aplica la plantilla (modo varios, firmantes con el nombre de su rol) y avisa con Deshacer", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    const file = pdf();
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    const notice = api.controller.notices[0];
    expect(notice).toMatchObject({ count: 2, name: "contrato.pdf" });
    expect(notice.record?.template?.name).toBe("Mold Test");
    expect(api.session().mode).toBe("multi");
    expect(api.session().signers.map((s) => s.name)).toEqual(["Asegurado", "Co-asegurado"]);
    expect(doc(file).fields).toHaveLength(10);
    expect(api.controller.announcement).toContain("Mold Test");
  });

  it("recuerda el nº de firmantes y usa los que ya hay", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    window.localStorage.setItem(REMEMBERED_SIGNERS_KEY, "1");
    const file = pdf();
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(api.controller.notices[0].count).toBe(1);
    expect(api.session().signers).toHaveLength(1);
  });

  it("«Parece (85 %)»: pregunta y no aplica nada hasta decir «Usar»; «No» la descarta", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("similar", { reviewPages: [1] })));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("asking"));
    expect(api.controller.notices[0].lookup?.percent).toBe(85);
    expect(doc(file).fields).toHaveLength(0);
    act(() => api.controller.acceptSimilar(docIdOf(file)));
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(doc(file).fields.length).toBeGreaterThan(0);
    expect(api.controller.notices[0].record?.reviewPages).toEqual([1]);
    expect(api.controller.notices[0].pending.length).toBeGreaterThan(0);
    expect(new Set(doc(file).fields.map((f) => f.pageIndex)).has(1)).toBe(false);
  });

  it("«No» a la sugerencia la quita y, con varios firmantes, pasa al automapeo", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("similar")));
    mocks.autoMapFile.mockResolvedValue(autoResult([field("am-0-1")]));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("asking"));
    act(() => api.controller.declineSimilar(docIdOf(file)));
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(mocks.autoMapFile).toHaveBeenCalled();
  });

  it("las páginas a revisar no se aplican solas y se pueden añadir una a una o todas", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match", { reviewPages: [3] })));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    const before = doc(file).fields.length;
    const pending = api.controller.notices[0].pending;
    expect(pending.length).toBe(4);
    act(() => api.controller.accept(docIdOf(file), pending[0].key));
    expect(doc(file).fields.length + doc(file).textFields.length).toBeGreaterThan(before);
    expect(api.controller.notices[0].pending).toHaveLength(3);
    act(() => api.controller.acceptAll(docIdOf(file)));
    expect(api.controller.notices[0].pending).toHaveLength(0);
    expect(new Set(doc(file).fields.map((f) => f.pageIndex)).has(3)).toBe(true);
  });

  it("Deshacer retira los campos y los firmantes creados y devuelve «Solo yo»", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("exact")));
    const file = pdf();
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    act(() => api.controller.undo(docIdOf(file)));
    expect(doc(file).fields).toHaveLength(0);
    expect(api.session().signers).toHaveLength(0);
    expect(api.session().mode).toBe("single");
    expect(api.controller.notices).toHaveLength(0);
  });

  it("cambiar de 2 a 1 firmante con el aviso re-aplica la variante y vuelve a 2 conservando el id del hueco que no cambia", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    const file = pdf();
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    const ana = api.session().signers[0].id;
    const signatureId = doc(file).fields.find((f) => f.type === "signature" && f.signerId === ana)!.id;
    act(() => api.controller.setCount(docIdOf(file), 1));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    expect(api.session().signers).toHaveLength(1);
    expect(doc(file).fields.every((f) => f.signerId === ana)).toBe(true);
    expect(doc(file).fields.find((f) => f.type === "signature")!.id).toBe(signatureId);
    act(() => api.controller.setCount(docIdOf(file), 2));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(2));
    expect(api.session().signers).toHaveLength(2);
    expect(doc(file).fields.find((f) => f.type === "signature" && f.signerId === ana)!.id).toBe(signatureId);
    expect(doc(file).fields).toHaveLength(10);
  });

  it("anadir un segundo firmante a mano en el paso «Firmantes» re-aplica la variante de 2", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    window.localStorage.setItem(REMEMBERED_SIGNERS_KEY, "1");
    const file = pdf();
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(api.controller.notices[0].count).toBe(1);
    act(() => api.bridge.commit((current) => ({ signers: [...current.signers, { id: "sg-luis", name: "Luis", color: "#0f9d68" }] })));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(2));
    expect(doc(file).fields.some((f) => f.signerId === "sg-luis")).toBe(true);
  });

  it("no re-aplica nada sobre un archivo restaurado (borrador, configuración) ni sobre un documento ya trabajado", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    const restored = pdf("restaurado.pdf");
    markRestored([restored]);
    render(<Harness files={[restored]} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(api.controller.notices).toHaveLength(0);
    expect(mocks.computeFingerprint).not.toHaveBeenCalled();
    expect(api.session().mode).toBe("single");
    cleanup();

    const worked = pdf("trabajado.pdf");
    mocks.computeFingerprint.mockImplementation(async () => {
      // Mientras llega la huella, la persona coloca un hueco: el trabajo manda.
      api.bridge.commit((current) => ({ docs: { ...current.docs, [docIdOf(worked)]: { ...docStateOf(current.docs, docIdOf(worked)), fields: [{ id: "f-mano", signerId: "sg-1", pageIndex: 0, type: "signature", rect: R(0.1, 0.1, 0.2, 0.05) }] } } }));
      return FINGERPRINT;
    });
    render(<Harness files={[worked]} initial={{ mode: "multi", signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }] }} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(api.controller.notices).toHaveLength(0);
    expect(docStateOf(api.session().docs, docIdOf(worked)).fields.map((f) => f.id)).toEqual(["f-mano"]);
  });

  it("con los dos ajustes apagados no hace nada; con solo «detectar» apagado, aplica la plantilla pero no mapea", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    render(<Harness files={[pdf()]} applyEnabled={false} detectEnabled={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(api.controller.notices).toHaveLength(0);
    expect(mocks.computeFingerprint).not.toHaveBeenCalled();
    cleanup();
    mocks.findTemplateForFingerprint.mockResolvedValue(null);
    render(<Harness files={[pdf()]} initial={{ mode: "multi" }} detectEnabled={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(mocks.autoMapFile).not.toHaveBeenCalled();
  });

  it("varios documentos: cada uno con su plantilla", async () => {
    const other = makeTemplate(2);
    other.id = "tpl-2";
    other.name = "Responsive PA";
    mocks.computeFingerprint.mockImplementation(async (file: File) => ({ pageCount: file.name.startsWith("a") ? 4 : 2, name: file.name }));
    mocks.findTemplateForFingerprint.mockImplementation(async (fp: { name: string }) => (fp.name.startsWith("a") ? lookupOf(matchOf("match")) : lookupOf(matchOf("match", { mappedPages: [0, 1] }), other)));
    const a = pdf("a.pdf");
    const b = pdf("b.pdf");
    render(<Harness files={[a, b]} />);
    await waitFor(() => expect(api.controller.notices.filter((n) => n.phase === "applied")).toHaveLength(2));
    expect(api.controller.notices.map((n) => n.record?.template?.name).sort()).toEqual(["Mold Test", "Responsive PA"]);
    expect(doc(a).fields).toHaveLength(10);
    expect(doc(b).fields).toHaveLength(6);
    // Un solo juego de firmantes para toda la ronda.
    expect(api.session().signers).toHaveLength(2);
  });

  it("traspaso desde «Mis documentos»: usa la plantilla del documento de la biblioteca sin buscar por huella", async () => {
    mocks.getDocument.mockResolvedValue({ id: "doc-lib", pageCount: 4 });
    mocks.getTemplateForDocument.mockResolvedValue(makeTemplate());
    const file = pdf();
    markFromLibrary(file, "doc-lib");
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(mocks.computeFingerprint).not.toHaveBeenCalled();
    expect(api.controller.notices[0].lookup?.level).toBe("exact");
  });
});

describe("automapeo de un documento desconocido", () => {
  it("con «Varios firmantes»: coloca los de confianza alta, crea los firmantes y deja las sugerencias; ofrece guardar", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a"), field("b", { signerIndex: 1, rect: R(0.4, 0.1, 0.2, 0.04) }), field("c", { tier: "review", pageIndex: 2 })]));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    const notice = api.controller.notices[0];
    expect(notice.record?.placed).toBe(2);
    expect(notice.pending).toHaveLength(1);
    expect(notice.offerSave).toBe("available");
    expect(api.session().signers).toHaveLength(2);
    expect(doc(file).fields).toHaveLength(2);
    expect(api.controller.announcement).toContain("2 campos");
  });

  it("en «Solo yo» espera: no cambia de modo por un documento desconocido y mapea al elegir varios firmantes", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a")]));
    const file = pdf();
    render(<Harness files={[file]} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(mocks.autoMapFile).not.toHaveBeenCalled();
    expect(api.session().mode).toBe("single");
    act(() => api.bridge.commit(() => ({ mode: "multi" })));
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(doc(file).fields).toHaveLength(1);
    expect(api.session().signers).toHaveLength(1);
  });

  it("sin campos propuestos no cambia nada (ni modo, ni firmantes) y no deja aviso", async () => {
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(mocks.autoMapFile).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(api.controller.notices).toHaveLength(0);
    expect(api.session().signers).toHaveLength(0);
  });

  it("un fallo del automapeo no bloquea nada", async () => {
    mocks.autoMapFile.mockRejectedValue(new Error("boom"));
    render(<Harness files={[pdf()]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(mocks.autoMapFile).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(api.controller.notices).toHaveLength(0);
  });

  it("«Detectar campos automáticamente» a mano pasa a varios firmantes y mapea", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a")]));
    const file = pdf();
    render(<Harness files={[file]} detectEnabled={false} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    act(() => api.controller.detect(docIdOf(file)));
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(api.session().mode).toBe("multi");
  });

  it("cambiar de 2 a 1 firmante vuelve a mapear con 1 firmante", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a"), field("b", { signerIndex: 1 })]));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(api.controller.notices[0].count).toBe(2);
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a")]));
    act(() => api.controller.setCount(docIdOf(file), 1));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    expect(mocks.autoMapFile).toHaveBeenLastCalledWith(file, expect.objectContaining({ signers: 1 }), expect.anything());
    expect(doc(file).fields).toHaveLength(1);
    expect(api.session().signers).toHaveLength(1);
  });

  it("«Añadir todas» no añade las firmas sin firmante claro (la de la otra parte): esas, de una en una", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a"), field("c", { tier: "review", pageIndex: 2 }), field("o", { type: "signature", signerIndex: undefined, tier: "review", pageIndex: 3 })]));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(api.controller.notices[0].pending.map((p) => p.key).sort()).toEqual(["c", "o"]);
    act(() => api.controller.acceptAll(docIdOf(file)));
    expect(api.controller.notices[0].pending.map((p) => p.key)).toEqual(["o"]);
    expect(doc(file).fields).toHaveLength(2);
    act(() => api.controller.accept(docIdOf(file), "o"));
    expect(doc(file).fields).toHaveLength(3);
    expect(doc(file).fields.find((f) => f.pageIndex === 3)?.signerId).toBe(api.session().signers[0].id);
  });

  it("«Usar» una plantilla que «Parece» no pisa lo que la persona hizo entretanto", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("similar")));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi", signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }] }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("asking"));
    act(() => api.bridge.commit((current) => ({ docs: { ...current.docs, [docIdOf(file)]: { ...docStateOf(current.docs, docIdOf(file)), fields: [{ id: "f-mano", signerId: "sg-1", pageIndex: 0, type: "signature", rect: R(0.1, 0.1, 0.2, 0.05) }] } } })));
    act(() => api.controller.acceptSimilar(docIdOf(file)));
    await waitFor(() => expect(api.controller.notices).toHaveLength(0));
    expect(doc(file).fields.map((f) => f.id)).toEqual(["f-mano"]);
  });

  it("si la persona elige «1 firmante» y ya tenía dos firmantes propios, la elección se respeta (no se vuelve a 2)", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    const ana = { id: "sg-ana", name: "Ana", color: "#0d4bff" };
    const luis = { id: "sg-luis", name: "Luis", color: "#0f9d68" };
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi", signers: [ana, luis] }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(api.controller.notices[0].count).toBe(2);
    act(() => api.controller.setCount(docIdOf(file), 1));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(api.controller.notices[0].count).toBe(1);
    expect(api.session().signers.map((s) => s.id)).toEqual(["sg-ana", "sg-luis"]);
    expect(doc(file).fields.every((f) => f.signerId === "sg-ana")).toBe(true);
  });

  it("quitar el archivo descarta su aviso", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    const file = pdf();
    const { rerender } = render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices).toHaveLength(1));
    rerender(<Harness files={[]} />);
    await waitFor(() => expect(api.controller.notices).toHaveLength(0));
  });
});

/* ------------------------------------------------------------------ *
 * F2-fix · MAYOR 1 y MAYOR 2: el trabajo de la persona no se pierde en silencio
 * ------------------------------------------------------------------ */

const DRAFT = { dataUrl: "data:image/png;base64,AAAA", ratio: 3 };

/** Aplica la plantilla de 2 firmantes (Coincide) y devuelve el archivo y los dos firmantes. */
async function appliedWithTwo(template = makeTemplate()) {
  mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match"), template));
  const file = pdf();
  render(<Harness files={[file]} />);
  await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
  const [ana, luis] = api.session().signers;
  return { file, docId: docIdOf(file), ana, luis };
}

/** La firma y las iniciales recogidas para un firmante (como las deja la ceremonia en su bloque). */
function sign(signerId: string, docId: string) {
  act(() =>
    api.bridge.commit((current) => ({
      blocks: current.blocks.map((block) => (block.signerId === signerId ? { ...block, signature: DRAFT, initials: DRAFT, stamps: { ...block.stamps, [docId]: "stamp" } } : block)),
    })),
  );
}
const rename = (signerId: string, name: string) => act(() => api.bridge.commit((current) => ({ signers: current.signers.map((s) => (s.id === signerId ? { ...s, name } : s)) })));
const blockOf = (signerId: string) => api.session().blocks.find((block) => block.signerId === signerId);

describe("cambiar el nº de firmantes no descarta trabajo en silencio (MAYOR 1)", () => {
  it("con la firma y las iniciales del firmante 2 recogidas, «1 firmante» NO lo quita: pide confirmar y lo dice", async () => {
    const { docId, luis } = await appliedWithTwo();
    sign(luis.id, docId);
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    expect(api.controller.notices[0].confirm).toMatchObject({ count: 1, loss: { signers: [{ id: luis.id, name: "Co-asegurado", strokes: true }], values: 0 } });
    // Nada cambio todavia: los dos firmantes, sus campos y sus trazos siguen ahi, y el aviso sigue en «2 firmantes».
    expect(api.session().signers.map((s) => s.id)).toHaveLength(2);
    expect(blockOf(luis.id)?.signature).toEqual(DRAFT);
    expect(api.controller.notices[0].count).toBe(2);
    expect(api.controller.notices[0].busy).toBe(false);
  });

  it("Cancelar conserva todo (firmantes, campos y trazos) y cierra la pregunta", async () => {
    const { file, docId, ana, luis } = await appliedWithTwo();
    rename(luis.id, "Marta Ruiz");
    sign(luis.id, docId);
    const fieldsBefore = doc(file).fields.map((f) => f.id);
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    act(() => api.controller.cancelChange(docId));
    expect(api.controller.notices[0].confirm).toBeNull();
    expect(api.session().signers.map((s) => s.id)).toEqual([ana.id, luis.id]);
    expect(api.session().signers[1].name).toBe("Marta Ruiz");
    expect(blockOf(luis.id)?.initials).toEqual(DRAFT);
    expect(doc(file).fields.map((f) => f.id)).toEqual(fieldsBefore);
    // Tampoco se re-aplica solo tras cancelar (el nº de firmantes de la sesion no cambio).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(api.controller.notices[0].confirm).toBeNull();
    expect(api.session().signers).toHaveLength(2);
  });

  it("Confirmar («Quitar y cambiar») quita SOLO lo anunciado: el firmante 2 y su firma; el firmante 1 conserva sus trazos", async () => {
    const { file, docId, ana, luis } = await appliedWithTwo();
    sign(ana.id, docId);
    sign(luis.id, docId);
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    act(() => api.controller.confirmChange(docId));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    expect(api.controller.notices[0].confirm).toBeNull();
    expect(api.session().signers.map((s) => s.id)).toEqual([ana.id]);
    expect(blockOf(luis.id)).toBeUndefined();
    expect(blockOf(ana.id)?.signature).toEqual(DRAFT);
    expect(doc(file).fields.every((f) => f.signerId === ana.id)).toBe(true);
  });

  it("un nombre real escrito para el firmante 2 (aunque no haya firmado) tambien pide confirmar", async () => {
    const { docId, luis } = await appliedWithTwo();
    rename(luis.id, "Marta Ruiz");
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm?.loss.signers).toEqual([{ id: luis.id, name: "Marta Ruiz", strokes: false }]));
    expect(api.session().signers).toHaveLength(2);
    expect(api.session().signers[1].name).toBe("Marta Ruiz");
  });

  it("los valores escritos en campos que la otra variante no tiene tambien piden confirmar", async () => {
    const template = makeTemplate();
    template.variants["2"].textFields = [{ id: "t-extra", pageIndex: 0, rect: R(0.1, 0.4, 0.3, 0.03), type: "text", label: "Nombre 2", required: false, source: "manual" }];
    const { file, docId } = await appliedWithTwo(template);
    const textId = doc(file).textFields[0].id;
    act(() => api.bridge.commit((current) => ({ docs: { ...current.docs, [docId]: { ...docStateOf(current.docs, docId), textValues: { [textId]: "Marta" } } } })));
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm?.loss).toMatchObject({ signers: [], values: 1 }));
    expect(doc(file).textValues[textId]).toBe("Marta");
    act(() => api.controller.cancelChange(docId));
    expect(doc(file).textValues[textId]).toBe("Marta");
  });

  it("sin nada que perder (nombres genericos, sin trazos del firmante 2) el cambio es inmediato y sin pregunta", async () => {
    const { docId, ana } = await appliedWithTwo();
    sign(ana.id, docId); // los trazos del que SE QUEDA no cuentan
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    expect(api.controller.notices[0].confirm).toBeNull();
    expect(api.session().signers).toHaveLength(1);
    expect(blockOf(ana.id)?.signature).toEqual(DRAFT);
  });

  it("subir de 1 a 2 firmantes nunca pregunta ni quita nada", async () => {
    const { docId, ana } = await appliedWithTwo();
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    sign(ana.id, docId);
    act(() => api.controller.setCount(docId, 2));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(2));
    expect(api.controller.notices[0].confirm).toBeNull();
    expect(api.session().signers).toHaveLength(2);
    expect(blockOf(ana.id)?.signature).toEqual(DRAFT);
  });

  it("mientras la pregunta esta abierta, tocar otra vez el segmento no hace nada", async () => {
    const { docId, luis } = await appliedWithTwo();
    sign(luis.id, docId);
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    const pending = api.controller.notices[0].confirm;
    act(() => api.controller.setCount(docId, 1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    // Ni cambia nada ni se vuelve a preguntar: es la MISMA pregunta (no se re-aplico).
    expect(api.session().signers).toHaveLength(2);
    expect(api.controller.notices[0].confirm).toBe(pending);
    expect(api.controller.notices[0].busy).toBe(false);
  });

  it("el automapeo tambien pide confirmar antes de quitar al firmante 2 con trazos", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a", { type: "signature", signerIndex: 0 }), field("b", { type: "signature", signerIndex: 1, rect: R(0.1, 0.5, 0.2, 0.04) })]));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    const docId = docIdOf(file);
    const [, luis] = api.session().signers;
    expect(luis).toBeDefined();
    sign(luis.id, docId);
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    expect(api.controller.notices[0].phase).toBe("automapped");
    expect(api.session().signers).toHaveLength(2);
    act(() => api.controller.confirmChange(docId));
    await waitFor(() => expect(api.session().signers).toHaveLength(1));
    expect(api.controller.notices[0].count).toBe(1);
  });
});

describe("«Deshacer» no toca lo que la persona ya aporto (MAYOR 2)", () => {
  it("tras firmar, Deshacer no borra trazos, firmantes, modo ni nombres: no hace nada y lo dice", async () => {
    const { file, docId, ana, luis } = await appliedWithTwo();
    rename(luis.id, "Marta Ruiz");
    sign(ana.id, docId);
    sign(luis.id, docId);
    const fields = doc(file).fields.length;
    act(() => api.controller.undo(docId));
    expect(api.session().mode).toBe("multi");
    expect(api.session().signers.map((s) => s.name)).toEqual(["Asegurado", "Marta Ruiz"]);
    expect(blockOf(ana.id)?.signature).toEqual(DRAFT);
    expect(blockOf(luis.id)?.initials).toEqual(DRAFT);
    expect(doc(file).fields).toHaveLength(fields);
    expect(api.controller.notices).toHaveLength(1);
    expect(api.controller.announcement).toBe(strings.template.undoBlockedAnnounce);
  });

  it("un nombre escrito sin firmar tampoco se pierde al deshacer", async () => {
    const { file, docId, ana } = await appliedWithTwo();
    rename(ana.id, "Ana López");
    act(() => api.controller.undo(docId));
    expect(api.session().signers[0].name).toBe("Ana López");
    expect(doc(file).fields.length).toBeGreaterThan(0);
  });

  it("un valor escrito en un campo de la plantilla tampoco se pierde al deshacer", async () => {
    const template = makeTemplate();
    template.variants["2"].textFields = [{ id: "t1", pageIndex: 0, rect: R(0.1, 0.4, 0.3, 0.03), type: "text", label: "Nombre", required: false, source: "manual" }];
    const { file, docId } = await appliedWithTwo(template);
    const textId = doc(file).textFields[0].id;
    act(() => api.bridge.commit((current) => ({ docs: { ...current.docs, [docId]: { ...docStateOf(current.docs, docId), textValues: { [textId]: "Marta" } } } })));
    act(() => api.controller.undo(docId));
    expect(doc(file).textValues[textId]).toBe("Marta");
    expect(doc(file).textFields).toHaveLength(1);
  });

  it("sin trabajo hecho Deshacer sigue funcionando como siempre", async () => {
    const { file, docId } = await appliedWithTwo();
    act(() => api.controller.undo(docId));
    expect(doc(file).fields).toHaveLength(0);
    expect(api.session().signers).toHaveLength(0);
    expect(api.session().mode).toBe("single");
    expect(api.controller.notices).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * F2-fix · MAYOR 3: el traspaso desde «Mis documentos» con la plantilla desactualizada
 * ------------------------------------------------------------------ */

describe("traspaso con la plantilla desactualizada (se reemplazó el PDF de «Mis documentos»)", () => {
  const BASE = sampleFingerprint(4, 5); // el PDF sobre el que se configuró la plantilla
  const stale = (over = {}) => ({ since: "2026-05-01T10:00:00.000Z", level: "none" as const, percent: 0, base: BASE, ...over });
  const libraryEntry = (templateStale?: unknown) => ({ id: "doc-lib", pageCount: 4, ...(templateStale ? { templateStale } : {}) });

  async function handoff(fingerprintOfRealPdf: unknown, templateStale: unknown = stale(), onStaleSkipped = vi.fn()) {
    mocks.getDocument.mockResolvedValue(libraryEntry(templateStale));
    mocks.getTemplateForDocument.mockResolvedValue(makeTemplate());
    mocks.computeFingerprint.mockResolvedValue(fingerprintOfRealPdf);
    const file = pdf();
    markFromLibrary(file, "doc-lib");
    return { file, onStaleSkipped, ...render(<Harness files={[file]} initial={{ mode: "multi" }} onStaleSkipped={onStaleSkipped} />) };
  }

  it("el PDF real se compara con el de la plantilla en vez de asumir «exacto»: otro contrato → NO se aplica la plantilla vieja y se avisa", async () => {
    const { file, onStaleSkipped } = await handoff(sampleFingerprint(4, 9));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(mocks.computeFingerprint).toHaveBeenCalledTimes(1);
    expect(doc(file).fields).toHaveLength(0);
    expect(api.controller.notices.some((n) => n.record?.source === "template")).toBe(false);
    expect(onStaleSkipped).toHaveBeenCalledWith("contrato.pdf");
  });

  it("otro contrato: se ofrece el automapeo (lo que aplica es lo detectado, nunca el mapa identidad de la plantilla vieja)", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a")]));
    const { file } = await handoff(sampleFingerprint(4, 9));
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(mocks.autoMapFile).toHaveBeenCalled();
    expect(api.controller.notices[0].record?.source).toBe("automap");
    expect(doc(file).fields).toHaveLength(1);
  });

  it("el mismo contrato (aunque con otros bytes) → «Coincide»: se aplica con el mapa de paginas real, no como «exacto» al 100 % por defecto", async () => {
    const { file } = await handoff({ ...BASE, exact: "f".repeat(64) });
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(mocks.computeFingerprint).toHaveBeenCalledTimes(1);
    const lookup = api.controller.notices[0].lookup!;
    expect(lookup.level).toBe("match");
    expect(lookup.match).not.toBeNull();
    expect(lookup.match?.mappedPages).toEqual([0, 1, 2, 3]);
    expect(doc(file).fields.length).toBeGreaterThan(0);
  });

  it("«Parece» (≥ 75 % pero no todas las paginas coinciden) → pregunta y no aplica nada hasta decir «Usar»", async () => {
    const changed = { ...BASE, exact: "e".repeat(64), pages: [BASE.pages[0], BASE.pages[1], BASE.pages[2], sampleFingerprint(4, 21).pages[3]] };
    const { file } = await handoff(changed);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("asking"));
    expect(api.controller.notices[0].lookup?.level).toBe("similar");
    expect(doc(file).fields).toHaveLength(0);
  });

  it("con la plantilla al día (sin aviso) todo sigue igual: mismo documento, «exacto», sin calcular huella", async () => {
    mocks.getDocument.mockResolvedValue(libraryEntry());
    mocks.getTemplateForDocument.mockResolvedValue(makeTemplate());
    const file = pdf();
    markFromLibrary(file, "doc-lib");
    render(<Harness files={[file]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(mocks.computeFingerprint).not.toHaveBeenCalled();
    expect(api.controller.notices[0].lookup?.level).toBe("exact");
    expect(api.controller.notices[0].lookup?.match).toBeNull();
  });

  it("si la plantilla desactualizada no coincide y el automapeo esta apagado, no pasa nada (la persona sigue a mano) y el aviso sale igual", async () => {
    mocks.getDocument.mockResolvedValue(libraryEntry(stale()));
    mocks.getTemplateForDocument.mockResolvedValue(makeTemplate());
    mocks.computeFingerprint.mockResolvedValue(sampleFingerprint(4, 9));
    const onStaleSkipped = vi.fn();
    const file = pdf();
    markFromLibrary(file, "doc-lib");
    render(<Harness files={[file]} detectEnabled={false} onStaleSkipped={onStaleSkipped} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(onStaleSkipped).toHaveBeenCalledTimes(1);
    expect(api.controller.notices).toHaveLength(0);
    expect(doc(file).fields).toHaveLength(0);
  });
});

describe("el tope de campos por documento llega a la interfaz (m3)", () => {
  const withCap = (fields: AutoMapResult["fields"], uncovered: number[]): AutoMapResult => ({
    ...autoResult(fields),
    pages: [0, 1, 2, 3].map((pageIndex) => ({ pageIndex, hasInitialsLine: !uncovered.includes(pageIndex), signatureLines: 0 })),
    warnings: [{ code: "document-field-cap", message: "El documento tenía 120 propuestas; se conservan las 80 más fiables." }],
  });

  it("con `document-field-cap` el aviso lleva cuántos campos se colocaron y qué páginas quedaron sin iniciales", async () => {
    mocks.autoMapFile.mockResolvedValue(withCap([field("a"), field("b", { pageIndex: 1 })], [2, 3]));
    render(<Harness files={[pdf()]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(api.controller.notices[0].cap).toEqual({ placed: 2, pages: [2, 3] });
  });

  it("sin el aviso del tope no hay `cap`; el tope por página (solo recorta una página) tampoco lo activa", async () => {
    mocks.autoMapFile.mockResolvedValue({ ...autoResult([field("a")]), warnings: [{ code: "page-field-cap", pageIndex: 0, message: "x" }] });
    render(<Harness files={[pdf()]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    expect(api.controller.notices[0].cap).toBeNull();
  });

  it("una plantilla aplicada nunca lleva `cap`", async () => {
    mocks.findTemplateForFingerprint.mockResolvedValue(lookupOf(matchOf("match")));
    render(<Harness files={[pdf()]} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(api.controller.notices[0].cap).toBeNull();
  });
});

describe("guardar como plantilla conserva la otra variante (m2)", () => {
  it("el controlador pide conservar la otra variante al guardar lo mapeado solo (y guarda la variante del nº de firmantes usado)", async () => {
    mocks.autoMapFile.mockResolvedValue(autoResult([field("a")]));
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.offerSave).toBe("available"));
    mocks.saveTemplateToLibrary.mockResolvedValue({ ok: true, pages: 1 });
    act(() => api.controller.saveAsTemplate(docIdOf(file)));
    await waitFor(() => expect(api.controller.notices[0].offerSave).toBe("saved"));
    expect(mocks.saveTemplateToLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.saveTemplateToLibrary.mock.calls[0][0]).toMatchObject({ documentId: null, template: null, keepOtherVariant: true });
    const content = mocks.saveTemplateToLibrary.mock.calls[0][0].content;
    expect(content.variants["1"].fields).toHaveLength(1);
    expect(content.variants["2"].fields).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * F2 (2ª ronda): las firmas del que se queda sobreviven, aplicar lo guardado no duplica, un firmante compartido no se retira
 * ------------------------------------------------------------------ */

const KEY = "fp-contrato";
/** Firma e iniciales con un sello VIGENTE sobre los huecos de ahora (como los deja la ceremonia). */
function signValid(signerId: string, docId: string) {
  act(() =>
    api.bridge.commit((current) => {
      const fields = liveFields(docStateOf(current.docs, docId), current.signers);
      return { blocks: current.blocks.map((block) => (block.signerId === signerId ? { ...block, signature: DRAFT, initials: DRAFT, stamps: { ...block.stamps, [docId]: captureStamp(KEY, fields, signerId) } } : block)) };
    }),
  );
}
/** ¿La ceremonia da por terminado a este firmante con los huecos de ahora? (el predicado REAL de la pantalla) */
function done(signerId: string, docId: string): boolean {
  const { signers, docs, blocks } = api.session();
  return isSignerDone(blocks, signerId, { signers, docs, keys: { [docId]: KEY } });
}

describe("F1 · cambiar de variante con huecos distintos no invalida la firma del que se queda", () => {
  it("2 → 1 (Quitar y cambiar): el firmante 1 sigue firmado aunque sus iniciales cambien de tamano; el 2 se va", async () => {
    const { file, docId, ana, luis } = await appliedWithTwo();
    signValid(ana.id, docId);
    signValid(luis.id, docId);
    expect(done(ana.id, docId) && done(luis.id, docId)).toBe(true);
    const widthBefore = doc(file).fields.find((f) => f.signerId === ana.id && f.type === "initials")!.rect.width;
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    // La hoja habla solo del firmante 2: al 1 no le pasa nada.
    expect(api.controller.notices[0].confirm?.loss.signers.map((s) => s.name)).toEqual(["Co-asegurado"]);
    act(() => api.controller.confirmChange(docId));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    expect(doc(file).fields.find((f) => f.signerId === ana.id && f.type === "initials")!.rect.width).not.toBe(widthBefore);
    expect(done(ana.id, docId)).toBe(true);
    expect(blockOf(ana.id)).toMatchObject({ signature: DRAFT, initials: DRAFT });
  });

  it("1 → 2 con la firma del firmante 1 ya recogida: sigue valiendo y no se pide nada; el 2 nace pendiente", async () => {
    const { file, docId, ana } = await appliedWithTwo();
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(1));
    signValid(ana.id, docId);
    expect(done(ana.id, docId)).toBe(true);
    act(() => api.controller.setCount(docId, 2));
    await waitFor(() => expect(api.controller.notices[0].count).toBe(2));
    expect(api.controller.notices[0].confirm).toBeNull();
    expect(done(ana.id, docId)).toBe(true);
    const luis = api.session().signers[1];
    expect(done(luis.id, docId)).toBe(false);
    expect(doc(file).fields).toHaveLength(10);
  });

  it("el automapeo (huecos de 1 y de 2 distintos) tambien conserva la firma del firmante 1", async () => {
    mocks.autoMapFile.mockImplementation(async (_file: File, options: { signers: number }) =>
      autoResult(options.signers === 1 ? [field("a", { rect: R(0.74, 0.885, 0.13, 0.045) })] : [field("a", { rect: R(0.74, 0.885, 0.0585, 0.045) }), field("b", { signerIndex: 1, rect: R(0.81, 0.885, 0.0585, 0.045) })]),
    );
    const file = pdf();
    render(<Harness files={[file]} initial={{ mode: "multi" }} />);
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("automapped"));
    const docId = docIdOf(file);
    const [ana, luis] = api.session().signers;
    signValid(ana.id, docId);
    signValid(luis.id, docId);
    act(() => api.controller.setCount(docId, 1));
    await waitFor(() => expect(api.controller.notices[0].confirm).not.toBeNull());
    act(() => api.controller.confirmChange(docId));
    await waitFor(() => expect(api.session().signers).toHaveLength(1));
    expect(done(ana.id, docId)).toBe(true);
    expect(doc(file).fields[0].rect.width).toBe(0.13);
  });
});

describe("F2 · «Firmar este documento» tras guardar la plantilla, sin aviso previo (borrador restaurado)", () => {
  it("no duplica los campos ni invalida las firmas de los dos firmantes", async () => {
    // El estado de un borrador restaurado: los campos y las firmas ya estan, pero no hay ningun registro del aviso.
    const template = makeTemplate();
    const file = pdf("restaurado.pdf");
    const docId = docIdOf(file);
    const base = { ...DEFAULT_SESSION, docOrder: [docId], activeDocId: docId };
    const plan = planTemplateApplication({ template, match: null, count: 2, session: base, docId, pageCount: 4, mint: { signerId: () => `sg-${Math.random()}`, fieldId: () => `fld-${Math.random()}`, textFieldId: () => `txt-${Math.random()}` } });
    const restored = { ...base, ...plan.patch } as SignSession;
    const withStrokes = {
      ...restored,
      blocks: restored.blocks.map((block) => ({ ...block, signature: DRAFT, initials: DRAFT, stamps: { [docId]: captureStamp(KEY, liveFields(docStateOf(restored.docs, docId), restored.signers), block.signerId) } })),
    };
    markRestored([file]);
    render(<Harness files={[file]} initial={withStrokes} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(api.controller.notices).toHaveLength(0);
    const idsBefore = doc(file).fields.map((f) => f.id).sort();
    expect(idsBefore).toHaveLength(10);
    const [ana, luis] = api.session().signers;
    expect(done(ana.id, docId) && done(luis.id, docId)).toBe(true);
    // El editor guarda lo mismo que habia y se pulsa «Firmar este documento».
    act(() => api.controller.applySaved(docId, template, "doc-lib", 4));
    await waitFor(() => expect(api.controller.notices[0]?.phase).toBe("applied"));
    expect(doc(file).fields).toHaveLength(10);
    expect(doc(file).fields.map((f) => f.id).sort()).toEqual(idsBefore);
    expect(api.session().signers.map((s) => s.id)).toEqual([ana.id, luis.id]);
    expect(done(ana.id, docId) && done(luis.id, docId)).toBe(true);
    expect(api.controller.notices[0].confirm).toBeNull();
  });

  it("con un aviso previo y campos aceptados a mano despues, tampoco se duplica nada", async () => {
    const { file, docId } = await appliedWithTwo();
    const manual = { id: "fld-aceptado", signerId: api.session().signers[0].id, pageIndex: 1, type: "signature" as const, rect: R(0.3, 0.3, 0.2, 0.05) };
    act(() => api.bridge.commit((current) => ({ docs: { ...current.docs, [docId]: { ...docStateOf(current.docs, docId), fields: [...docStateOf(current.docs, docId).fields, manual] } } })));
    const before = doc(file).fields.length;
    // El editor se abrio con ese campo y la plantilla guardada lo trae (en su sitio).
    const saved = makeTemplate();
    saved.variants["2"].fields = [...saved.variants["2"].fields, { id: "tf-nuevo", roleIndex: 0, pageIndex: 1, type: "signature", rect: manual.rect, required: true, source: "manual" }];
    act(() => api.controller.applySaved(docId, saved, "doc-lib", 4));
    await waitFor(() => expect(doc(file).fields.length).toBe(before));
    expect(doc(file).fields.filter((f) => f.pageIndex === 1 && f.type === "signature")).toHaveLength(1);
  });
});

describe("F2 · aplicar lo guardado que quitaria un valor escrito pide confirmar y, al confirmar, tampoco duplica", () => {
  it("un valor escrito en un campo de texto que la plantilla guardada ya no tiene: se pregunta; Cancelar no toca nada; Confirmar reemplaza sin duplicar", async () => {
    const template = makeTemplate();
    const file = pdf("restaurado.pdf");
    const docId = docIdOf(file);
    const base = { ...DEFAULT_SESSION, docOrder: [docId], activeDocId: docId };
    const typedTemplate = makeTemplate();
    typedTemplate.variants["2"].textFields = [{ id: "t-old", pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.03), type: "text", label: "Nombre", required: false, source: "manual" }];
    const mint = { signerId: () => `sg-${Math.random()}`, fieldId: () => `fld-${Math.random()}`, textFieldId: () => `txt-${Math.random()}` };
    const plan = planTemplateApplication({ template: typedTemplate, match: null, count: 2, session: base, docId, pageCount: 4, mint });
    const textId = plan.record.textFieldIds[0];
    const restored = { ...base, ...plan.patch, docs: { [docId]: { ...docStateOf(plan.patch.docs!, docId), textValues: { [textId]: "Marta" } } } } as SignSession;
    markRestored([file]);
    render(<Harness files={[file]} initial={restored} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    // El editor movio el campo de texto a otro sitio: la plantilla guardada no tiene el de antes.
    template.variants["2"].textFields = [{ id: "t-new", pageIndex: 0, rect: R(0.1, 0.6, 0.3, 0.03), type: "text", label: "Nombre", required: false, source: "manual" }];
    const idsBefore = doc(file).fields.map((f) => f.id).sort();
    act(() => api.controller.applySaved(docId, template, "doc-lib", 4));
    await waitFor(() => expect(api.controller.notices[0]?.confirm).toBeTruthy());
    expect(api.controller.notices[0].confirm).toMatchObject({ loss: { values: 1 }, replaceDocument: true });
    expect(doc(file).textValues[textId]).toBe("Marta");
    act(() => api.controller.cancelChange(docId));
    expect(doc(file).fields.map((f) => f.id).sort()).toEqual(idsBefore);
    act(() => api.controller.applySaved(docId, template, "doc-lib", 4));
    await waitFor(() => expect(api.controller.notices[0]?.confirm).toBeTruthy());
    act(() => api.controller.confirmChange(docId));
    await waitFor(() => expect(api.controller.notices[0]?.record).not.toBeNull());
    expect(doc(file).fields).toHaveLength(10);
    expect(doc(file).fields.map((f) => f.id).sort()).toEqual(idsBefore);
    expect(doc(file).textFields).toHaveLength(1);
    expect(doc(file).textFields[0].rect.y).toBe(0.6);
  });
});

describe("F3 · dos documentos con firmantes compartidos", () => {
  it("bajar A a 1 firmante no retira al firmante 2 si B tiene campos manuales suyos: lo anuncia y no deja huerfanos", async () => {
    const a = pdf("a.pdf");
    const b = pdf("b.pdf");
    mocks.computeFingerprint.mockImplementation(async (file: File) => ({ pageCount: 4, name: file.name }));
    mocks.findTemplateForFingerprint.mockImplementation(async (fp: { name: string }) => (fp.name.startsWith("a") ? lookupOf(matchOf("match")) : null));
    render(<Harness files={[a, b]} />);
    await waitFor(() => expect(api.controller.notices.filter((n) => n.phase === "applied")).toHaveLength(1));
    const [, luis] = api.session().signers;
    const idB = docIdOf(b);
    act(() =>
      api.bridge.commit((current) => ({
        docs: { ...current.docs, [idB]: { ...docStateOf(current.docs, idB), fields: [{ id: "man-1", signerId: luis.id, pageIndex: 0, type: "signature", rect: R(0.5, 0.5, 0.2, 0.05) }] } },
      })),
    );
    const idA = docIdOf(a);
    act(() => api.controller.setCount(idA, 1));
    await waitFor(() => expect(api.controller.notices.find((n) => n.docId === idA)?.count).toBe(1));
    expect(api.session().signers.map((s) => s.id)).toContain(luis.id);
    expect(liveFields(docStateOf(api.session().docs, idB), api.session().signers).map((f) => f.id)).toEqual(["man-1"]);
    const notice = api.controller.notices.find((n) => n.docId === idA)!;
    expect(notice.record?.keptSigners).toEqual(["Co-asegurado"]);
    expect(notice.confirm).toBeNull();
    expect(api.controller.announcement).toContain("Co-asegurado");
    // Nada se re-aplica solo en bucle: el nº de firmantes de la sesion sigue siendo 2 y el aviso sigue en 1.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(api.controller.notices.find((n) => n.docId === idA)?.count).toBe(1);
    expect(api.session().signers).toHaveLength(2);
  });
});
