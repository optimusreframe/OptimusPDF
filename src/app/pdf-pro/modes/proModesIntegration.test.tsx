import "fake-indexeddb/auto";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProToolClient } from "@/app/pdf-pro/ProToolClient";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { clearHandoff } from "@/app/pdf-pro/proHandoff";
import { __resetProFeatureFlagsCacheForTests } from "@/app/pdf-pro/proFeatureFlags";
import { __closeWarmProDraftsConnectionForTests, __resetProDraftsMemoryForTests, clearAllProDrafts } from "@/app/pdf-pro/proDrafts";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { PRO_LAYOUT_STORAGE_KEY } from "@/app/pdf-pro/shell/proLayout";
import { __clearRegisteredCommandsForTests } from "@/app/pdf-pro/shell/proCommands";
import { __clearProActionsForTests } from "@/app/pdf-pro/shell/proActions";
import { clearRecentEntries } from "@/lib/recent";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { SetLanguage, installLayoutEnv, pdfMocks, resetViewerGlobals, settle, type LayoutEnv } from "@/app/pdf-pro/viewer/viewerTestUtils";
import { MODE_STRINGS } from "@/app/pdf-pro/modes/modeStrings";
import { getProMode } from "@/app/pdf-pro/modes/proModes";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";
import {
  __resetEditPdfFeatureFlagsCacheForTests,
  EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
  setEditPdfFeatureFlag,
} from "@/app/edit-pdf/editFeatureFlags";
import { __resetEditDraftsMemoryForTests, clearAllEditDrafts } from "@/app/edit-pdf/editDrafts";

/**
 * PDF Pro de punta a punta con los modos REALES Editar y Anotar (Wave 7 · U6): la suite, el host, el editor de la
 * herramienta suelta, el documento de trabajo y los motores de exportacion; solo pdf.js y la hoja se simulan.
 */

const downloaded = vi.hoisted(() => ({ blobs: [] as { blob: Blob; name: string }[] }));
const editMocks = vi.hoisted(() => ({ pageCount: 4 }));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => downloaded.blobs.push({ blob, name }),
    openPdfDocument: utils.pdfMocks.open,
    closePdfDocument: utils.pdfMocks.close,
    renderPageToDataUrl: utils.pdfMocks.thumb,
  };
});
vi.mock("@/lib/pdf/pageRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/pageRaster")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, renderPageRaster: utils.pdfMocks.render };
});
vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: { numPages: editMocks.pageCount }, pageCount: editMocks.pageCount, error: null }),
  usePageText: () => ({ status: "ready", analysis: { blocks: [], hiddenCount: 0, hasTextLayer: true, failed: false } }),
}));
vi.mock("@/app/edit-pdf/EditSurface", async () => {
  const react = await import("react");
  return {
    EditSurface: function EditSurfaceStub(props: {
      pageIndex: number;
      hostRef: { current: HTMLDivElement | null };
      clipRef: { current: HTMLDivElement | null };
      handleRef?: Ref<{ sampleBackground: (box: unknown) => unknown }>;
      onMetrics: (m: unknown, page: number) => void;
      hostProps?: ComponentPropsWithoutRef<"div">;
      children?: ReactNode;
    }) {
      const { pageIndex, hostRef, clipRef, handleRef, onMetrics, hostProps, children } = props;
      react.useImperativeHandle(handleRef, () => ({ sampleBackground: () => null }));
      react.useEffect(() => {
        onMetrics(metricsFor(), pageIndex);
        return () => onMetrics(null, -1);
      }, [pageIndex]);
      return (
        <div ref={clipRef}>
          <div ref={hostRef} data-page-index={pageIndex} data-testid="edit-host" {...hostProps}>
            {children}
          </div>
        </div>
      );
    },
  };
});

const S = PRO_STRINGS.es;
const M = MODE_STRINGS.es;
const flow = EDIT_FLOW_STRINGS.es;
const s = EDIT_STRINGS.es.inline;
let env: LayoutEnv;
void makeBlock;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(async () => {
  env = installLayoutEnv({ width: 800, height: 600 });
  resetViewerGlobals();
  downloaded.blobs.length = 0;
  editMocks.pageCount = 4;
  clearHandoff();
  clearRecentEntries();
  window.localStorage.removeItem("optimuspdf.pro.featureFlags");
  window.localStorage.removeItem(PRO_LAYOUT_STORAGE_KEY);
  window.localStorage.removeItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY);
  __resetProFeatureFlagsCacheForTests();
  __resetEditPdfFeatureFlagsCacheForTests();
  __resetProDraftsMemoryForTests();
  __resetEditDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
  await clearAllEditDrafts();
  __clearRegisteredCommandsForTests();
  __clearProActionsForTests();
});

afterEach(() => {
  cleanup();
  env.restore();
  vi.unstubAllGlobals();
  resetReducedMotionPrefCache();
  document.documentElement.removeAttribute("data-pro-suite");
});

function stubMobile() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width: 767px") || query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })),
  );
}

async function openPro(pages = 4, language: "es" | "en" = "es") {
  pdfMocks.state.defaultPages = pages;
  editMocks.pageCount = pages;
  const utils = render(
    <LanguageProvider>
      {language === "en" ? <SetLanguage language="en" /> : null}
      <ProToolClient />
    </LanguageProvider>,
  );
  const bytes = await makePdfBytes(pages);
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdfFile(bytes, "informe.pdf")] } });
  await screen.findByRole("heading", { level: 1, name: /informe\.pdf/ });
  await settle();
  return utils;
}

const tab = (name: string) => screen.getByRole("tab", { name });
const topBar = () => within(document.querySelector<HTMLElement>('[data-pro-region="top"]')!);
const palette = (id: string) => document.querySelector<HTMLElement>(`[data-palette-item="${id}"]`)!;
const arm = (id: string) => fireEvent.click(palette(id));
const editHost = () => screen.getByTestId("edit-host");
const applyButton = () => document.querySelector<HTMLElement>("[data-pro-mode-apply]")!;
const discardButton = () => document.querySelector<HTMLElement>("[data-pro-mode-discard]")!;
const history = () =>
  within(screen.getByRole("list", { name: S.suite.historyTitle }))
    .getAllByRole("listitem")
    .map((li) => li.textContent?.replace(S.suite.historyCurrent, "").trim());
const pointer = (x: number, y: number) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y });
function drag(from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(editHost(), pointer(from[0], from[1]));
  fireEvent.pointerMove(editHost(), pointer(to[0], to[1]));
  fireEvent.pointerUp(editHost(), pointer(to[0], to[1]));
}

async function enter(name: "Editar" | "Anotar") {
  fireEvent.click(tab(name));
  await screen.findByTestId("edit-host");
  await waitFor(() => expect(document.querySelector("[data-tool-palette]")).not.toBeNull());
  await settle(3);
}
async function drawRect() {
  arm("rect");
  drag([100, 200], [300, 300]);
  await waitFor(() => expect(applyButton().getAttribute("aria-disabled")).toBeNull());
}
async function applyNow() {
  await act(async () => {
    fireEvent.click(applyButton());
  });
  await settle(10);
}

describe("Editar y Anotar dentro de PDF Pro", () => {
  it("los dos modos estan registrados en sus pestañas", () => {
    expect(getProMode("edit")?.id).toBe("edit");
    expect(getProMode("annotate")?.id).toBe("annotate");
    expect(getProMode("edit")?.preferredTool).toBe("edit-pdf");
  });

  it("«Editar» monta el editor real en lugar del visor", async () => {
    await openPro();
    expect(document.querySelector("[data-pro-viewer-scroller]")).not.toBeNull();
    await enter("Editar");
    expect(document.querySelector("[data-pro-viewer-scroller]")).toBeNull();
    expect(document.querySelector('[data-pro-editor][data-variant="edit"]')).not.toBeNull();
    expect(document.querySelector("[data-edit-workspace][data-embedded]")).not.toBeNull();
  });

  it("«Aplicar» exporta, crea UN snapshot «Edición (1)» y vuelve al visor con el resultado", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    await applyNow();
    expect(document.querySelector("[data-pro-mode-host]")).toBeNull();
    expect(document.querySelector("[data-pro-viewer-scroller]")).not.toBeNull();
    expect(history()).toEqual(["Original", M.edit.label(1)]);
    const result = document.querySelector("[data-pro-mode-result]")!;
    expect(result.textContent).toContain(flow.summaryShapes(1));
  });

  it("el snapshot es un PDF valido con las mismas paginas", async () => {
    await openPro(3);
    await enter("Editar");
    await drawRect();
    await applyNow();
    fireEvent.click(topBar().getByRole("button", { name: S.suite.download }));
    await waitFor(() => expect(downloaded.blobs).toHaveLength(1));
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const loaded = await PDFDocument.load(new Uint8Array(await downloaded.blobs[0].blob.arrayBuffer()));
    expect(loaded.getPageCount()).toBe(3);
  });

  it("Ctrl+Z global deshace UNA aplicacion por vez", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    await applyNow();
    await enter("Anotar");
    arm("ellipse");
    drag([100, 200], [200, 280]);
    await waitFor(() => expect(applyButton().getAttribute("aria-disabled")).toBeNull());
    await applyNow();
    expect(history()).toEqual(["Original", M.edit.label(1), M.annotate.label(1)]);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(topBar().getByRole("button", { name: S.suite.redo }).getAttribute("aria-disabled")).toBeNull();
    expect(topBar().getByRole("button", { name: S.suite.undo }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(topBar().getByRole("button", { name: S.suite.undo }).getAttribute("aria-disabled")).toBe("true");
  });

  it("Ctrl+Z dentro del modo deshace el editor y NO el documento", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await settle();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[data-pro-mode-host]")).not.toBeNull();
  });

  it("salir con cambios sin aplicar pregunta; «Descartar y salir» no deja snapshots ni borrador", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveDiscard }));
    await settle(10);
    expect(document.querySelector("[data-pro-mode-host]")).toBeNull();
    expect(topBar().getByText(S.suite.saved)).toBeTruthy();
    const { listEditDrafts } = await import("@/app/edit-pdf/editDrafts");
    expect(await listEditDrafts()).toHaveLength(0);
  });

  it("«Aplicar y salir» aplica UN snapshot y llega a la pestaña pedida", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    fireEvent.click(tab("Páginas"));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveApply }));
    });
    await settle(12);
    expect(tab("Páginas").getAttribute("aria-selected")).toBe("true");
    expect(topBar().getByText(S.suite.unsaved)).toBeTruthy();
  });

  it("«Anotar» ofrece la paleta de anotacion y aplica «Anotaciones (N)»", async () => {
    await openPro();
    await enter("Anotar");
    expect(document.querySelector('[data-pro-editor][data-variant="annotate"]')).not.toBeNull();
    expect(palette("note")).not.toBeNull();
    arm("highlight");
    drag([60, 400], [300, 420]);
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(applyButton().getAttribute("aria-disabled")).toBeNull());
    await applyNow();
    expect(history()).toEqual(["Original", M.annotate.label(2)]);
  });

  it("la tecla A abre Anotar con el foco en su paleta, y H arma el resaltador con el teclado", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "a" });
    await screen.findByTestId("edit-host");
    await waitFor(() => expect(document.activeElement).toBe(palette("select")));
    fireEvent.keyDown(document.activeElement!, { key: "h" });
    expect(palette("highlight").getAttribute("aria-pressed")).toBe("true");
  });

  it("la tecla E abre Editar", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "e" });
    await screen.findByTestId("edit-host");
    expect(document.querySelector('[data-pro-editor][data-variant="edit"]')).not.toBeNull();
  });

  it("«Añadir nota» de la paleta de comandos abre Anotar con la nota armada", async () => {
    await openPro();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: M.commands.addNote } });
    const option = await waitFor(() => {
      const found = within(dialog).getAllByRole("option").find((o) => o.textContent?.includes(M.commands.addNote));
      if (!found) throw new Error("aun no");
      return found;
    });
    fireEvent.click(option);
    await screen.findByTestId("edit-host");
    await waitFor(() => expect(palette("note").getAttribute("aria-pressed")).toBe("true"));
  });

  it("el visor suelta su PDF al entrar y lo reabre al volver (nunca dos a la vez)", async () => {
    await openPro();
    const closed = pdfMocks.close.mock.calls.length;
    await enter("Editar");
    expect(pdfMocks.close.mock.calls.length).toBeGreaterThan(closed);
    const opened = pdfMocks.open.mock.calls.length;
    fireEvent.click(discardButton());
    await settle(10);
    expect(pdfMocks.open.mock.calls.length).toBeGreaterThan(opened);
  });

  it("al volver, el visor se coloca en la pagina en la que se trabajaba (sin anunciarla encima de «Aplicado»)", async () => {
    await openPro(6);
    await enter("Editar");
    const go = screen.getByRole("textbox", { name: s.goToPageLabel }) as HTMLInputElement;
    fireEvent.change(go, { target: { value: "5" } });
    fireEvent.keyDown(go, { key: "Enter" });
    await settle(4);
    await drawRect();
    await applyNow();
    const page = screen.getByRole("textbox", { name: S.viewer.pageInputLabel }) as HTMLInputElement;
    await waitFor(() => expect(page.value).toBe("5"));
    expect(screen.getByRole("status").textContent).toContain(S.announce.applied(M.edit.label(1)));
  });

  it("entra en la pagina que se miraba en el visor", async () => {
    await openPro(6);
    const page = screen.getByRole("textbox", { name: S.viewer.pageInputLabel }) as HTMLInputElement;
    fireEvent.change(page, { target: { value: "3" } });
    fireEvent.keyDown(page, { key: "Enter" });
    await settle(6);
    await enter("Editar");
    expect((screen.getByRole("textbox", { name: s.goToPageLabel }) as HTMLInputElement).value).toBe("3");
  });

  it("Editar con el ajuste del texto existente apagado muestra el aviso con enlace a Ajustes", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    await openPro();
    await enter("Editar");
    expect(document.querySelector("[data-settings-link]")).not.toBeNull();
  });

  it("en ingles el modo y el editor hablan en ingles", async () => {
    await openPro(4, "en");
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await screen.findByTestId("edit-host");
    const E = MODE_STRINGS.en;
    expect(within(document.querySelector<HTMLElement>("[data-pro-mode-bar]")!).getByText(E.host.editing)).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: EDIT_STRINGS.en.inline.paletteLabel })).toBeTruthy();
  });

  it("movil: «Editar» en el dock monta el editor con la paleta debajo de la hoja y sin hoja modal", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByTestId("edit-host");
    expect(screen.queryByRole("dialog")).toBeNull();
    const toolbar = document.querySelector<HTMLElement>("[data-tool-palette]")!;
    expect(toolbar.className).toContain("max-md:order-last");
    expect(toolbar.className).not.toContain("max-md:fixed");
  });

  it("movil: aplicar devuelve el foco al boton del dock de origen", async () => {
    stubMobile();
    await openPro();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByTestId("edit-host");
    await waitFor(() => expect(document.querySelector("[data-tool-palette]")).not.toBeNull());
    await drawRect();
    await applyNow();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-dock="home"]')));
  });

  it("el foco nunca queda en <body> tras aplicar ni tras descartar", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    await applyNow();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    await enter("Anotar");
    fireEvent.click(discardButton());
    await settle(10);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("descargar con cambios sin aplicar pregunta y «Aplicar y salir» descarga lo aplicado", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    fireEvent.click(topBar().getByRole("button", { name: S.suite.download }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: M.host.leaveApply }));
    });
    await settle(12);
    await waitFor(() => expect(downloaded.blobs).toHaveLength(1));
    expect(downloaded.blobs[0].name).toContain("pro");
  });

  it("tras aplicar el documento queda marcado «sin guardar» y el historial de Inicio lo lista", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    await applyNow();
    expect(topBar().getByText(S.suite.unsaved)).toBeTruthy();
    expect(screen.getByRole("list", { name: S.suite.historyTitle })).toBeTruthy();
  });

  it("dos modos seguidos conservan lo primero aplicado", async () => {
    await openPro();
    await enter("Editar");
    await drawRect();
    await applyNow();
    await enter("Anotar");
    arm("check");
    drag([100, 400], [140, 440]);
    await waitFor(() => expect(applyButton().getAttribute("aria-disabled")).toBeNull());
    await applyNow();
    expect(history()).toHaveLength(3);
  });

  it("sin cambios «Aplicar» esta desactivado y no se crea ningun snapshot", async () => {
    await openPro();
    await enter("Editar");
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(applyButton());
    await settle();
    expect(document.querySelector("[data-pro-mode-host]")).not.toBeNull();
  });

  it("las miniaturas y el panel lateral vuelven al salir del modo", async () => {
    await openPro();
    await enter("Editar");
    expect(screen.queryByRole("complementary", { name: S.suite.thumbsTitle })).toBeNull();
    fireEvent.click(discardButton());
    await settle(10);
    expect(screen.getByRole("complementary", { name: S.suite.thumbsTitle })).toBeTruthy();
  });

  it("con el modo abierto hay UNA sola region viva (la de PDF Pro): el editor no monta las suyas (una region por suceso)", async () => {
    await openPro();
    await enter("Editar");
    const live = Array.from(document.querySelectorAll('[role="status"],[aria-live]:not([aria-live="off"])')).filter((el) => !el.closest("[role=dialog]"));
    expect(live).toHaveLength(1);
    expect(live[0].matches('p[role="status"][aria-atomic="true"]')).toBe(true);
    // Ni la pista contextual del editor, ni sus avisos, ni el estado de privacidad son regiones vivas propias.
    expect(document.querySelectorAll("[data-workspace-live]")).toHaveLength(0);
    expect(document.querySelector("[data-privacy-status]")!.hasAttribute("role")).toBe(false);
    expect(document.querySelector("[data-edit-notices] [role='status']")).toBeNull();
  });
});
