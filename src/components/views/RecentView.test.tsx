import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditDraftSummary } from "@/app/edit-pdf/editDrafts";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import type { DraftEntry, DraftMeta, SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import { RecentView } from "@/components/views/RecentView";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { addRecentEntry, clearRecentEntries } from "@/lib/recent";

/**
 * Recientes (U0.6): «Sin terminar» sale de los borradores REALES de Firmar, Editar y PDF Pro; «Continuar» enlaza a
 * `/{herramienta}?resume=<tipo>:<id>`; el historial sin estado dice «Abrir herramienta»; «Descartar» borra el borrador.
 * Los tres almacenes se simulan (su logica ya tiene sus propias pruebas con fake-indexeddb).
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
  thumbs: {} as Record<string, string | null>,
}));

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
vi.mock("@/app/pdf-pro/session/useDraftThumbnails", () => ({
  useDraftThumbnails: () => stores.thumbs,
}));

function session(overrides: Partial<SessionDraftMeta> = {}): DraftEntry {
  return {
    kind: "session",
    meta: {
      kind: "session",
      id: SESSION_ID,
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
    } as SessionDraftMeta,
  };
}

function single(overrides: Partial<DraftMeta> = {}): DraftEntry {
  return {
    kind: "document",
    meta: {
      id: HEX("a"),
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
    } as DraftMeta,
  };
}

const editDraft = (overrides: Partial<EditDraftSummary> = {}): EditDraftSummary => ({
  schema: 1,
  id: HEX("b"),
  fileName: "informe.pdf",
  fileSize: 10,
  totalBytes: 10,
  savedAt: "2026-10-14T11:00:00.000Z",
  pageCount: 2,
  currentPage: 0,
  pendingCount: 3,
  ...overrides,
});

const proDraft = (overrides: Partial<ProDraftSummary> = {}): ProDraftSummary => ({
  schema: 1,
  id: HEX("c"),
  fileName: "factura.pdf",
  fileSize: 10,
  savedAt: "2026-10-14T08:00:00.000Z",
  pageCount: 2,
  currentPage: 0,
  steps: 1,
  ...overrides,
});

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => {
  clearRecentEntries();
  stores.sign = [];
  stores.edit = [];
  stores.pro = [];
  stores.thumbs = {};
  stores.deleteSession.mockClear();
  stores.deleteSign.mockClear();
  stores.deleteEdit.mockClear();
  stores.deletePro.mockClear();
});

afterEach(cleanup);

function renderRecent() {
  return render(
    <LanguageProvider>
      <RecentView />
    </LanguageProvider>,
  );
}

const unfinishedList = () => screen.getByRole("heading", { name: es.recent.unfinishedTitle }).closest("section")!.querySelector("ul")!;

describe("RecentView - Sin terminar", () => {
  it("lista los borradores reales de Firmar (documento y sesion), Editar y PDF Pro, del mas reciente al mas antiguo", async () => {
    stores.sign = [session(), single()];
    stores.edit = [editDraft()];
    stores.pro = [proDraft()];
    renderRecent();

    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const rows = within(unfinishedList()).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/\.pdf$/).textContent)).toEqual([
      "informe.pdf",
      "Contrato A.pdf",
      "Poder.pdf",
      "factura.pdf",
    ]);
  });

  it("cada «Continuar» es un enlace con ese nombre exacto y apunta a la herramienta con `?resume=`", async () => {
    stores.sign = [session(), single()];
    stores.edit = [editDraft()];
    stores.pro = [proDraft()];
    renderRecent();

    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const links = within(unfinishedList()).getAllByRole("link", { name: es.common.continueLabel });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/edit-pdf?resume=edit:${HEX("b")}`,
      `/sign-pdf?resume=session:${SESSION_ID}`,
      `/sign-pdf?resume=sign:${HEX("a")}`,
      `/pdf-pro?resume=pro:${HEX("c")}`,
    ]);
  });

  it("cada fila dice la herramienta, la fecha y lo que lleva (documentos / cambios)", async () => {
    stores.sign = [session()];
    stores.edit = [editDraft({ pendingCount: 1 })];
    stores.pro = [proDraft({ steps: 4 })];
    renderRecent();

    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const [edit, sign, pro] = within(unfinishedList()).getAllByRole("listitem");
    expect(edit.textContent).toContain("Editar PDF");
    expect(edit.textContent).toContain(es.recent.changesOne);
    expect(sign.textContent).toContain("Firmar PDF");
    expect(sign.textContent).toContain(es.recent.documentsMany.replace("{n}", "2"));
    expect(pro.textContent).toContain("PDF Pro");
    expect(pro.textContent).toContain(es.recent.changesMany.replace("{n}", "4"));
    expect(edit.textContent).toMatch(/2026/);
  });

  it("la miniatura de PDF Pro se muestra cuando existe y las demas filas llevan un icono", async () => {
    stores.pro = [proDraft()];
    stores.edit = [editDraft()];
    stores.thumbs = { [HEX("c")]: "data:image/png;base64,AAAA" };
    renderRecent();

    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const thumbs = unfinishedList().querySelectorAll("img[data-unfinished-thumb]");
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].getAttribute("alt")).toBe("");
    expect(thumbs[0].getAttribute("aria-hidden")).toBe("true");
  });

  it("la fila trae «Descartar <nombre>» con objetivo de 44 px y «Continuar» de 44 px", async () => {
    stores.edit = [editDraft()];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const discard = screen.getByRole("button", { name: es.recent.discard.replace("{name}", "informe.pdf") });
    expect(discard.className).toContain("size-11");
    expect(screen.getByRole("link", { name: es.common.continueLabel }).className).toContain("h-11");
  });

  it("«Continuar» describe su fila (nombre y datos) para lectores de pantalla", async () => {
    stores.edit = [editDraft()];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    const link = screen.getByRole("link", { name: es.common.continueLabel });
    const info = document.getElementById(link.getAttribute("aria-describedby")!);
    expect(info?.textContent).toContain("informe.pdf");
  });

  it("el subtitulo dice que los trabajos sin terminar guardan el documento (ya no «Nunca el documento»)", async () => {
    renderRecent();
    const subtitle = await screen.findByText(
      "Los trabajos sin terminar se guardan solo en este navegador, con el documento, para poder continuarlos.",
    );
    expect(subtitle).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Nunca el documento/);
    expect(es.recent.subtitle).not.toMatch(/Nunca el documento/);
  });
});

describe("RecentView - Historial honesto", () => {
  it("una entrada sin trabajo guardado ofrece «Abrir herramienta», nunca «Continuar»", async () => {
    addRecentEntry("merge-pdf", "viejo.pdf");
    renderRecent();

    const row = (await screen.findByText("viejo.pdf")).closest("li")!;
    const open = within(row).getByRole("link", { name: es.recent.openTool });
    expect(open.getAttribute("href")).toBe("/merge-pdf");
    expect(within(row).queryByRole("link", { name: es.common.continueLabel })).toBeNull();
    expect(within(row).queryByRole("button", { name: es.common.continueLabel })).toBeNull();
    expect(screen.queryByRole("heading", { name: es.recent.unfinishedTitle })).toBeNull();
  });

  it("una entrada de Firmar o Editar ya terminada (sin borrador) tampoco promete continuar", async () => {
    addRecentEntry("sign-pdf", "Firmados - 2 documentos.zip");
    addRecentEntry("edit-pdf", "informe-editado.pdf");
    renderRecent();
    await screen.findByText("informe-editado.pdf");
    expect(screen.queryAllByRole("link", { name: es.common.continueLabel })).toHaveLength(0);
    expect(screen.getAllByRole("link", { name: es.recent.openTool })).toHaveLength(2);
  });

  it("si el historial apunta a un borrador vivo, no se repite: solo sale en «Sin terminar»", async () => {
    stores.pro = [proDraft()];
    addRecentEntry("pdf-pro", "factura.pdf", { kind: "pro", id: HEX("c") });
    addRecentEntry("pdf-pro", "otro.pdf", { kind: "pro", id: HEX("d") });
    renderRecent();

    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    expect(screen.getAllByText("factura.pdf")).toHaveLength(1);
    // El que apunta a un borrador que ya no existe sigue ahi, pero solo como «Abrir herramienta».
    const row = screen.getByText("otro.pdf").closest("li")!;
    expect(within(row).getByRole("link", { name: es.recent.openTool })).toBeTruthy();
    expect(within(row).queryByRole("link", { name: es.common.continueLabel })).toBeNull();
  });

  it("una fecha corrupta del historial no rompe la pantalla", async () => {
    addRecentEntry("merge-pdf", "viejo.pdf");
    const stored = JSON.parse(window.localStorage.getItem("optimuspdf.recent") ?? "[]");
    expect(stored).toHaveLength(1);
    clearRecentEntries();
    window.localStorage.setItem("optimuspdf.recent", JSON.stringify([{ ...stored[0], date: "no-es-una-fecha" }]));
    // Se recarga el modulo para que lea el almacenamiento en vez de la cache vacia.
    vi.resetModules();
    const fresh = await import("@/components/views/RecentView");
    const i18n = await import("@/lib/i18n");
    render(
      <i18n.LanguageProvider>
        <fresh.RecentView />
      </i18n.LanguageProvider>,
    );
    expect(await screen.findByText("viejo.pdf")).toBeTruthy();
  });

  it("«Borrar historial» solo borra el historial: los trabajos sin terminar se quedan", async () => {
    stores.edit = [editDraft()];
    addRecentEntry("merge-pdf", "viejo.pdf");
    renderRecent();
    await screen.findByText("viejo.pdf");
    fireEvent.click(screen.getByRole("button", { name: es.recent.clear }));
    await waitFor(() => expect(screen.queryByText("viejo.pdf")).toBeNull());
    expect(screen.getByText("informe.pdf")).toBeTruthy();
    expect(stores.deleteEdit).not.toHaveBeenCalled();
  });
});

describe("RecentView - vacio", () => {
  it("sin historial ni borradores muestra el estado vacio, pero no antes de leer los borradores", async () => {
    renderRecent();
    expect(await screen.findByText(es.recent.empty)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: es.recent.unfinishedTitle })).toBeNull();
    expect(screen.queryByRole("heading", { name: es.recent.historyTitle })).toBeNull();
  });

  it("con solo borradores NO dice «aun no has procesado nada»", async () => {
    stores.edit = [editDraft()];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    expect(screen.queryByText(es.recent.empty)).toBeNull();
  });
});

describe("RecentView - Descartar", () => {
  it("pide confirmacion con el nombre y «Cancelar» no borra nada", async () => {
    stores.edit = [editDraft()];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });

    fireEvent.click(screen.getByRole("button", { name: es.recent.discard.replace("{name}", "informe.pdf") }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(es.recent.discardTitle.replace("{name}", "informe.pdf"))).toBeTruthy();
    expect(within(dialog).getByText(es.recent.discardBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: es.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stores.deleteEdit).not.toHaveBeenCalled();
    expect(screen.getByText("informe.pdf")).toBeTruthy();
  });

  it.each([
    ["session", () => [session()], "sign", "deleteSession", SESSION_ID, "Contrato A.pdf"],
    ["sign", () => [single()], "sign", "deleteSign", HEX("a"), "Poder.pdf"],
    ["edit", () => [editDraft()], "edit", "deleteEdit", HEX("b"), "informe.pdf"],
    ["pro", () => [proDraft()], "pro", "deletePro", HEX("c"), "factura.pdf"],
  ] as const)("confirmar borra el borrador %s correcto, anuncia «Trabajo descartado» y la fila desaparece", async (_kind, make, store, spy, id, name) => {
    stores[store] = make() as never[];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });

    fireEvent.click(screen.getByRole("button", { name: es.recent.discard.replace("{name}", name) }));
    const dialog = await screen.findByRole("dialog");
    // Al refrescar, el almacen ya no lo tiene.
    stores[store] = [];
    fireEvent.click(within(dialog).getByRole("button", { name: es.recent.discardConfirm }));

    await waitFor(() => expect(stores[spy]).toHaveBeenCalledWith(id));
    expect(stores[spy]).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(name)).toBeNull());
    await waitFor(() => expect(screen.getByText(es.recent.discarded)).toBeTruthy());
  });

  it("solo borra el borrador elegido; los demas siguen", async () => {
    stores.edit = [editDraft({ id: HEX("b"), fileName: "uno.pdf" }), editDraft({ id: HEX("d"), fileName: "dos.pdf", savedAt: "2026-10-14T07:00:00.000Z" })];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    fireEvent.click(screen.getByRole("button", { name: es.recent.discard.replace("{name}", "dos.pdf") }));
    const dialog = await screen.findByRole("dialog");
    stores.edit = [editDraft({ id: HEX("b"), fileName: "uno.pdf" })];
    fireEvent.click(within(dialog).getByRole("button", { name: es.recent.discardConfirm }));
    await waitFor(() => expect(stores.deleteEdit).toHaveBeenCalledWith(HEX("d")));
    expect(stores.deleteEdit).not.toHaveBeenCalledWith(HEX("b"));
    await waitFor(() => expect(screen.queryByText("dos.pdf")).toBeNull());
    expect(screen.getByText("uno.pdf")).toBeTruthy();
  });

  it("tras descartar el foco no cae en <body>: pasa al primer control de la lista", async () => {
    stores.edit = [editDraft({ id: HEX("b"), fileName: "uno.pdf" }), editDraft({ id: HEX("d"), fileName: "dos.pdf", savedAt: "2026-10-14T07:00:00.000Z" })];
    renderRecent();
    await screen.findByRole("heading", { name: es.recent.unfinishedTitle });
    fireEvent.click(screen.getByRole("button", { name: es.recent.discard.replace("{name}", "dos.pdf") }));
    const dialog = await screen.findByRole("dialog");
    stores.edit = [editDraft({ id: HEX("b"), fileName: "uno.pdf" })];
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: es.recent.discardConfirm }));
    });
    await waitFor(() => expect(screen.queryByText("dos.pdf")).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});
