import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditDraftSummary } from "@/app/edit-pdf/editDrafts";
import { freshLibrary, seedDocument } from "@/app/documents/documents.testkit";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import type { DraftEntry, SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import { resetSignHandoffForTests, SIGN_HANDOFF_KEY } from "@/lib/docLibrary/signHandoff";
import { listDocuments } from "@/lib/docLibrary/store";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { addRecentEntry, clearRecentEntries, RECENT_STORAGE_KEY } from "@/lib/recent";

/**
 * Recientes UNIFICADO (U2.6): borradores + historial en un solo indice por fecha, «Continuar» solo con puntero
 * verificable, «Abrir de nuevo» con la copia de Mis documentos (misma huella), «Borrar» por fila y «Borrar todo».
 * Los almacenes de borradores se simulan; la biblioteca de documentos es la REAL (fake-indexeddb).
 */

const HEX = (char: string) => char.repeat(64);
const SESSION_ID = "s-mgx4k2w1-1a2b3c4d";

const stores = vi.hoisted(() => ({
  sign: [] as unknown[],
  edit: [] as unknown[],
  pro: [] as unknown[],
  deleteSession: vi.fn<(id: string) => Promise<void>>(async () => {}),
  deleteSign: vi.fn<(id: string) => Promise<void>>(async () => {}),
  deleteEdit: vi.fn<(id: string) => Promise<{ ok: true }>>(async () => ({ ok: true })),
  deletePro: vi.fn<(id: string) => Promise<{ ok: true }>>(async () => ({ ok: true })),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: stores.push }), usePathname: () => "/recent" }));
vi.mock("@/app/sign-pdf/signDrafts", () => ({
  listAllDrafts: vi.fn(async () => stores.sign),
  subscribeToDrafts: vi.fn(() => () => {}),
  deleteSessionDraft: (id: string) => stores.deleteSession(id),
  deleteDraft: (id: string) => stores.deleteSign(id),
}));
vi.mock("@/app/edit-pdf/editDrafts", () => ({
  listEditDrafts: vi.fn(async () => stores.edit),
  subscribeToEditDrafts: vi.fn(() => () => {}),
  deleteEditDraft: (id: string) => stores.deleteEdit(id),
}));
vi.mock("@/app/pdf-pro/proDrafts", () => ({
  listProDrafts: vi.fn(async () => stores.pro),
  subscribeToProDrafts: vi.fn(() => () => {}),
  deleteProDraft: (id: string) => stores.deletePro(id),
}));
vi.mock("@/app/pdf-pro/session/useDraftThumbnails", () => ({ useDraftThumbnails: () => ({}) }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: vi.fn(async () => "data:image/jpeg;base64,AAAA") }));

const session = (savedAt: string): DraftEntry => ({
  kind: "session",
  meta: {
    kind: "session",
    id: SESSION_ID,
    savedAt,
    documents: [
      { id: "doc-1", fileName: "Contrato A.pdf", fileSize: 10 },
      { id: "doc-2", fileName: "Anexo B.pdf", fileSize: 10 },
    ],
    fileName: "Contrato A.pdf",
  } as unknown as SessionDraftMeta,
});
const editDraft = (over: Partial<EditDraftSummary> = {}): EditDraftSummary => ({
  schema: 1,
  id: HEX("b"),
  fileName: "informe.pdf",
  fileSize: 10,
  totalBytes: 10,
  savedAt: "2026-10-14T11:00:00.000Z",
  pageCount: 2,
  currentPage: 0,
  pendingCount: 3,
  ...over,
});
const proDraft = (over: Partial<ProDraftSummary> = {}): ProDraftSummary => ({
  schema: 1,
  id: HEX("c"),
  fileName: "factura.pdf",
  fileSize: 10,
  savedAt: "2026-10-14T08:00:00.000Z",
  pageCount: 2,
  currentPage: 0,
  steps: 1,
  ...over,
});

/** Historial con fecha elegida (el modulo siempre pone `new Date()`): se escribe y se recarga la cache. */
function setHistory(entries: Array<{ id: string; slug: string; fileName: string; date: string; resume?: unknown }>) {
  window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(entries));
}

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(async () => {
  freshLibrary();
  resetSignHandoffForTests();
  clearRecentEntries();
  stores.sign = [];
  stores.edit = [];
  stores.pro = [];
  for (const spy of [stores.deleteSession, stores.deleteSign, stores.deleteEdit, stores.deletePro, stores.push]) spy.mockClear();
});
afterEach(cleanup);

async function renderRecent() {
  // El historial vive en una cache de modulo: se vuelve a leer del almacenamiento que dejo el caso.
  vi.resetModules();
  const view = await import("@/components/views/RecentView");
  const i18n = await import("@/lib/i18n");
  return render(
    <i18n.LanguageProvider>
      <view.RecentView />
    </i18n.LanguageProvider>,
  );
}

const rowsOf = () => Array.from(document.querySelectorAll<HTMLElement>("main li, li")).filter((li) => li.querySelector("[data-recent-status]"));
const nameOf = (li: HTMLElement) => li.querySelector("[title]")?.textContent;

describe("Recientes unificado — orden, estado y aviso", () => {
  it("lista borradores e historial juntos, cada grupo del más reciente al más antiguo, con su estado", async () => {
    stores.sign = [session("2026-10-14T10:00:00.000Z")];
    stores.edit = [editDraft()];
    stores.pro = [proDraft()];
    setHistory([
      { id: "h1", slug: "merge-pdf", fileName: "unido.pdf", date: "2026-10-14T09:00:00.000Z" },
      { id: "h2", slug: "rotate-pdf", fileName: "girado.pdf", date: "2026-10-13T09:00:00.000Z" },
    ]);
    await renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const rows = rowsOf();
    expect(rows.map(nameOf)).toEqual(["informe.pdf", "Contrato A.pdf", "factura.pdf", "unido.pdf", "girado.pdf"]);
    const statuses = rows.map((li) => li.querySelector("[data-recent-status]")?.getAttribute("data-recent-status"));
    expect(statuses).toEqual(["unfinished", "unfinished", "unfinished", "finished", "finished"]);
    expect(within(rows[0]).getByText(es.recent.statusUnfinished)).toBeTruthy();
    expect(within(rows[3]).getByText(es.recent.statusFinished)).toBeTruthy();
    // Herramienta y fecha en cada fila.
    expect(rows[3].textContent).toContain("Unir PDF");
    expect(rows[3].textContent).toMatch(/2026/);
  });

  it("aviso fijo «Solo en este navegador», también sin nada que listar", async () => {
    await renderRecent();
    await screen.findByText(es.recent.empty);
    const notice = document.querySelector("[data-recent-local]") as HTMLElement;
    expect(within(notice).getByText("Solo en este navegador")).toBeTruthy();
    expect(es.recent.localOnly).toBe("Solo en este navegador");
  });

  it("una sola región viva en la página", async () => {
    stores.edit = [editDraft()];
    await renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    expect(document.querySelectorAll('[role="status"], [aria-live], [role="alert"]')).toHaveLength(1);
  });

  it("el historial guarda como mucho 20 entradas", async () => {
    for (let i = 0; i < 25; i += 1) addRecentEntry("merge-pdf", `f${i}.pdf`);
    await renderRecent();
    await screen.findByRole("heading", { name: es.recent.historyTitle });
    expect(rowsOf()).toHaveLength(20);
    expect(rowsOf().map(nameOf)).toContain("f24.pdf");
    expect(rowsOf().map(nameOf)).not.toContain("f0.pdf");
  });
});

describe("«Continuar» solo con un puntero verificable", () => {
  it("hay un «Continuar» por cada borrador y NINGUNO en las filas del historial", async () => {
    stores.sign = [session("2026-10-14T10:00:00.000Z")];
    stores.edit = [editDraft()];
    setHistory([
      { id: "h1", slug: "merge-pdf", fileName: "unido.pdf", date: "2026-10-14T09:00:00.000Z" },
      // Apunta a un borrador que ya no existe: no se promete nada.
      { id: "h2", slug: "edit-pdf", fileName: "perdido.pdf", date: "2026-10-14T08:00:00.000Z", resume: { kind: "edit", id: HEX("9") } },
      // Puntero manipulado: se descarta al leer.
      { id: "h3", slug: "pdf-pro", fileName: "raro.pdf", date: "2026-10-14T07:00:00.000Z", resume: { kind: "__proto__", id: "<script>" } },
    ]);
    await renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const links = screen.getAllByRole("link", { name: es.common.continueLabel });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      `/edit-pdf?resume=edit:${HEX("b")}`,
      `/sign-pdf?resume=session:${SESSION_ID}`,
    ]);
    for (const li of rowsOf().filter((row) => row.querySelector('[data-recent-status="finished"]'))) {
      expect(within(li).queryByRole("link", { name: es.common.continueLabel })).toBeNull();
      expect(within(li).queryByRole("button", { name: es.common.continueLabel })).toBeNull();
    }
  });

  it("un historial que apunta a un borrador VIVO sale una sola vez, como «Sin terminar», y con «Continuar»", async () => {
    stores.edit = [editDraft()];
    setHistory([{ id: "h1", slug: "edit-pdf", fileName: "informe.pdf", date: "2026-10-14T12:00:00.000Z", resume: { kind: "edit", id: HEX("b") } }]);
    await renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    expect(screen.getAllByText("informe.pdf")).toHaveLength(1);
    expect(rowsOf()[0].querySelector("[data-recent-status]")?.getAttribute("data-recent-status")).toBe("unfinished");
    expect(screen.getAllByRole("link", { name: es.common.continueLabel })).toHaveLength(1);
  });
});

describe("«Abrir de nuevo» con la copia de Mis documentos", () => {
  const exact = (seed: number) => seed.toString(16).padStart(64, "0");

  it("si la huella coincide con un documento: botón «Abrir de nuevo» que deja el traspaso y abre Firmar con esa copia", async () => {
    await seedDocument("lib-1", { name: "Contrato de servicio", seed: 21 });
    setHistory([{ id: "h1", slug: "sign-pdf", fileName: "Firmado.pdf", date: "2026-10-14T09:00:00.000Z", resume: { kind: "sign", id: exact(21) } }]);
    await renderRecent();
    const reopen = await screen.findByRole("button", { name: es.recent.reopen });
    expect(within(reopen.closest("li") as HTMLElement).getByText(es.recent.reopenHint)).toBeTruthy();
    expect(within(reopen.closest("li") as HTMLElement).queryByRole("link", { name: es.recent.openTool })).toBeNull();
    fireEvent.click(reopen);
    expect(stores.push).toHaveBeenCalledWith("/sign-pdf");
    expect(JSON.parse(window.sessionStorage.getItem(SIGN_HANDOFF_KEY) ?? "null")).toMatchObject({ documentIds: ["lib-1"], mode: "sign" });
  });

  it("sin coincidencia de huella: «Abrir herramienta» (la herramienta pide el archivo) y nada de «Abrir de nuevo»", async () => {
    await seedDocument("lib-1", { name: "Contrato de servicio", seed: 21 });
    setHistory([{ id: "h1", slug: "sign-pdf", fileName: "Firmado.pdf", date: "2026-10-14T09:00:00.000Z", resume: { kind: "sign", id: exact(22) } }]);
    await renderRecent();
    await screen.findByText("Firmado.pdf");
    // Espera a que la biblioteca se haya leido antes de afirmar que NO hay coincidencia.
    await waitFor(async () => expect((await listDocuments()).documents).toHaveLength(1));
    const row = screen.getByText("Firmado.pdf").closest("li") as HTMLElement;
    expect(within(row).getByRole("link", { name: es.recent.openTool }).getAttribute("href")).toBe("/sign-pdf");
    expect(screen.queryByRole("button", { name: es.recent.reopen })).toBeNull();
  });

  it("un historial de Firmar sin puntero no puede coincidir con nada", async () => {
    await seedDocument("lib-1", { name: "Contrato de servicio", seed: 21 });
    setHistory([{ id: "h1", slug: "sign-pdf", fileName: "Firmados.zip", date: "2026-10-14T09:00:00.000Z" }]);
    await renderRecent();
    await screen.findByText("Firmados.zip");
    expect(screen.queryByRole("button", { name: es.recent.reopen })).toBeNull();
  });

  it("la fila con copia muestra su miniatura", async () => {
    await seedDocument("lib-1", { name: "Contrato de servicio", seed: 21 });
    setHistory([{ id: "h1", slug: "sign-pdf", fileName: "Firmado.pdf", date: "2026-10-14T09:00:00.000Z", resume: { kind: "sign", id: exact(21) } }]);
    await renderRecent();
    await screen.findByRole("button", { name: es.recent.reopen });
    await waitFor(() => expect(document.querySelector("img[data-doc-thumb]")).not.toBeNull());
  });
});

describe("Mis documentos no cuenta como «reciente» por existir", () => {
  it("con documentos en la biblioteca y ningún trabajo, Recientes sigue vacío", async () => {
    await seedDocument("lib-1", { name: "Contrato de servicio" });
    await seedDocument("lib-2", { name: "Otro contrato" });
    await renderRecent();
    expect(await screen.findByText(es.recent.empty)).toBeTruthy();
    await waitFor(async () => expect((await listDocuments()).documents).toHaveLength(2));
    expect(screen.queryByText("Contrato de servicio")).toBeNull();
    expect(rowsOf()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: es.recent.clearAll })).toBeNull();
  });
});

describe("Borrar", () => {
  it("«Borrar» en una fila del historial la quita (y solo esa), lo anuncia y el foco no cae a <body>", async () => {
    setHistory([
      { id: "h1", slug: "merge-pdf", fileName: "uno.pdf", date: "2026-10-14T09:00:00.000Z" },
      { id: "h2", slug: "rotate-pdf", fileName: "dos.pdf", date: "2026-10-13T09:00:00.000Z" },
    ]);
    await renderRecent();
    await screen.findByText("uno.pdf");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: es.recent.removeRow.replace("{name}", "uno.pdf") }));
    });
    await waitFor(() => expect(screen.queryByText("uno.pdf")).toBeNull());
    expect(screen.getByText("dos.pdf")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]").map((e: { id: string }) => e.id)).toEqual(["h2"]);
    expect(screen.getByRole("status").textContent).toBe(es.recent.removed);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("«Borrar» no toca ningún borrador ni la biblioteca", async () => {
    stores.edit = [editDraft()];
    await seedDocument("lib-1", { name: "Contrato de servicio" });
    setHistory([{ id: "h1", slug: "merge-pdf", fileName: "uno.pdf", date: "2026-10-14T09:00:00.000Z" }]);
    await renderRecent();
    await screen.findByText("uno.pdf");
    fireEvent.click(screen.getByRole("button", { name: es.recent.removeRow.replace("{name}", "uno.pdf") }));
    await waitFor(() => expect(screen.queryByText("uno.pdf")).toBeNull());
    expect(stores.deleteEdit).not.toHaveBeenCalled();
    expect((await listDocuments()).documents).toHaveLength(1);
    expect(screen.getByText("informe.pdf")).toBeTruthy();
  });

  it("«Borrar todo» pide confirmación; «Cancelar» no borra nada", async () => {
    stores.edit = [editDraft()];
    setHistory([{ id: "h1", slug: "merge-pdf", fileName: "uno.pdf", date: "2026-10-14T09:00:00.000Z" }]);
    await renderRecent();
    await screen.findByText("uno.pdf");
    fireEvent.click(screen.getByRole("button", { name: es.recent.clearAll }));
    const dialog = await screen.findByRole("dialog", { name: es.recent.clearAllTitle });
    expect(within(dialog).getByText(es.recent.clearAllBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: es.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores.deleteEdit).not.toHaveBeenCalled();
    expect(screen.getByText("uno.pdf")).toBeTruthy();
    expect(screen.getByText("informe.pdf")).toBeTruthy();
  });

  it("confirmar «Borrar todo» descarta TODOS los borradores y el historial, y deja Mis documentos intacto", async () => {
    stores.sign = [session("2026-10-14T10:00:00.000Z")];
    stores.edit = [editDraft()];
    stores.pro = [proDraft()];
    await seedDocument("lib-1", { name: "Contrato de servicio" });
    setHistory([{ id: "h1", slug: "merge-pdf", fileName: "uno.pdf", date: "2026-10-14T09:00:00.000Z" }]);
    await renderRecent();
    await screen.findByText("uno.pdf");
    fireEvent.click(screen.getByRole("button", { name: es.recent.clearAll }));
    const dialog = await screen.findByRole("dialog", { name: es.recent.clearAllTitle });
    // Al refrescar, los almacenes ya no tienen nada.
    stores.sign = [];
    stores.edit = [];
    stores.pro = [];
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: es.recent.clearAllConfirm }));
    });
    await waitFor(() => expect(stores.deleteSession).toHaveBeenCalledWith(SESSION_ID));
    expect(stores.deleteEdit).toHaveBeenCalledWith(HEX("b"));
    expect(stores.deletePro).toHaveBeenCalledWith(HEX("c"));
    await waitFor(() => expect(screen.getByText(es.recent.empty)).toBeTruthy());
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(es.recent.clearAllDone);
    expect((await listDocuments()).documents).toHaveLength(1);
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });

  it("«Borrar historial» sigue borrando solo el historial", async () => {
    stores.edit = [editDraft()];
    setHistory([{ id: "h1", slug: "merge-pdf", fileName: "uno.pdf", date: "2026-10-14T09:00:00.000Z" }]);
    await renderRecent();
    await screen.findByText("uno.pdf");
    fireEvent.click(screen.getByRole("button", { name: es.recent.clear }));
    await waitFor(() => expect(screen.queryByText("uno.pdf")).toBeNull());
    expect(screen.getByText("informe.pdf")).toBeTruthy();
    expect(stores.deleteEdit).not.toHaveBeenCalled();
  });
});
