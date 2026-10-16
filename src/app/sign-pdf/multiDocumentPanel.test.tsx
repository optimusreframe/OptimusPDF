import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { clearAllDrafts } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { detectFields } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/*
 * `SignToolClient` completo con VARIOS documentos: panel de opciones (que
 * falta para descargar), tabla «¿Quién firma qué?» y el boton de
 * procesar. La colocacion sobre el lienzo la cubren los tests de
 * `DocumentCanvas`/`DocumentSequence`; aqui no se necesita.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: 600,
      height: 800,
      top: 0,
      left: 0,
      right: 600,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

let seed = 5;
function pdf(name: string): File {
  const b = (seed += 7) % 200;
  return new File([new Uint8Array([b, b + 1, b + 2, b + 3])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + b,
  });
}

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(async () => {
  await clearAllDrafts();
});

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}

const pdfInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;

async function load(container: HTMLElement, ...files: File[]) {
  fireEvent.change(pdfInput(container), { target: { files } });
  await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
}

const docNav = () => screen.queryByRole("navigation", { name: strings.documentsLabel });
const runButtons = () =>
  screen.getAllByRole("button", { name: es.tool.run }) as HTMLButtonElement[];

async function toMulti() {
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
}

describe("SignToolClient con varios documentos — panel de opciones y tabla de asignacion", () => {
  it("«Solo yo» con 2 documentos: el panel cuenta los documentos, dice que falta la firma y procesar sigue desactivado", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    expect(screen.getAllByText(strings.batchDocsCount(2)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(strings.noSignature).length).toBeGreaterThan(0);
    for (const run of runButtons()) expect(run.disabled).toBe(true);
  });

  it("«Varios firmantes» con 2 documentos sin nada que aplicar: lista cada documento vacio como motivo", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await toMulti();
    expect(screen.getAllByText(strings.batchSummary(2, 0)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(strings.batchDocEmpty("a")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(strings.batchDocEmpty("b")).length).toBeGreaterThan(0);
    for (const run of runButtons()) expect(run.disabled).toBe(true);
  });

  it("el panel de opciones lleva una region viva siempre montada", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await toMulti();
    const statuses = screen.getAllByRole("status");
    expect(statuses.some((node) => within(node).queryByText(strings.deliveryBlockedTitle))).toBe(true);
  });

  it("la tabla «¿Quién firma qué?» aparece con dos documentos (con firmantes), no queda el control antiguo y desaparece al quedar uno", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await toMulti();
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    expect(await screen.findByRole("grid", { name: strings.assignment.tableLabel })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: strings.signModeSame })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByText(/Aplica a:/)).toBeNull();
  });

  it("anadir un firmante lo pone en «Firma A» en los dos documentos (su grupo automatico cubre toda la ronda)", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await toMulti();
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    const grid = await screen.findByRole("grid", { name: strings.assignment.tableLabel });
    await waitFor(() => expect(grid.querySelectorAll('[data-cell][data-group="A"]')).toHaveLength(2));
    expect(screen.getByText(strings.assignment.summaryFiles(2))).toBeTruthy();
  });

  it("un documento nuevo entra solo en la «Firma A» automatica; con «Una firma por documento» cada uno tiene la suya", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"), pdf("b.pdf"));
    await toMulti();
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    const grid = await screen.findByRole("grid", { name: strings.assignment.tableLabel });
    await waitFor(() => expect(grid.querySelectorAll('[data-cell][data-group="A"]')).toHaveLength(2));
    fireEvent.change(pdfInput(container), { target: { files: [pdf("c.pdf")] } });
    await waitFor(() => expect(screen.getByRole("grid").querySelectorAll('[data-cell][data-group="A"]')).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: strings.assignment.shortcutPerDoc }));
    await waitFor(() =>
      expect([...screen.getByRole("grid").querySelectorAll("[data-cell]")].map((cell) => cell.getAttribute("data-group"))).toEqual(["A", "B", "C"]),
    );
  });

  it("con el flag `multiDocument` apagado la herramienta admite un solo archivo y no hay tabla", async () => {
    setSignPdfFeatureFlag("multiDocument", false);
    const { container } = renderTool();
    expect(pdfInput(container).multiple).toBe(false);
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("(control) con UN documento en «Varios firmantes» no hay bloques ni panel de lote", async () => {
    const { container } = renderTool();
    await load(container, pdf("a.pdf"));
    await toMulti();
    fireEvent.click(screen.getByRole("button", { name: strings.addSigner }));
    expect(screen.queryByText(/Aplica a:/)).toBeNull();
    expect(screen.queryByText(strings.batchDocsCount(1))).toBeNull();
    expect(screen.queryByText(strings.batchSummary(1, 0))).toBeNull();
    expect(screen.getByText(strings.totalFields(0))).toBeTruthy();
  });
});
