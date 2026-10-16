import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DOC_STATE, type SignerBlock } from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION } from "@/app/sign-pdf/signSession";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { PROGRESS_DELAY_MS, SaveTemplateOffer, TemplateNotices } from "@/app/sign-pdf/TemplateNotices";
import type { AppliedRecord, PendingField } from "@/app/sign-pdf/templateSession";
import type { DocNotice, TemplateController } from "@/app/sign-pdf/useTemplateController";
import { DEFAULT_ROLES, TEMPLATE_SCHEMA_VERSION, type DocTemplate } from "@/lib/docLibrary/templateTypes";

const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const signers = [
  { id: "sg-1", name: "Asegurado", color: "#0d4bff" },
  { id: "sg-2", name: "Co-asegurado", color: "#0f9d68" },
];

const template = (two = true): DocTemplate => ({
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  id: "tpl-1",
  documentId: "doc-1",
  name: "Mold Test",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  rev: 1,
  roles: DEFAULT_ROLES.map((role) => ({ ...role })),
  variants: {
    "1": { fields: [{ roleIndex: 0, pageIndex: 0, type: "initials", rect: R(0.7, 0.9, 0.1, 0.04), required: true, source: "manual" }], textFields: [] },
    "2": two ? { fields: [{ roleIndex: 0, pageIndex: 0, type: "initials", rect: R(0.7, 0.9, 0.05, 0.04), required: true, source: "manual" }, { roleIndex: 1, pageIndex: 0, type: "initials", rect: R(0.76, 0.9, 0.05, 0.04), required: true, source: "manual" }], textFields: [] } : { fields: [], textFields: [] },
  },
});

const record = (over: Partial<AppliedRecord> = {}): AppliedRecord => ({
  source: "template",
  template: { id: "tpl-1", name: "Mold Test", version: 1, documentId: "doc-1" },
  level: "match",
  percent: 100,
  count: 2,
  fieldIds: ["a", "b", "c"],
  textFieldIds: ["t"],
  createdSignerIds: [],
  createdNames: {},
  before: { mode: "single", signers: [], activeSignerId: null },
  pages: 3,
  reviewPages: [],
  skippedPages: [],
  warnings: [],
  textMeta: {},
  spots: {},
  ...over,
});

const notice = (over: Partial<DocNotice> = {}): DocNotice => ({
  docId: "doc-1",
  name: "contrato.pdf",
  phase: "applied",
  lookup: { template: template(), documentId: "doc-1", level: "match", percent: 100, match: null, pageCount: 3 },
  record: record(),
  pending: [],
  count: 2,
  signerCount: 2,
  offerSave: null,
  saveResult: null,
  busy: false,
  confirm: null,
  cap: null,
  ...over,
});

function controllerOf(notices: DocNotice[], announcement = ""): TemplateController {
  return {
    notices,
    announcement,
    notify: vi.fn(),
    undo: vi.fn(),
    dismiss: vi.fn(),
    setCount: vi.fn(),
    confirmChange: vi.fn(),
    cancelChange: vi.fn(),
    acceptSimilar: vi.fn(),
    declineSimilar: vi.fn(),
    accept: vi.fn(),
    acceptAll: vi.fn(),
    detect: vi.fn(),
    saveAsTemplate: vi.fn(),
    dismissOffer: vi.fn(),
    applySaved: vi.fn(),
  };
}

function renderNotices(controller: TemplateController, language: "es" | "en" = "es", multi = false, session?: React.ComponentProps<typeof TemplateNotices>["session"]) {
  const handlers = { onReview: vi.fn(), onGoToPage: vi.fn(), onGoSign: vi.fn() };
  const view = render(<TemplateNotices controller={controller} strings={SIGN_STRINGS[language]} signers={signers} session={session} multi={multi} {...handlers} />);
  return { ...view, ...handlers };
}
afterEach(() => cleanup());

const pendingItem = (over: Partial<PendingField> = {}): PendingField => ({ key: "k1", origin: "template", kind: "sign", type: "initials", signerIndex: 0, pageIndex: 2, templatePage: 2, rect: R(0.7, 0.9, 0.05, 0.04), reason: "pageReview", ...over });

describe("avisos de plantillas", () => {
  it("sin avisos solo hay la región viva (siempre montada, para anunciar)", () => {
    renderNotices(controllerOf([], "Plantilla «X» aplicada para 2 firmantes en 3 páginas."));
    expect(document.querySelector("[data-template-live]")?.textContent).toContain("Plantilla «X» aplicada");
    expect(document.querySelectorAll("[data-template-notice]")).toHaveLength(0);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("plantilla aplicada: título, cuerpo, cambio de firmantes, Ir a firmar / Revisar campos / Deshacer", () => {
    const controller = controllerOf([notice()]);
    const { onGoSign, onReview } = renderNotices(controller);
    expect(screen.getByText("Plantilla «Mold Test» aplicada")).toBeTruthy();
    expect(screen.getByText("2 firmantes · 4 campos en 3 páginas")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "1 firmante" }));
    expect(controller.setCount).toHaveBeenCalledWith("doc-1", 1);
    fireEvent.click(screen.getByRole("button", { name: "Ir a firmar" }));
    expect(onGoSign).toHaveBeenCalledWith("doc-1");
    fireEvent.click(screen.getByRole("button", { name: "Revisar campos" }));
    expect(onReview).toHaveBeenCalledWith("doc-1");
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(controller.undo).toHaveBeenCalledWith("doc-1");
  });

  it("la plantilla de una sola variante no ofrece el cambio de firmantes y lo dice cuando falta el segundo", () => {
    renderNotices(controllerOf([notice({ lookup: { template: template(false), documentId: "doc-1", level: "match", percent: 100, match: null, pageCount: 3 }, count: 1, record: record({ count: 1, warnings: [{ code: "missingSecondSigner" }] }) })]));
    expect(screen.queryByRole("tab", { name: "2 firmantes" })).toBeNull();
    expect(screen.getByText(/solo tiene la variante de 1 firmante/)).toBeTruthy();
  });

  it("«Parece la plantilla X (85 %)»: Usar / No", () => {
    const controller = controllerOf([notice({ phase: "asking", record: null, lookup: { template: template(), documentId: "doc-1", level: "similar", percent: 85, match: null, pageCount: 3 } })]);
    renderNotices(controller);
    expect(screen.getByText("Parece la plantilla «Mold Test» (85 %)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Usar" }));
    expect(controller.acceptSimilar).toHaveBeenCalledWith("doc-1");
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(controller.declineSimilar).toHaveBeenCalledWith("doc-1");
  });

  it("con varios documentos cada aviso nombra su documento", () => {
    renderNotices(controllerOf([notice(), notice({ docId: "doc-2", name: "anexo.pdf" })]), "es", true);
    expect(screen.getByText("contrato.pdf: Plantilla «Mold Test» aplicada")).toBeTruthy();
    expect(screen.getByText("anexo.pdf: Plantilla «Mold Test» aplicada")).toBeTruthy();
  });

  it("buscando campos: el aviso de progreso solo aparece si tarda (no mueve nada bajo el dedo) y no deja contenedor vacío antes", async () => {
    renderNotices(controllerOf([notice({ phase: "automapping", record: null, lookup: null, busy: true })]));
    expect(screen.queryByText("Buscando campos de firma e iniciales…")).toBeNull();
    expect(document.querySelector("[data-template-notice]")).toBeNull();
    expect(await screen.findByText("Buscando campos de firma e iniciales…", {}, { timeout: PROGRESS_DELAY_MS + 3000 })).toBeTruthy();
  });

  it("si el automapeo termina antes del plazo, el aviso de progreso no llega a verse", async () => {
    const view = renderNotices(controllerOf([notice({ phase: "automapping", record: null, lookup: null, busy: true })]));
    view.rerender(<TemplateNotices controller={controllerOf([])} strings={SIGN_STRINGS.es} signers={signers} multi={false} onReview={vi.fn()} onGoToPage={vi.fn()} onGoSign={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, PROGRESS_DELAY_MS + 200));
    expect(screen.queryByText("Buscando campos de firma e iniciales…")).toBeNull();
    expect(document.querySelector("[data-template-notice]")).toBeNull();
  });
  it("el contenedor de avisos no genera caja (no mueve el apilado de la herramienta)", () => {
    renderNotices(controllerOf([]));
    const wrapper = document.querySelector("[data-template-notices]") as HTMLElement;
    expect(wrapper.className).toContain("contents");
    renderNotices(controllerOf([notice()]));
    expect((document.querySelector("[data-template-notice]") as HTMLElement).className).toContain("mb-6");
  });

  it("automapeo: «Detectamos N campos automáticamente» y el panel de sugerencias con Añadir de una en una y «Añadir todas»", () => {
    const controller = controllerOf([notice({ phase: "automapped", lookup: null, record: record({ source: "automap", template: undefined, placed: 14 }), pending: [pendingItem({ origin: "automap", reason: "Etiqueta «Firma» bajo una raya", key: "a1", pageIndex: 4 }), pendingItem({ key: "a2", origin: "automap", kind: "text", type: "date", label: "Fecha", signerIndex: undefined, pageIndex: 1, reason: "r2" })] })]);
    renderNotices(controller);
    expect(screen.getByText("Detectamos 14 campos automáticamente")).toBeTruthy();
    expect(screen.queryByText("Etiqueta «Firma» bajo una raya")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sugerencias (2)" }));
    expect(screen.getByText("Etiqueta «Firma» bajo una raya")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Añadir: Iniciales de Asegurado, página 5" }));
    expect(controller.accept).toHaveBeenCalledWith("doc-1", "a1");
    fireEvent.click(screen.getByRole("button", { name: "Añadir todas" }));
    expect(controller.acceptAll).toHaveBeenCalledWith("doc-1");
  });

  it("páginas a revisar: el panel dice cuáles y por qué; una página sin equivalente no se puede añadir", () => {
    const { onGoToPage } = renderNotices(
      controllerOf([notice({ record: record({ reviewPages: [2, 4] }), pending: [pendingItem({ key: "r1" }), pendingItem({ key: "r2", pageIndex: null, templatePage: 4, reason: "noPageMatch" })] })]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revisar las páginas 3 y 5 (2)" }));
    expect(screen.getByText("Esta página cambió respecto a la plantilla: no se aplicó sola.")).toBeTruthy();
    const rows = document.querySelectorAll("[data-template-pending] li");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: /^Añadir:/ })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: /^Añadir:/ })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText("Sin página equivalente")).toBeTruthy();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: /^Ir a la página 3/ }));
    expect(onGoToPage).toHaveBeenCalledWith("doc-1", 2);
  });

  it("una firma sin firmante claro se ofrece sin nombre y «Añadir todas» no aparece si solo hay de esas", () => {
    renderNotices(controllerOf([notice({ phase: "automapped", lookup: null, record: record({ source: "automap", template: undefined, placed: 2 }), pending: [pendingItem({ key: "o", origin: "automap", signerIndex: undefined, type: "signature", reason: "firma de la otra parte" })] })]));
    fireEvent.click(screen.getByRole("button", { name: "Sugerencias (1)" }));
    expect(screen.getByRole("button", { name: "Añadir: Firma, página 3" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Añadir todas" })).toBeNull();
  });

  it("en inglés", () => {
    renderNotices(controllerOf([notice()]), "en");
    expect(screen.getByText("Template “Mold Test” applied")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to signing" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "2 signers" })).toBeTruthy();
  });
});

describe("oferta «¿Guardar como plantilla?»", () => {
  it("se ofrece para lo mapeado solo; guardar y «No guardar» llaman al controlador", () => {
    const controller = controllerOf([notice({ phase: "automapped", lookup: null, offerSave: "available", record: record({ source: "automap", template: undefined }) })]);
    render(<SaveTemplateOffer controller={controller} strings={SIGN_STRINGS.es} />);
    expect(screen.getByText("¿Guardar «contrato.pdf» como plantilla para la próxima vez?")).toBeTruthy();
    // m1: se guarda el PDF tal cual se subio (no una «copia en blanco»): el texto lo dice con honestidad.
    expect(screen.getByText(/Se guardará una copia de este PDF en este navegador/)).toBeTruthy();
    expect(screen.getByText(/Si este PDF contiene datos de un cliente, no lo guardes/)).toBeTruthy();
    expect(screen.queryByText(/copia en blanco|Nunca las firmas ni los datos del cliente/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Guardar como plantilla" }));
    expect(controller.saveAsTemplate).toHaveBeenCalledWith("doc-1");
    fireEvent.click(screen.getByRole("button", { name: "No guardar" }));
    expect(controller.dismissOffer).toHaveBeenCalledWith("doc-1");
  });

  it("guardada: «plantilla guardada · aplicada a N páginas»; con fallo, el motivo; sin oferta, nada", () => {
    const saved = controllerOf([notice({ offerSave: "saved", saveResult: { ok: true, pages: 5 } })]);
    const { container, rerender } = render(<SaveTemplateOffer controller={saved} strings={SIGN_STRINGS.es} />);
    expect(container.textContent).toContain("plantilla guardada · aplicada a 5 páginas");
    expect(screen.queryByRole("button", { name: "Guardar como plantilla" })).toBeNull();
    rerender(<SaveTemplateOffer controller={controllerOf([notice({ offerSave: "available", saveResult: { ok: false, reason: "quota" } })])} strings={SIGN_STRINGS.es} />);
    expect(container.textContent).toContain("No hay espacio en este navegador");
    expect(screen.getByRole("button", { name: "Guardar como plantilla" })).toBeTruthy();
    rerender(<SaveTemplateOffer controller={controllerOf([notice({ offerSave: "dismissed" }), notice({ docId: "d2", offerSave: null })])} strings={SIGN_STRINGS.es} />);
    expect(container.textContent).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * F2-fix · MAYOR 1 y MAYOR 2 en el aviso
 * ------------------------------------------------------------------ */

const DRAFT = { dataUrl: "data:image/png;base64,AAAA", ratio: 3 };
const block = (signerId: string): SignerBlock => ({ id: `bk-${signerId}`, signerId, appliesTo: ["doc-1"], signature: DRAFT, initials: DRAFT, stamps: {}, auto: true });
const sessionWith = (over: Partial<typeof DEFAULT_SESSION> = {}) => ({ ...DEFAULT_SESSION, signers, docs: { "doc-1": { ...EMPTY_DOC_STATE } }, ...over });
const pendingChange = (over = {}) => ({ count: 1 as const, loss: { signers: [{ id: "sg-2", name: "Marta Ruiz", strokes: true }], values: 0 }, lookup: null, ...over });

describe("cambiar de firmantes: la hoja de confirmación", () => {
  it("sin cambio pendiente no hay hoja", () => {
    renderNotices(controllerOf([notice()]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dice qué se quitaría («la firma de X») y ofrece «Quitar y cambiar» / «Cancelar»", () => {
    const controller = controllerOf([notice({ confirm: pendingChange() })]);
    renderNotices(controller);
    const dialog = screen.getByRole("dialog", { name: "¿Cambiar a 1 firmante?" });
    expect(within(dialog).getByText("Cambiar a 1 firmante quitará la firma de Marta Ruiz. ¿Continuar?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Quitar y cambiar" }));
    expect(controller.confirmChange).toHaveBeenCalledWith("doc-1");
  });

  it("al aplicar lo guardado desde el editor (sin cambiar el nº de firmantes) la hoja no habla de cambiar de firmantes", () => {
    renderNotices(controllerOf([notice({ confirm: pendingChange({ replaceDocument: true, loss: { signers: [], values: 1 } }) })]));
    const dialog = screen.getByRole("dialog", { name: "¿Aplicar la plantilla guardada?" });
    expect(within(dialog).getByText("Aplicar la plantilla guardada reemplazará los campos del documento y quitará 1 valor escrito. ¿Continuar?")).toBeTruthy();
    expect(screen.queryByText(/Cambiar a/)).toBeNull();
  });

  it("cuando la pregunta se resuelve (ya no hay cambio pendiente) la hoja se cierra", async () => {
    const view = renderNotices(controllerOf([notice({ confirm: pendingChange() })]));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<TemplateNotices controller={controllerOf([notice({ confirm: null })])} strings={SIGN_STRINGS.es} signers={signers} multi={false} onReview={vi.fn()} onGoToPage={vi.fn()} onGoSign={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancelar no confirma nada", () => {
    const controller = controllerOf([notice({ confirm: pendingChange() })]);
    renderNotices(controller);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(controller.cancelChange).toHaveBeenCalledWith("doc-1");
    expect(controller.confirmChange).not.toHaveBeenCalled();
  });

  it("nombre escrito sin firma + valores escritos: lo cuenta todo", () => {
    renderNotices(controllerOf([notice({ confirm: pendingChange({ loss: { signers: [{ id: "sg-2", name: "Luis", strokes: false }], values: 2 } }) })]));
    expect(screen.getByText("Cambiar a 1 firmante quitará al firmante Luis y 2 valores escritos. ¿Continuar?")).toBeTruthy();
  });

  it("en inglés", () => {
    renderNotices(controllerOf([notice({ confirm: pendingChange({ count: 2, loss: { signers: [{ id: "sg-2", name: "Marta Ruiz", strokes: true }], values: 1 } }) })]), "en");
    const dialog = screen.getByRole("dialog", { name: "Switch to 2 signers?" });
    expect(within(dialog).getByText("Switching to 2 signers will remove Marta Ruiz's signature and 1 typed value. Continue?")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Remove and switch" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("la hoja de confirmación aísla el fondo (aria-modal de verdad)", () => {
  it("con la hoja abierta el resto de la página queda inert (y la hoja no); al resolverse se restaura", async () => {
    const controller = controllerOf([notice({ confirm: pendingChange() })]);
    const view = renderNotices(controller);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(view.container.hasAttribute("inert")).toBe(true));
    expect(dialog.closest("[inert]")).toBeNull();
    // Nada del fondo es alcanzable: el segmento de firmantes esta dentro de un ancestro inert.
    expect(view.container.querySelector("[data-template-notice]")?.closest("[inert]")).not.toBeNull();
    view.rerender(<TemplateNotices controller={controllerOf([notice({ confirm: null })])} strings={SIGN_STRINGS.es} signers={signers} multi={false} onReview={vi.fn()} onGoToPage={vi.fn()} onGoSign={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.container.hasAttribute("inert")).toBe(false);
  });

  it("Escape sigue cancelando y el foco vuelve al control que abrio la hoja", async () => {
    const view = renderNotices(controllerOf([notice({ confirm: null })]));
    const tab = within(view.container).getByRole("tab", { name: "1 firmante" });
    tab.focus();
    const asking = controllerOf([notice({ confirm: pendingChange() })]);
    const props = { strings: SIGN_STRINGS.es, signers, multi: false, onReview: vi.fn(), onGoToPage: vi.fn(), onGoSign: vi.fn() };
    view.rerender(<TemplateNotices controller={asking} {...props} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(asking.cancelChange).toHaveBeenCalledWith("doc-1"));
    // El anfitrion cierra la pregunta: el fondo se destapa y el foco vuelve al segmento.
    view.rerender(<TemplateNotices controller={controllerOf([notice({ confirm: null })])} {...props} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.container.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(tab));
  });
});

describe("firmante que se queda porque otro documento lo usa (F3)", () => {
  it("el aviso lo dice (ES y EN) y sin ello no hay nota", () => {
    renderNotices(controllerOf([notice({ record: record({ keptSigners: ["Co-asegurado"] }) })]));
    expect(document.querySelector("[data-template-kept]")?.textContent).toBe("Co-asegurado se queda como firmante de la sesión porque otro documento tiene campos suyos; en este documento no tiene campos.");
    cleanup();
    renderNotices(controllerOf([notice({ record: record({ keptSigners: ["Co-asegurado", "Luis"] }) })]));
    expect(document.querySelector("[data-template-kept]")?.textContent).toContain("Co-asegurado, Luis se quedan como firmantes");
    cleanup();
    renderNotices(controllerOf([notice({ record: record({ keptSigners: ["Marta"] }) })]), "en");
    expect(document.querySelector("[data-template-kept]")?.textContent).toBe("Marta stays in the session because another document has fields for them; this document has none for them.");
    cleanup();
    renderNotices(controllerOf([notice()]));
    expect(document.querySelector("[data-template-kept]")).toBeNull();
  });
});

describe("«Deshacer» solo mientras no haya trabajo de la persona", () => {
  const created = { createdSignerIds: ["sg-1", "sg-2"], createdNames: { "sg-1": "Asegurado", "sg-2": "Co-asegurado" } };

  it("sin trabajo (o sin la sesión) se ofrece", () => {
    renderNotices(controllerOf([notice({ record: record(created) })]), "es", false, sessionWith());
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeTruthy();
  });

  it("con la firma de un firmante creado por la plantilla ya no se ofrece, pero el aviso sigue ahí", () => {
    renderNotices(controllerOf([notice({ record: record(created) })]), "es", false, sessionWith({ blocks: [block("sg-2")] }));
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
    expect(screen.getByText("Plantilla «Mold Test» aplicada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir a firmar" })).toBeTruthy();
  });

  it("con un nombre escrito tampoco", () => {
    renderNotices(controllerOf([notice({ record: record(created) })]), "es", false, sessionWith({ signers: [signers[0], { ...signers[1], name: "Marta Ruiz" }] }));
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
  });

  it("con un valor escrito en un campo de la plantilla tampoco", () => {
    renderNotices(controllerOf([notice({ record: record({ ...created, textFieldIds: ["t"] }) })]), "es", false, sessionWith({ docs: { "doc-1": { ...EMPTY_DOC_STATE, textValues: { t: "Mold" } } } }));
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
  });

  it("los trazos de un firmante que ya estaba antes no quitan «Deshacer» (no lo toca)", () => {
    renderNotices(controllerOf([notice({ record: record({ createdSignerIds: [], createdNames: {} }) })]), "es", false, sessionWith({ blocks: [block("sg-1")] }));
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeTruthy();
  });
});

describe("tope de campos por documento (m3)", () => {
  const automapped = (cap: { placed: number; pages: number[] } | null) => notice({ phase: "automapped", lookup: null, record: record({ source: "automap", template: undefined, placed: 80 }), cap });

  it("sin tope no hay aviso", () => {
    renderNotices(controllerOf([automapped(null)]));
    expect(document.querySelector("[data-template-cap]")).toBeNull();
  });

  it("dice cuántos campos se colocaron y qué páginas quedaron sin iniciales, con acción para ir a cada una", () => {
    const { onGoToPage } = renderNotices(controllerOf([automapped({ placed: 80, pages: [6, 7, 8] })]));
    expect(screen.getByText("Se colocaron 80 campos, el máximo por documento; 3 páginas quedan sin iniciales. Revisa esas páginas y añade lo que falte.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ir a la página 7" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Páginas sin cubrir (3)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Ir a la página 8" }));
    expect(onGoToPage).toHaveBeenCalledWith("doc-1", 7);
    expect(screen.getAllByRole("button", { name: /^Ir a la página \d+$/ })).toHaveLength(3);
  });

  it("una sola página, en inglés, y sin páginas sueltas no hay panel", () => {
    renderNotices(controllerOf([automapped({ placed: 1, pages: [4] })]), "en");
    expect(screen.getByText("1 field was placed, the maximum per document; 1 page has no initials. Check that page and add whatever is missing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pages not covered (1)" })).toBeTruthy();
    cleanup();
    renderNotices(controllerOf([automapped({ placed: 80, pages: [] })]));
    expect(document.querySelector("[data-template-cap]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Páginas sin cubrir/ })).toBeNull();
  });
});
