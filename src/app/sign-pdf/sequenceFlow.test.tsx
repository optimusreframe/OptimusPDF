import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { clearAllDrafts } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";

/**
 * La vista continua dentro de la herramienta real: `SignToolClient` con tres
 * PDF de distinto numero de paginas y tamano (pdf.js simulado por nombre).
 */
const pdf = vi.hoisted(() => ({
  pages: {
    "a.pdf": [
      { w: 600, h: 800 },
      { w: 800, h: 600 },
    ],
    "b.pdf": [
      { w: 600, h: 800 },
      { w: 600, h: 800 },
      { w: 600, h: 800 },
    ],
    "c.pdf": [{ w: 1000, h: 500 }],
  } as Record<string, { w: number; h: number }[]>,
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async (file: File) => {
      const pages = pdf.pages[file.name] ?? [{ w: 600, h: 800 }];
      return {
        numPages: pages.length,
        getPage: async (number: number) => ({
          cleanup: () => {},
          getViewport: () => ({ width: pages[number - 1].w, height: pages[number - 1].h }),
        }),
      };
    },
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** El compositor real dibuja en un canvas que jsdom no tiene: aqui basta un boton que entrega la firma. */
vi.mock("@/app/sign-pdf/SignatureComposer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/SignatureComposer")>();
  const React = await import("react");
  return {
    ...actual,
    SignatureComposer: ({
      open,
      onSave,
      onClose,
    }: {
      open: boolean;
      onSave: (draft: { dataUrl: string; ratio: number }) => void;
      onClose: () => void;
    }) =>
      open
        ? React.createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                onSave({ dataUrl: PNG, ratio: 0.25 });
                onClose();
              },
            },
            "Firma de prueba",
          )
        : null,
  };
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

const FIELD_A: DetectedField = {
  id: "txt-a",
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  label: "Nombre",
  source: "acroform",
  confidence: "high",
};
const FIELD_B: DetectedField = {
  id: "txt-b",
  pageIndex: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  label: "Fecha",
  source: "acroform",
  confidence: "high",
};

beforeEach(() => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockImplementation(async (file: File) => {
    if (file.name === "a.pdf") return [FIELD_A];
    if (file.name === "b.pdf") return [FIELD_B];
    return [];
  });
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

let seed = 20;
function pdfFile(name: string): File {
  seed += 3;
  return new File([new Uint8Array([seed, seed + 1, seed + 2, seed + 3])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + seed,
  });
}

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}

async function load(container: HTMLElement, ...files: File[]) {
  const input = container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
}

const docNav = () => screen.getByRole("navigation", { name: strings.documentsLabel });
const tabs = () => within(docNav()).getAllByRole("button");
const bar = () => document.querySelector<HTMLElement>("[data-sequence-bar]");
const pageText = () => within(bar()!).getByText(/^Página \d+ de \d+$/).textContent;
const docLabel = () => bar()!.querySelector("[data-sequence-doc-label]")!.textContent;
const nextButton = () => within(bar()!).getByRole("button", { name: strings.nextPage });

async function readyThreeDocs() {
  const view = renderTool();
  await load(view.container, pdfFile("a.pdf"), pdfFile("b.pdf"), pdfFile("c.pdf"));
  await waitFor(() => expect(pageText()).toBe("Página 1 de 6"));
  return view;
}

describe("Vista continua dentro de Sign PDF (3 PDF de distinto tamano y paginas)", () => {
  it("paginador global y etiqueta del documento tras cargar tres PDF", async () => {
    await readyThreeDocs();
    expect(docLabel()).toBe("a.pdf · p. 1/2");
  });

  it("con UN solo PDF la interfaz es la de siempre: sin barra de secuencia ni region viva", async () => {
    const view = renderTool();
    await load(view.container, pdfFile("a.pdf"));
    await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
    expect(bar()).toBeNull();
    expect(document.querySelector("[data-sequence-live]")).toBeNull();
    expect(screen.getByText(strings.pageOf(1, 2))).toBeTruthy();
  });

  it("cruzar con «Pagina siguiente» cambia el documento activo de la lista (aria-current) y mantiene el foco en el boton", async () => {
    await readyThreeDocs();
    const button = nextButton();
    act(() => button.focus());
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    expect(tabs().map((tab) => tab.getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect(nextButton()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(document.body);
    expect(pageText()).toBe("Página 3 de 6");
  });

  it("elegir un documento en la lista lleva el paginador a su primera pagina y la region viva lo dice", async () => {
    await readyThreeDocs();
    fireEvent.click(tabs()[2]);
    await waitFor(() => expect(docLabel()).toBe("c.pdf · p. 1/1"));
    expect(pageText()).toBe("Página 6 de 6");
    await waitFor(() =>
      expect(document.querySelector("[data-sequence-live]")!.textContent).toBe(
        "Documento 3 de 3: c.pdf, página 1 de 1",
      ),
    );
  });

  it("la region viva de la lista no anuncia (la de la secuencia dice documento Y pagina): una sola voz", async () => {
    await readyThreeDocs();
    const listLive = within(docNav().parentElement as HTMLElement).getByText(
      strings.documentLive(1, 3, "a.pdf"),
    );
    expect(listLive.getAttribute("aria-live")).toBe("off");
    expect(document.querySelector("[data-sequence-live]")!.getAttribute("aria-live")).toBe("polite");
  });

  it("Alt+Av Pag sigue cambiando de documento y la barra lo sigue", async () => {
    await readyThreeDocs();
    act(() => {
      fireEvent.keyDown(window, { key: "PageDown", altKey: true });
    });
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Enter en el ultimo campo pendiente de a.pdf salta al primero de b.pdf SIN haberlo abierto antes (se detecta en segundo plano)", async () => {
    await readyThreeDocs();
    // b.pdf aun no se ha visitado: sus campos llegan por la deteccion en segundo plano (marca «2 · 1» en su miniatura).
    await waitFor(
      () => {
        const groupB = document.querySelector<HTMLElement>('[role="group"][aria-label^="2. b.pdf"]')!;
        expect(within(groupB).getByRole("button", { name: "Ir a la página 2 de b.pdf" }).textContent).toContain("2 · 1");
      },
    );
    expect(tabs()[1].getAttribute("aria-current")).toBeNull();
    const group = await screen.findByRole("group", { name: /^Nombre, / });
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    const input = screen.getByRole("textbox", { name: "Nombre" });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const fecha = await screen.findByRole("textbox", { name: "Fecha" });
    expect(document.activeElement).toBe(fecha);
    expect(tabs()[1].getAttribute("aria-current")).toBe("true");
    expect(docLabel()).toBe("b.pdf · p. 2/3");
  });
});

describe("«Solo yo» con varios documentos: la firma creada una vez", () => {
  async function withSignature() {
    const view = await readyThreeDocs();
    fireEvent.click(screen.getAllByRole("button", { name: strings.createSignature })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Firma de prueba" }));
    // El activo se autocoloca; los demas quedan pendientes.
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    return view;
  }

  it("las pestanas de documentos marcan «Colocada» (a.pdf) y «Pendiente» (b.pdf, c.pdf)", async () => {
    await withSignature();
    expect(tabs().map((tab) => tab.textContent)).toEqual([
      `1. a.pdf${strings.docBadgePlaced}`,
      `2. b.pdf${strings.docBadgePending}`,
      `3. c.pdf${strings.docBadgePending}`,
    ]);
  });

  it("«Aplicar a todos los documentos» deja los tres como «Colocada» y la ceremonia de descarga no se toca", async () => {
    await withSignature();
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());
    expect(tabs().map((tab) => tab.textContent)).toEqual([
      `1. a.pdf${strings.docBadgePlaced}`,
      `2. b.pdf${strings.docBadgePlaced}`,
      `3. c.pdf${strings.docBadgePlaced}`,
    ]);
  });

  it("al visitar otro documento ya lo tiene colocado: su lienzo muestra la firma sin volver a crearla", async () => {
    await withSignature();
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());
    fireEvent.click(tabs()[2]);
    await waitFor(() => expect(docLabel()).toBe("c.pdf · p. 1/1"));
    await waitFor(() =>
      expect(
        document.querySelector('[data-element-kind="slot"][data-drag-mode="move"]'),
      ).toBeTruthy(),
    );
  });

  it("al abrir un documento con la firma colocada se va a la pagina de la firma, no a la ultima que se vio", async () => {
    await withSignature();
    // b.pdf: se deja la vista en su pagina 3 antes de aplicar (la firma ira a la pagina 1).
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    await waitFor(() => expect(document.querySelectorAll("[data-thumb]").length).toBe(6));
    fireEvent.click(document.querySelector('[aria-label="Ir a la página 3 de b.pdf"]')!);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 3/3"));
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(docLabel()).toBe("a.pdf · p. 1/2"));
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    await waitFor(() =>
      expect(document.querySelector('[data-element-kind="slot"][data-drag-mode="move"]')).toBeTruthy(),
    );
  });

  it("«Deshacer» tras aplicar a todos deja solo el documento donde estaba la firma", async () => {
    await withSignature();
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    fireEvent.click(await screen.findByRole("button", { name: strings.soloApplyAllUndo }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    expect(tabs()[1].textContent).toContain(strings.docBadgePending);
  });

  it("sin firma creada no hay indicadores en la lista ni panel de aplicar", async () => {
    await readyThreeDocs();
    expect(tabs().map((tab) => tab.textContent)).toEqual(["1. a.pdf", "2. b.pdf", "3. c.pdf"]);
    expect(screen.queryByRole("button", { name: strings.soloApplyAll })).toBeNull();
  });
});
