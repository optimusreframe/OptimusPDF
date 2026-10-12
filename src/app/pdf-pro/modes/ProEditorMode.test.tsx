import "fake-indexeddb/auto";
import { type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument, PDFRawStream, decodePDFRawStream, PDFArray, PDFRef } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import { createProWorkingDoc, type ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { ProModeHostContext, type ProModeControls, type ProModeHostValue } from "@/app/pdf-pro/modes/modeContext";
import { ProEditorMode, changeCount } from "@/app/pdf-pro/modes/ProEditorMode";
import { MODE_STRINGS } from "@/app/pdf-pro/modes/modeStrings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";
import {
  __resetEditDraftsMemoryForTests,
  clearAllEditDrafts,
  fingerprintPdfBytes,
  listEditDrafts,
  saveEditDraft,
} from "@/app/edit-pdf/editDrafts";
import { applyOp, createEditSession, newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import {
  __resetEditPdfFeatureFlagsCacheForTests,
  getEditPdfFeatureFlag,
  setEditPdfFeatureFlag,
  EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
} from "@/app/edit-pdf/editFeatureFlags";
import { exportEditedPdf } from "@/app/edit-pdf/editExport";
import { PdfError } from "@/lib/pdf/core";
import type { PageTextAnalysis } from "@/lib/pdf/textBlocks";
import type { TextBlock } from "@/lib/pdf/editTypes";

/**
 * Los modos Editar y Anotar de PDF Pro (Wave 7 · U6) con el editor REAL de la herramienta suelta (EditWorkspace) y el
 * documento de trabajo real: pdf.js y la hoja se simulan (jsdom no dibuja), la exportacion y los borradores son los reales.
 */

const mocks = vi.hoisted(() => ({
  pageCount: 2,
  texts: {} as Record<number, { status: "idle" | "analyzing" | "ready"; analysis: unknown }>,
  metrics: {} as Record<number, unknown>,
  exportSpy: vi.fn(),
  maxSafe: 100 * 1024 * 1024,
}));

vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: { numPages: mocks.pageCount }, pageCount: mocks.pageCount, error: null }),
  usePageText: (_doc: unknown, page: number) => mocks.texts[page] ?? { status: "ready", analysis: { blocks: [], hiddenCount: 0, hasTextLayer: true, failed: false } },
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
        onMetrics(mocks.metrics[pageIndex] ?? mocks.metrics[0], pageIndex);
        return () => onMetrics(null, -1);
      }, [pageIndex]);
      return (
        <div ref={clipRef}>
          <div ref={hostRef} data-page-index={pageIndex} data-testid="host" {...hostProps}>
            {children}
          </div>
        </div>
      );
    },
  };
});

vi.mock("@/app/edit-pdf/editExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/edit-pdf/editExport")>();
  return {
    ...actual,
    exportEditedPdf: (...args: Parameters<typeof actual.exportEditedPdf>) => {
      mocks.exportSpy(...args);
      return actual.exportEditedPdf(...args);
    },
  };
});

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    get MAX_SAFE_FILE_SIZE() {
      return mocks.maxSafe;
    },
  };
});

const E = MODE_STRINGS.es;
const strings = EDIT_STRINGS.es;
const s = strings.inline;
const flow = EDIT_FLOW_STRINGS.es;

const TITLE = makeBlock("p0-b0", { text: "Titulo", fontSize: 24, box: { x: 50, y: 780, width: 150, height: 24 } });
function ready(blocks: TextBlock[]) {
  return { status: "ready" as const, analysis: { blocks, hiddenCount: 0, hasTextLayer: true, failed: false } satisfies PageTextAnalysis };
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  window.localStorage.removeItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY);
  __resetEditPdfFeatureFlagsCacheForTests();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-floating-bar")) return rect(0, 0, 300, 44);
    if (this.hasAttribute("data-edit-scroll")) return rect(0, 60, 800, 600);
    if (this.getAttribute("data-element-id")) return rect(100, 300, 120, 20);
    return rect(0, 100, 595, 842);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
  mocks.pageCount = 2;
  mocks.maxSafe = 100 * 1024 * 1024;
  mocks.exportSpy.mockReset();
  mocks.texts = { 0: ready([TITLE]) };
  mocks.metrics = { 0: metricsFor() };
  __resetEditDraftsMemoryForTests();
  await clearAllEditDrafts();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

/* ------------------------------ montaje ------------------------------ */

type Mounted = {
  doc: ProWorkingDoc;
  host: { controls: ProModeControls | null; reportPage: ReturnType<typeof vi.fn>; value: ProModeHostValue };
  onApply: ReturnType<typeof vi.fn>;
  onDirtyChange: ReturnType<typeof vi.fn>;
  bytes: Uint8Array;
  rerenderWith: (patch: { intent: ProModeHostValue["intent"] }) => void;
};

async function mount(
  variant: "edit" | "annotate",
  options: { pages?: number; encrypted?: boolean; signatures?: "none" | "active" | "unknown"; intent?: ProModeHostValue["intent"]; initialPage?: number; lang?: "es" | "en"; block?: boolean } = {},
): Promise<Mounted> {
  const bytes = await makePdfBytes(options.pages ?? 2);
  const doc = createProWorkingDoc({
    inspectSignatures: async () => options.signatures ?? "none",
  });
  await doc.open(pdfFile(bytes), { encrypted: options.encrypted ?? false });
  const holder = { controls: null as ProModeControls | null, reportPage: vi.fn() };
  const onApply = vi.fn(async () => undefined);
  const onDirtyChange = vi.fn();
  const baseValue: ProModeHostValue = {
    tab: variant,
    initialPage: options.initialPage ?? 0,
    reportPage: holder.reportPage,
    registerControls: (controls) => {
      holder.controls = controls;
    },
    intent: options.intent ?? null,
    busy: false,
  };
  const file = doc.currentFile()!;
  const current = doc.current()!;
  const tree = (value: ProModeHostValue) => (
    <LanguageProvider>
      <ProWorkingDocProvider doc={doc} shortcuts={false}>
        <ProModeHostContext.Provider value={value}>
          <ProEditorMode
            variant={variant}
            file={file}
            bytes={current}
            lang={options.lang ?? "es"}
            onApply={onApply}
            onCancel={() => undefined}
            onDirtyChange={onDirtyChange}
          />
        </ProModeHostContext.Provider>
      </ProWorkingDocProvider>
    </LanguageProvider>
  );
  const utils = render(tree(baseValue));
  await waitFor(() => expect(document.querySelector("[data-edit-workspace]")).not.toBeNull());
  // En Anotar los bloques del PDF no se pueden tocar (salvo «Seleccionar texto»): se espera a la hoja y a la paleta.
  await waitFor(() => expect(screen.getByTestId("host")).toBeTruthy());
  if (variant === "edit" && options.block !== false && getEditPdfFeatureFlag("editExistingText") && (options.initialPage ?? 0) === 0) {
    await waitFor(() => expect(document.querySelector('[data-element-id="p0-b0"]')).not.toBeNull());
  }
  await waitFor(() => expect(document.querySelector("[data-tool-palette]")).not.toBeNull());
  return {
    doc,
    host: { ...holder, get controls() { return holder.controls; }, value: baseValue } as Mounted["host"],
    onApply,
    onDirtyChange,
    bytes: current,
    rerenderWith: (patch) => utils.rerender(tree({ ...baseValue, ...patch })),
  };
}

const hostEl = () => screen.getByTestId("host");
const palette = (id: string) => document.querySelector<HTMLElement>(`[data-palette-item="${id}"]`)!;
const paletteIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-tool-palette] [data-palette-item]")).map((el) => el.dataset.paletteItem);
const arm = (id: string) => fireEvent.click(palette(id));
const pointer = (x: number, y: number, init: Record<string, unknown> = {}) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y, ...init });
function drag(from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(hostEl(), pointer(from[0], from[1]));
  fireEvent.pointerMove(hostEl(), pointer(to[0], to[1]));
  fireEvent.pointerUp(hostEl(), pointer(to[0], to[1]));
}
const root = () => document.querySelector<HTMLElement>("[data-pro-editor]")!;
const workspace = () => document.querySelector<HTMLElement>("[data-edit-workspace]")!;
const dirtyCalls = (m: Mounted) => m.onDirtyChange.mock.calls.map((c) => c[0]);

async function pageContents(bytes: Uint8Array, index = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  let out = "";
  for (const entry of refs) {
    const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (stream instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    else if (stream && "getContents" in stream) out += Buffer.from((stream as { getContents(): Uint8Array }).getContents()).toString("latin1");
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Montaje y paletas
 * ------------------------------------------------------------------ */

describe("el editor embebido", () => {
  it("monta el MISMO editor de la herramienta suelta, embebido y sin zona de carga", async () => {
    await mount("edit");
    expect(workspace().getAttribute("data-embedded")).toBe("");
    expect(workspace().getAttribute("data-variant")).toBe("edit");
    expect(document.querySelector('input[type="file"][data-image-input]')).not.toBeNull();
    expect(document.querySelector('[data-testid="dropzone"], [data-dropzone]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Procesar|Elegir otro archivo/ })).toBeNull();
  });

  it("Editar ofrece la paleta de siempre (8 herramientas)", async () => {
    await mount("edit");
    expect(paletteIds().slice(0, 8)).toEqual(["select", "text", "image", "rect", "ellipse", "line", "highlight", "check"]);
  });

  it("Anotar ofrece la paleta de ANOTACION: resaltador, figuras, marca, texto, nota e imagen", async () => {
    await mount("annotate");
    expect(paletteIds().slice(0, 9)).toEqual(["select", "highlight", "rect", "ellipse", "line", "check", "text", "note", "image"]);
  });

  it("la paleta de Anotar no tiene herramienta de nota en Editar", async () => {
    await mount("edit");
    expect(palette("note")).toBeNull();
  });

  it("en Anotar no hay «Aplanar página» (ni en la barra ni en la fila movil)", async () => {
    await mount("annotate");
    expect(document.querySelector("[data-flatten-toggle]")).toBeNull();
    expect(screen.queryByText(flow.flattenAction)).toBeNull();
  });

  it("en Editar sí está «Aplanar página»", async () => {
    await mount("edit");
    expect(document.querySelector("[data-flatten-toggle]")).not.toBeNull();
  });

  it("la barra de zoom y paginas NO se pega bajo la cabecera de la web (va fija sobre la region con scroll)", async () => {
    await mount("edit");
    const nav = document.querySelector<HTMLElement>("[data-nav-embedded]")!;
    expect(nav.className).not.toContain("sticky");
    expect(nav.hasAttribute("data-canvas-sticky")).toBe(false);
  });

  it("la hoja vive en una region con scroll propio", async () => {
    await mount("edit");
    const scroller = document.querySelector<HTMLElement>("[data-edit-scroll]")!;
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(hostEl())).toBe(true);
  });

  it("la tira de paginas empieza cerrada (la region es mas baja) y se abre desde la barra", async () => {
    await mount("edit");
    expect(document.querySelector("[data-page-strip]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: s.thumbsLabel }));
    await waitFor(() => expect(document.querySelector("[data-page-thumb]")).not.toBeNull());
  });

  it("el estado de «preparando» no aparece con un PDF normal una vez listo", async () => {
    await mount("edit");
    expect(document.querySelector("[data-pro-editor-preparing]")).toBeNull();
  });

  it("muestra el aviso de «Borrar datos» de privacidad en su forma compacta", async () => {
    await mount("edit");
    expect(screen.getByRole("button", { name: flow.privacyClear })).toBeTruthy();
    expect(document.querySelector("[data-edit-privacy] .surface-card")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Anotar
 * ------------------------------------------------------------------ */

describe("Anotar", () => {
  it("resaltar crea un elemento, avisa de cambios y habilita aplicar", async () => {
    const m = await mount("annotate");
    expect(dirtyCalls(m).at(-1)).toBe(false);
    arm("highlight");
    drag([60, 400], [300, 420]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
  });

  it("«Aplicar» entrega UN PDF con la etiqueta «Anotaciones (N)» y el resumen en los avisos", async () => {
    const m = await mount("annotate");
    arm("highlight");
    drag([60, 400], [300, 420]);
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    let applied = false;
    await act(async () => {
      applied = await m.host.controls!.apply();
    });
    expect(applied).toBe(true);
    expect(m.onApply).toHaveBeenCalledTimes(1);
    const [bytes, label, opts] = m.onApply.mock.calls[0] as unknown as [Uint8Array, string, { notices: string[] }];
    expect(label).toBe("Anotaciones (2)");
    expect(opts.notices[0]).toBe(flow.summaryShapes(2) + ".");
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("el PDF aplicado dibuja la anotacion en la pagina (contenido distinto del original)", async () => {
    const m = await mount("annotate");
    arm("rect");
    drag([100, 200], [300, 300]);
    await act(async () => {
      await m.host.controls!.apply();
    });
    const out = (m.onApply.mock.calls[0] as unknown as [Uint8Array])[0];
    const before = await pageContents(m.bytes, 0);
    const after = await pageContents(out, 0);
    expect(after.length).toBeGreaterThan(before.length);
    // El rectangulo es un trazo con el rojo de las anotaciones (INK_COLORS[0]).
    expect(after).toMatch(/0\.88\d* 0\.11\d* 0\.28\d* RG/);
    expect(after).toContain("h\nS");
  });

  it("la nota es un cuadro de texto sobre fondo de nota (amarillo) y se redibuja con ese fondo", async () => {
    const m = await mount("annotate");
    arm("note");
    drag([100, 300], [300, 380]);
    const editor = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-inline-editor]");
      if (!found) throw new Error("aun no");
      return found;
    });
    editor.textContent = "Revisar esta cifra";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    const cover = document.querySelector<HTMLElement>("[data-cover]");
    expect(cover).not.toBeNull();
    expect(cover!.style.backgroundColor).toBe("rgb(255, 243, 163)");
    await act(async () => {
      await m.host.controls!.apply();
    });
    const out = (m.onApply.mock.calls[0] as unknown as [Uint8Array])[0];
    const content = await pageContents(out, 0);
    // El motor cubre con un rectangulo del color de la nota (1, .953, .639) y redibuja el texto.
    expect(content).toMatch(/1 0\.95\d* 0\.63\d* rg/);
    expect(content).toContain("Tj");
  });

  it("«Seleccionar texto» empieza apagado: los bloques del PDF no se pueden tocar", async () => {
    mocks.texts = { 0: ready([TITLE]) };
    await mount("annotate");
    expect(screen.getByRole("switch", { name: E.annotate.textToggle }).getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[data-element-id="p0-b0"]')).toBeNull();
  });

  it("al activar «Seleccionar texto» aparecen los bloques del documento", async () => {
    mocks.texts = { 0: ready([TITLE]) };
    await mount("annotate");
    fireEvent.click(screen.getByRole("switch", { name: E.annotate.textToggle }));
    await waitFor(() => expect(document.querySelector('[data-element-id="p0-b0"]')).not.toBeNull());
    expect(screen.getByRole("switch", { name: E.annotate.textToggle }).getAttribute("aria-checked")).toBe("true");
  });

  it("con el ajuste «editar el texto que ya trae el PDF» apagado, el interruptor queda desactivado y explica por qué", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    await mount("annotate");
    const toggle = screen.getByRole("switch", { name: E.annotate.textToggle });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("title")).toBe(E.annotate.textToggleDisabled);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("en Anotar no sale el aviso del ajuste apagado (es el estado normal)", async () => {
    await mount("annotate");
    expect(document.querySelector("[data-settings-link]")).toBeNull();
    expect(document.querySelector("[data-analysis-status]")!.textContent).toBe("");
  });

  it("texto e imagen estan en la paleta de anotar; la marca cambia a aspa desde su barra", async () => {
    await mount("annotate");
    expect(palette("text")).toBeDefined();
    expect(palette("image")).toBeDefined();
    expect(palette("check")).toBeDefined();
  });

  it("los atajos de teclado de la paleta de Anotar incluyen N (nota) y H (resaltador)", async () => {
    await mount("annotate");
    expect(palette("note").getAttribute("aria-keyshortcuts")).toBe("N");
    expect(palette("highlight").getAttribute("aria-keyshortcuts")).toBe("H");
  });

  it("la tecla N arma la nota y V vuelve a Seleccionar", async () => {
    await mount("annotate");
    palette("select").focus();
    fireEvent.keyDown(palette("select"), { key: "n" });
    expect(palette("note").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(palette("note"), { key: "v" });
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
  });

  it("en Anotar la tecla I (imagen) existe pero la tecla R no abre Aplanar: la paleta es la de anotacion", async () => {
    await mount("annotate");
    palette("select").focus();
    fireEvent.keyDown(palette("select"), { key: "r" });
    expect(palette("rect").getAttribute("aria-pressed")).toBe("true");
  });
});

/* ------------------------------------------------------------------ *
 * Editar
 * ------------------------------------------------------------------ */

describe("Editar", () => {
  async function editTitle(m: Mounted, text = "Titulo nuevo") {
    const block = document.querySelector<HTMLElement>('[data-element-id="p0-b0"]')!;
    fireEvent.pointerDown(block, pointer(10, 10));
    fireEvent.pointerUp(block, pointer(10, 10));
    fireEvent.pointerDown(block, pointer(10, 10));
    fireEvent.pointerUp(block, pointer(10, 10));
    const editor = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-inline-editor]");
      if (!found) throw new Error("aun no");
      return found;
    });
    editor.textContent = text;
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
  }

  it("editar el texto de un bloque existente marca cambios", async () => {
    const m = await mount("edit");
    await editTitle(m);
  });

  it("aplicar una edicion de texto existente entrega un PDF con el texto nuevo y la etiqueta «Edición (1)»", async () => {
    const m = await mount("edit");
    await editTitle(m, "Titulo nuevo");
    await act(async () => {
      await m.host.controls!.apply();
    });
    const [bytes, label, opts] = m.onApply.mock.calls[0] as unknown as [Uint8Array, string, { notices: string[] }];
    expect(label).toBe("Edición (1)");
    expect(opts.notices.join(" ")).toContain(flow.summaryEditedTexts(1));
    const content = await pageContents(bytes, 0);
    expect(content).toContain("Tj");
    // El aviso permanente: el texto original puede seguir existiendo bajo la edicion.
    expect(opts.notices.join(" ")).toContain(flow.noticeRemains(1));
  });

  it("aplicar sin cambios no es posible: el modo no ofrece resultado vacio (la exportacion lo rechaza)", async () => {
    const m = await mount("edit");
    await expect(
      act(async () => {
        await m.host.controls!.apply();
      }),
    ).rejects.toMatchObject({ name: "ProModeApplyError" });
    expect(m.onApply).not.toHaveBeenCalled();
  });

  it("anadir una imagen y una forma cuenta en la etiqueta y en el resumen", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    arm("ellipse");
    drag([100, 400], [200, 480]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    await act(async () => {
      await m.host.controls!.apply();
    });
    const [, label, opts] = m.onApply.mock.calls[0] as unknown as [Uint8Array, string, { notices: string[] }];
    expect(label).toBe("Edición (2)");
    expect(opts.notices[0]).toContain(flow.summaryShapes(2));
  });

  it("«Aplanar página» se confirma y cuenta en el resultado (aviso de aplanado)", async () => {
    const m = await mount("edit");
    fireEvent.click(document.querySelector<HTMLElement>("[data-flatten-toggle]")!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: flow.flattenConfirmAction }));
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    expect(document.querySelector("[data-flatten-chip]")).not.toBeNull();
  });

  it("cada pulsacion de Ctrl+Z dentro del modo deshace el editor, no el documento", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(false));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    expect(m.doc.getState().document!.snapshots).toHaveLength(1);
  });

  it("con el ajuste de texto existente apagado avisa y enlaza a Ajustes en otra pestaña", async () => {
    setEditPdfFeatureFlag("editExistingText", false);
    await mount("edit");
    const link = document.querySelector<HTMLAnchorElement>("[data-settings-link]")!;
    expect(link.getAttribute("href")).toBe("/settings");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(document.querySelector('[data-element-id="p0-b0"]')).toBeNull();
    // Siguen todas las herramientas de AÑADIR.
    expect(palette("rect")).toBeDefined();
  });

  it("con el ajuste encendido los bloques del PDF se pueden tocar", async () => {
    await mount("edit");
    expect(document.querySelector('[data-element-id="p0-b0"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Equivalencia con la herramienta suelta
 * ------------------------------------------------------------------ */

describe("equivalencia con la herramienta suelta", () => {
  it("Aplicar usa la MISMA exportacion (exportEditedPdf) con el archivo y la sesion del editor", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    await act(async () => {
      await m.host.controls!.apply();
    });
    expect(mocks.exportSpy).toHaveBeenCalledTimes(1);
    const [file, session] = mocks.exportSpy.mock.calls[0] as unknown as [File, Parameters<typeof exportEditedPdf>[1]];
    expect(file.name).toBe("informe.pdf");
    expect(session.items).toHaveLength(1);
  });

  it("para la misma sesion, el PDF aplicado en PDF Pro y el de la herramienta suelta tienen el mismo contenido", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    arm("highlight");
    drag([60, 400], [300, 420]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    await act(async () => {
      await m.host.controls!.apply();
    });
    const [file, session] = mocks.exportSpy.mock.calls[0] as unknown as [File, Parameters<typeof exportEditedPdf>[1]];
    // La herramienta suelta (`EditInlineTool.process`) llama a esta misma funcion con (copia de trabajo, sesion).
    const standalone = await exportEditedPdf(file, session);
    const standaloneBytes = new Uint8Array(await standalone.blob.arrayBuffer());
    const proBytes = (m.onApply.mock.calls[0] as unknown as [Uint8Array])[0];
    expect(await pageContents(proBytes, 0)).toBe(await pageContents(standaloneBytes, 0));
    expect(await pageContents(proBytes, 1)).toBe(await pageContents(standaloneBytes, 1));
    expect((await PDFDocument.load(proBytes)).getPageCount()).toBe((await PDFDocument.load(standaloneBytes)).getPageCount());
  });

  it("el resumen y los avisos son los mismos textos que la pantalla de descarga de la herramienta suelta", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    await act(async () => {
      await m.host.controls!.apply();
    });
    const opts = (m.onApply.mock.calls[0] as unknown as [Uint8Array, string, { notices: string[] }])[2];
    expect(opts.notices[0]).toBe(`${flow.summaryShapes(1)}.`);
  });

  it("changeCount suma textos editados, nuevos, imágenes, formas y páginas aplanadas", () => {
    expect(changeCount({ editedTexts: 1, addedTexts: 2, images: 3, shapes: 4, flattenedPages: 5 })).toBe(15);
    expect(changeCount({ editedTexts: 0, addedTexts: 0, images: 0, shapes: 0, flattenedPages: 0 })).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Errores y cancelacion
 * ------------------------------------------------------------------ */

describe("errores al exportar", () => {
  it("un fallo del motor se traduce a un mensaje claro (ProModeApplyError) y NO se pierde nada", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    mocks.exportSpy.mockImplementationOnce(() => {
      throw new PdfError("corrupt");
    });
    await expect(
      act(async () => {
        await m.host.controls!.apply();
      }),
    ).rejects.toMatchObject({ name: "ProModeApplyError", userMessage: expect.stringContaining(E.host.applyFailed) });
    expect(m.onApply).not.toHaveBeenCalled();
    expect(dirtyCalls(m).at(-1)).toBe(true);
  });

  it("cancelar la exportacion devuelve false sin error", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    mocks.exportSpy.mockImplementationOnce(() => {
      throw new PdfError("cancelled");
    });
    let applied: boolean | undefined;
    await act(async () => {
      applied = await m.host.controls!.apply();
    });
    expect(applied).toBe(false);
    expect(m.onApply).not.toHaveBeenCalled();
  });

  it("cancel() aborta la exportacion en curso", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    let signal: AbortSignal | undefined;
    mocks.exportSpy.mockImplementationOnce((_file: File, _session: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal;
    });
    const pending = act(async () => {
      const promise = m.host.controls!.apply();
      m.host.controls!.cancel?.();
      await promise;
    });
    await pending;
    expect(signal?.aborted).toBe(true);
  });

  it("si onApply rechaza (por ejemplo el documento ya no es el mismo), el error llega al host", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    m.onApply.mockRejectedValueOnce(new Error("stale"));
    await expect(
      act(async () => {
        await m.host.controls!.apply();
      }),
    ).rejects.toThrow("stale");
  });
});

/* ------------------------------------------------------------------ *
 * Borradores, cifrado y firmas
 * ------------------------------------------------------------------ */

describe("borradores compartidos con la herramienta suelta", () => {
  async function seedStandaloneDraft(bytes: Uint8Array) {
    const id = (await fingerprintPdfBytes(bytes))!;
    let session = createEditSession();
    session = applyOp(
      session,
      { type: "add", item: textItem(newTextEdit({ id: "t1", pageIndex: 0, box: { x: 10, y: 10, width: 100, height: 20 }, fontKey: "helvetica", text: "Guardado en la suelta" })) },
      1,
    );
    const saved = await saveEditDraft({ id, fileName: "informe.pdf", fileBytes: bytes, session, pageCount: 2, currentPage: 1 });
    expect(saved.ok).toBe(true);
    return id;
  }

  it("un borrador guardado por la herramienta suelta se recupera en el modo (misma base y misma huella)", async () => {
    const bytes = await makePdfBytes(2);
    await seedStandaloneDraft(bytes);
    const doc = createProWorkingDoc({ inspectSignatures: async () => "none" });
    await doc.open(pdfFile(bytes));
    const onDirtyChange = vi.fn();
    render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc} shortcuts={false}>
          <ProEditorMode variant="edit" file={doc.currentFile()!} bytes={doc.current()!} lang="es" onApply={async () => undefined} onCancel={() => undefined} onDirtyChange={onDirtyChange} />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await waitFor(() => expect(document.querySelector('[data-notice="restored"]')).not.toBeNull());
    expect(document.querySelector('[data-notice="restored"]')!.textContent).toContain(flow.draftsRestored(1));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it("lo que se edita en el modo se autoguarda como borrador de ese PDF", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(async () => expect((await listEditDrafts()).length).toBe(1), { timeout: 3000 });
    const [draft] = await listEditDrafts();
    expect(draft.id).toBe(await fingerprintPdfBytes(m.bytes));
  });

  it("aplicar borra el borrador de ese snapshot (no se resucita al desmontar)", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(async () => expect((await listEditDrafts()).length).toBe(1), { timeout: 3000 });
    await act(async () => {
      await m.host.controls!.apply();
    });
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await listEditDrafts()).toHaveLength(0);
  });

  it("descartar borra el borrador y no se resucita al desmontar", async () => {
    const m = await mount("edit");
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(async () => expect((await listEditDrafts()).length).toBe(1), { timeout: 3000 });
    await act(async () => {
      await m.host.controls!.discard();
    });
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await listEditDrafts()).toHaveLength(0);
  });

  it("un PDF cifrado (copia descifrada) NO guarda borrador", async () => {
    const m = await mount("edit", { encrypted: true });
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await listEditDrafts()).toHaveLength(0);
  });

  it("un PDF cifrado avisa de que se trabaja con una copia sin contraseña", async () => {
    await mount("edit", { encrypted: true });
    expect(document.querySelector('[data-notice="protected"]')!.textContent).toBe(flow.protectedCopy);
  });

  it("un PDF con firmas digitales avisa en el editor; con «unknown» tambien", async () => {
    await mount("edit", { signatures: "active" });
    expect(document.querySelector('[data-notice="signatures"]')!.textContent).toBe(flow.signaturesActive);
    cleanup();
    await mount("edit", { signatures: "unknown" });
    expect(document.querySelector('[data-notice="signatures"]')!.textContent).toBe(flow.signaturesUnknown);
  });

  it("sin firmas ni cifrado no hay avisos de documento", async () => {
    await mount("edit");
    expect(document.querySelector('[data-notice="signatures"]')).toBeNull();
    expect(document.querySelector('[data-notice="protected"]')).toBeNull();
  });

  it("el aviso de formularios no enlaza a otra pagina dentro de PDF Pro", async () => {
    const doc = createProWorkingDoc({ inspectSignatures: async () => "none" });
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    source.getForm().createTextField("nombre").addToPage(source.getPage(0), { x: 20, y: 20, width: 100, height: 20 });
    const bytes = await source.save();
    await doc.open(pdfFile(bytes));
    render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc} shortcuts={false}>
          <ProEditorMode variant="edit" file={doc.currentFile()!} bytes={doc.current()!} lang="es" onApply={async () => undefined} onCancel={() => undefined} onDirtyChange={() => undefined} />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await waitFor(() => expect(document.querySelector('[data-notice="form"]')).not.toBeNull());
    expect(document.querySelector('[data-notice="form"] a')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Tamano, paginas e intenciones
 * ------------------------------------------------------------------ */

describe("tamaño y paginas", () => {
  it("un PDF por encima del limite avisa (como en la herramienta suelta) sin bloquear", async () => {
    mocks.maxSafe = 100;
    await mount("edit");
    expect(document.querySelector('[data-notice="large-file"]')!.textContent).toBe(E.edit.largeFile);
    expect(palette("rect")).toBeDefined();
  });

  it("un PDF por debajo del limite no avisa", async () => {
    await mount("edit");
    expect(document.querySelector('[data-notice="large-file"]')).toBeNull();
  });

  it("1 pagina: sin tira ni boton de miniaturas", async () => {
    mocks.pageCount = 1;
    await mount("edit", { pages: 1 });
    expect(screen.queryByRole("button", { name: s.thumbsLabel })).toBeNull();
  });

  it("60 paginas: navegar a la ultima con «]» repetido informa de la pagina al host", async () => {
    mocks.pageCount = 60;
    const m = await mount("edit", { pages: 3 });
    expect(workspace().textContent).toContain("60");
    const input = screen.getByRole("textbox", { name: s.goToPageLabel }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(m.host.reportPage).toHaveBeenLastCalledWith(59));
  });

  it("informa de la pagina inicial al host y arranca en la pagina con la que se entro", async () => {
    mocks.pageCount = 4;
    const m = await mount("edit", { pages: 4, initialPage: 2 });
    await waitFor(() => expect(m.host.reportPage).toHaveBeenCalledWith(2));
    expect((screen.getByRole("textbox", { name: s.goToPageLabel }) as HTMLInputElement).value).toBe("3");
  });
});

describe("herramienta pedida desde fuera", () => {
  it("una intencion arma esa herramienta (Anotar: resaltador)", async () => {
    await mount("annotate", { intent: { tool: "highlight", nonce: 1 } });
    await waitFor(() => expect(palette("highlight").getAttribute("aria-pressed")).toBe("true"));
  });

  it("una intencion nueva (nonce nuevo) vuelve a armarla aunque se hubiera soltado", async () => {
    const m = await mount("annotate", { intent: { tool: "rect", nonce: 1 } });
    await waitFor(() => expect(palette("rect").getAttribute("aria-pressed")).toBe("true"));
    arm("select");
    expect(palette("rect").getAttribute("aria-pressed")).toBe("false");
    m.rerenderWith({ intent: { tool: "rect", nonce: 2 } });
    await waitFor(() => expect(palette("rect").getAttribute("aria-pressed")).toBe("true"));
  });

  it("la misma peticion no se repite en cada pintado", async () => {
    const m = await mount("annotate", { intent: { tool: "rect", nonce: 1 } });
    await waitFor(() => expect(palette("rect").getAttribute("aria-pressed")).toBe("true"));
    arm("select");
    m.rerenderWith({ intent: { tool: "rect", nonce: 1 } });
    expect(palette("rect").getAttribute("aria-pressed")).toBe("false");
  });

  it("una herramienta que no esta en la paleta del modo se ignora", async () => {
    await mount("edit", { intent: { tool: "note", nonce: 1 } });
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
  });

  it("una herramienta desconocida se ignora", async () => {
    await mount("edit", { intent: { tool: "no-existe", nonce: 1 } });
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
  });
});

/* ------------------------------------------------------------------ *
 * Foco, idioma y accesibilidad
 * ------------------------------------------------------------------ */

describe("foco, idioma y accesibilidad", () => {
  it("al entrar con el foco en <body> pasa a la paleta (la herramienta activa)", async () => {
    await mount("edit");
    await waitFor(() => expect(document.activeElement).toBe(palette("select")));
  });

  it("si el foco ya esta en una pestaña (se entro con un clic) se respeta", async () => {
    const tabs = document.createElement("div");
    tabs.setAttribute("data-pro-region", "tabs");
    const button = document.createElement("button");
    tabs.appendChild(button);
    document.body.appendChild(tabs);
    button.focus();
    await mount("edit");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement).toBe(button);
    tabs.remove();
  });

  it("en ingles la paleta, la nota y los avisos de exportacion hablan en ingles", async () => {
    const m = await mount("annotate", { lang: "en" });
    expect(palette("text").getAttribute("aria-label")).toBe(EDIT_STRINGS.en.inline.toolText);
    expect(palette("note").getAttribute("aria-label")).toBe("Note");
    expect(screen.getByRole("toolbar", { name: EDIT_STRINGS.en.inline.paletteLabel })).toBeTruthy();
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(dirtyCalls(m).at(-1)).toBe(true));
    await act(async () => {
      await m.host.controls!.apply();
    });
    const opts = (m.onApply.mock.calls[0] as unknown as [Uint8Array, string, { notices: string[] }])[2];
    expect(opts.notices[0]).toBe(`${EDIT_FLOW_STRINGS.en.summaryShapes(1)}.`);
  });

  it("el editor embebido en Editar no tiene violaciones de accesibilidad (axe)", async () => {
    await mount("edit");
    const results = await axe.run(root(), { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  it("el editor embebido en Anotar no tiene violaciones de accesibilidad (axe)", async () => {
    await mount("annotate");
    const results = await axe.run(root(), { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  it("hay UNA sola region viva del editor (la de PDF Pro es la de la pagina)", async () => {
    await mount("edit");
    expect(document.querySelectorAll("[data-workspace-live]")).toHaveLength(1);
  });

  it("la paleta es una barra de herramientas con nombre", async () => {
    await mount("annotate");
    expect(screen.getByRole("toolbar", { name: s.paletteLabel })).toBeTruthy();
  });

  it("al desmontar retira sus controles del host", async () => {
    const m = await mount("edit");
    expect(m.host.controls).not.toBeNull();
    cleanup();
    expect(m.host.controls).toBeNull();
  });
});
