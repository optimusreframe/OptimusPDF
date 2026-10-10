import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DocumentCanvas,
  SUGGESTIONS_DEFAULT_MAX,
  type CanvasSelection,
  type PlacementTool,
} from "@/app/sign-pdf/DocumentCanvas";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { detectRasterFields, type DetectedField } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/**
 * Campos SUGERIDOS (W6-A): la heuristica ya no llena la pagina de «Field N». Las
 * sugerencias son una capa opcional con un interruptor «Campos sugeridos (N)»
 * (apagado por defecto con mas de 8), sin etiqueta generica, que no cuentan
 * como campos pendientes y que pasan a ser del usuario en cuanto las toca.
 */

const page = vi.hoisted(() => ({ hasText: true as boolean | undefined }));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({
        cleanup: () => {},
        getViewport: () => ({ width: 600, height: 800 }),
        ...(page.hasText === undefined
          ? {}
          : { getTextContent: async () => ({ items: page.hasText ? [{ str: "Hola" }] : [] }) }),
      }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectRasterFields: vi.fn(async () => []) };
});

const strings = SIGN_STRINGS.es;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

beforeEach(() => {
  page.hasText = true;
  __resetValueHistoryCacheForTests();
  vi.mocked(detectRasterFields).mockReset();
  vi.mocked(detectRasterFields).mockResolvedValue([]);
});

const FILE = new File([new Uint8Array([1, 2, 3])], "formulario.pdf", { type: "application/pdf" });

function suggestion(index: number, label?: string, pageIndex = 0): DetectedField {
  return {
    id: `vec-${pageIndex}-${index}`,
    pageIndex,
    rect: { x: 0.1, y: 0.05 + index * 0.04, width: 0.3, height: 0.02 },
    ...(label ? { label } : {}),
    source: "heuristic-vector",
    confidence: "medium",
  };
}

function Harness({
  initial,
  onFields,
  initialValues = {},
}: {
  initial: DetectedField[];
  onFields?: (fields: DetectedField[]) => void;
  initialValues?: Record<string, string>;
}) {
  const [fields, setFields] = useState(initial);
  const [values, setValues] = useState(initialValues);
  const [tool, setTool] = useState<PlacementTool>("select");
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <DocumentCanvas
      file={FILE}
      signers={[]}
      activeSignerId={null}
      onActiveSignerIdChange={() => {}}
      tool={tool}
      onToolChange={setTool}
      slots={[]}
      onSlotsChange={() => {}}
      textFields={fields}
      onTextFieldsChange={(next) => {
        setFields(next);
        onFields?.(next);
      }}
      values={values}
      onValueChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selection={selection}
      onSelectionChange={setSelection}
      editingId={editingId}
      onEditingIdChange={setEditingId}
      strings={strings}
      richFieldTypesEnabled
    />
  );
}

const boxes = () => document.querySelectorAll('[data-element-kind="text"][data-drag-mode="move"]');
const toggle = () => screen.queryByRole("switch");

async function ready() {
  await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
}

function many(count: number): DetectedField[] {
  return Array.from({ length: count }, (_, index) => suggestion(index, `Campo real ${index}:`));
}

describe("interruptor «Campos sugeridos (N)»", () => {
  it("con hasta 8 sugerencias arranca ACTIVADO y las pinta", async () => {
    render(<Harness initial={many(SUGGESTIONS_DEFAULT_MAX)} />);
    await ready();
    const sw = toggle()!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.textContent).toContain(strings.suggestedFieldsToggle(SUGGESTIONS_DEFAULT_MAX));
    expect(boxes()).toHaveLength(SUGGESTIONS_DEFAULT_MAX);
  });

  it("con mas de 8 arranca APAGADO: la pagina se ve limpia y el contador dice cuantas hay", async () => {
    render(<Harness initial={many(SUGGESTIONS_DEFAULT_MAX + 1)} />);
    await ready();
    const sw = toggle()!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toContain(strings.suggestedFieldsToggle(SUGGESTIONS_DEFAULT_MAX + 1));
    expect(boxes()).toHaveLength(0);
  });

  it("encenderlo las muestra y lo anuncia; apagarlo las oculta", async () => {
    render(<Harness initial={many(20)} />);
    await ready();
    fireEvent.click(toggle()!);
    expect(boxes()).toHaveLength(20);
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(screen.getByText(strings.suggestedFieldsShown(20))).toBeTruthy());
    fireEvent.click(toggle()!);
    expect(boxes()).toHaveLength(0);
    await waitFor(() => expect(screen.getByText(strings.suggestedFieldsHidden)).toBeTruthy());
  });

  it("sin sugerencias el interruptor ni aparece", async () => {
    render(<Harness initial={[]} />);
    await ready();
    expect(toggle()).toBeNull();
  });

  it("los campos de AcroForm reales se ven siempre, con el interruptor apagado", async () => {
    const real: DetectedField = {
      id: "acro-1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.04 },
      label: "cliente",
      source: "acroform",
      confidence: "high",
    };
    render(<Harness initial={[real, ...many(30)]} />);
    await ready();
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(boxes()).toHaveLength(1);
    expect(screen.getByRole("group", { name: /^cliente, / })).toBeTruthy();
    // El contador solo cuenta las sugerencias, no el campo real.
    expect(toggle()!.textContent).toContain(strings.suggestedFieldsToggle(30));
  });

  it("el interruptor es un `switch` con objetivo de 44 px bajo puntero grueso", async () => {
    render(<Harness initial={many(3)} />);
    await ready();
    expect(toggle()!.className).toContain("pointer-coarse:min-h-11");
  });

  it("el estado inicial se decide UNA vez: escribir en una sugerencia no lo voltea al bajar de 9 a 8", async () => {
    render(<Harness initial={many(9)} />);
    await ready();
    fireEvent.click(toggle()!);
    fireEvent.click(toggle()!);
    // Apagado a mano: sigue apagado aunque el recuento cambie.
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  });
});

describe("sin «Field N» genericos", () => {
  it("una sugerencia sin etiqueta del documento no pinta ningun rotulo visible", async () => {
    render(<Harness initial={[suggestion(0), suggestion(1)]} />);
    await ready();
    expect(boxes()).toHaveLength(2);
    expect(screen.queryByText(strings.textFieldFallbackLabel(1))).toBeNull();
    expect(screen.queryByText(strings.textFieldFallbackLabel(2))).toBeNull();
    // El nombre accesible si distingue cada campo.
    expect(screen.getByRole("group", { name: new RegExp(`^${strings.textFieldFallbackLabel(1)}, `) })).toBeTruthy();
  });

  it("una etiqueta REAL del documento si se pinta (oculta hasta apuntarla en una sugerencia)", async () => {
    render(<Harness initial={[suggestion(0, "Nombre:")]} />);
    await ready();
    const label = screen.getByText("Nombre:").parentElement!;
    expect(label.className).toContain("opacity-0");
    expect(label.className).toContain("group-hover:opacity-100");
  });

  it("un campo manual sin etiqueta tampoco pinta «Campo N»", async () => {
    const manual: DetectedField = {
      id: "m1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      source: "manual",
      confidence: "high",
    };
    render(<Harness initial={[manual]} />);
    await ready();
    expect(boxes()).toHaveLength(1);
    expect(screen.queryByText(strings.textFieldFallbackLabel(1))).toBeNull();
  });

  it("un campo REAL con etiqueta la muestra siempre", async () => {
    const real: DetectedField = {
      id: "a1",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "acroform",
      confidence: "high",
    };
    render(<Harness initial={[real]} />);
    await ready();
    expect(screen.getByText("Nombre").parentElement!.className).not.toContain("opacity-0");
  });
});

describe("accesibilidad de la capa de sugeridos", () => {
  it("un hueco del raster sin etiqueta se llama «Hueco encontrado en una pagina escaneada, N», no «Campo N»", async () => {
    const raster: DetectedField = {
      id: "raster-0-0",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.5, width: 0.4, height: 0.03 },
      source: "heuristic-raster",
      confidence: "low",
    };
    render(<Harness initial={[raster, { ...raster, id: "raster-0-1", rect: { ...raster.rect, y: 0.6 } }]} />);
    await ready();
    expect(screen.getByRole("group", { name: new RegExp(`^${strings.scannedFieldLabel(1)}, `) })).toBeTruthy();
    expect(screen.getByRole("group", { name: new RegExp(`^${strings.scannedFieldLabel(2)}, `) })).toBeTruthy();
    expect(screen.queryByRole("group", { name: new RegExp(`^${strings.textFieldFallbackLabel(1)}, `) })).toBeNull();
    expect(strings.scannedFieldLabel(3)).toBe("Hueco encontrado en una página escaneada, 3");
    expect(SIGN_STRINGS.en.scannedFieldLabel(3)).toBe("Blank found on a scanned page, 3");
  });

  it("el interruptor define su estado en colores forzados: sistema Highlight al encender; pista y pulgar con currentColor", async () => {
    render(<Harness initial={many(3)} />);
    await ready();
    const sw = toggle()!;
    expect(sw.className).toContain("forced-colors:border-[Highlight]");
    expect(sw.className).toContain("forced-colors:bg-[Highlight]");
    expect(sw.className).toContain("forced-colors:text-[HighlightText]");
    // Colores de SISTEMA (un `currentColor` se sustituye por Canvas y el pulgar desaparece).
    expect(sw.querySelector("[data-switch-track]")!.className).toContain("forced-colors:border-[HighlightText]");
    expect(sw.querySelector("[data-switch-thumb]")!.className).toContain("forced-colors:bg-[HighlightText]");
    // Apagado: color de boton, sin Highlight (se distingue del encendido).
    fireEvent.click(sw);
    expect(toggle()!.className).not.toContain("forced-colors:bg-[Highlight]");
    expect(toggle()!.className).toContain("forced-colors:bg-[ButtonFace]");
    expect(toggle()!.querySelector("[data-switch-thumb]")!.className).not.toContain("translate-x-3");
    expect(toggle()!.querySelector("[data-switch-thumb]")!.className).toContain("forced-colors:bg-[ButtonText]");
    expect(toggle()!.querySelector("[data-switch-track]")!.className).toContain("forced-colors:border-[ButtonText]");
  });
});

describe("una sugerencia pasa a ser del usuario al tocarla", () => {
  it("escribir en ella la deja visible aunque se apague el interruptor, y deja de contar como sugerencia", async () => {
    render(<Harness initial={many(12)} />);
    await ready();
    fireEvent.click(toggle()!);
    const group = screen.getByRole("group", { name: /^Campo real 0:, / });
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    const input = await screen.findByRole("textbox", { name: "Campo real 0:" });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.blur(input);
    fireEvent.click(toggle()!);
    expect(boxes()).toHaveLength(1);
    expect(screen.getByRole("group", { name: /^Campo real 0:, / })).toBeTruthy();
    expect(toggle()!.textContent).toContain(strings.suggestedFieldsToggle(11));
  });

  it("moverla la convierte en un campo manual (ya no es una sugerencia que se oculte)", async () => {
    const seen: DetectedField[][] = [];
    render(<Harness initial={many(10)} onFields={(next) => seen.push(next)} />);
    await ready();
    fireEvent.click(toggle()!);
    const group = screen.getByRole("group", { name: /^Campo real 1:, / });
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(group, { pointerId: 1, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(group, { pointerId: 1, clientX: 140, clientY: 130 });
    const moved = seen[seen.length - 1].find((field) => field.id === "vec-0-1")!;
    expect(moved.source).toBe("manual");
  });

  it("una sugerencia seleccionada sigue visible con el interruptor apagado (el resto se oculta)", async () => {
    render(<Harness initial={many(10)} />);
    await ready();
    fireEvent.click(toggle()!);
    const group = screen.getByRole("group", { name: /^Campo real 2:, / });
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    await screen.findByRole("textbox", { name: "Campo real 2:" });
    fireEvent.click(toggle()!);
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].getAttribute("data-element-id")).toBe("vec-0-2");
  });
});

describe("las ocultas se conservan al editar la lista visible", () => {
  it("anadir un campo a mano con las sugerencias apagadas NO pierde las sugerencias", async () => {
    const seen: DetectedField[][] = [];
    render(<Harness initial={many(12)} onFields={(next) => seen.push(next)} />);
    await ready();
    expect(boxes()).toHaveLength(0);
    // Herramienta Texto + «Anadir campo en esta pagina».
    fireEvent.click(screen.getByRole("button", { name: strings.fieldTypeText }));
    fireEvent.click(screen.getByRole("button", { name: strings.addTextFieldHere }));
    const latest = seen[seen.length - 1];
    expect(latest).toHaveLength(13);
    expect(latest.filter((field) => field.source === "heuristic-vector")).toHaveLength(12);
  });

  it("«Quitar todo de esta pagina» solo quita lo visible", async () => {
    const seen: DetectedField[][] = [];
    render(<Harness initial={many(12)} onFields={(next) => seen.push(next)} />);
    await ready();
    fireEvent.click(toggle()!);
    fireEvent.click(toggle()!);
    // Sin nada visible no hay nada que quitar de la pagina.
    expect(screen.getByRole("button", { name: strings.clearPageAll }).hasAttribute("disabled")).toBe(true);
  });
});

describe("«Buscar huecos en paginas escaneadas»", () => {
  it("no aparece en una pagina con texto", async () => {
    render(<Harness initial={[]} />);
    await ready();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: strings.scanPageFields })).toBeNull();
  });

  it("aparece SOLO si la pagina no tiene texto y busca a peticion, no sola", async () => {
    page.hasText = false;
    render(<Harness initial={[]} />);
    const button = await screen.findByRole("button", { name: strings.scanPageFields });
    expect(detectRasterFields).not.toHaveBeenCalled();
    expect(button).toBeTruthy();
  });

  it("al pulsarla analiza ESA pagina, anade lo hallado como sugerencias y enciende el interruptor", async () => {
    page.hasText = false;
    const found: DetectedField = {
      id: "raster-0-0",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.5, width: 0.4, height: 0.03 },
      source: "heuristic-raster",
      confidence: "low",
    };
    vi.mocked(detectRasterFields).mockResolvedValue([found]);
    const seen: DetectedField[][] = [];
    render(<Harness initial={[]} onFields={(next) => seen.push(next)} />);
    fireEvent.click(await screen.findByRole("button", { name: strings.scanPageFields }));
    await waitFor(() => expect(detectRasterFields).toHaveBeenCalledWith(FILE, [0]));
    await waitFor(() => expect(seen[seen.length - 1]).toEqual([found]));
    await waitFor(() => expect(screen.getByText(strings.scanFound(1, 1))).toBeTruthy());
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    expect(boxes()).toHaveLength(1);
  });

  it("sin resultados lo dice, y un fallo tambien (sin romper nada)", async () => {
    page.hasText = false;
    render(<Harness initial={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: strings.scanPageFields }));
    await waitFor(() => expect(screen.getByText(strings.scanNone(1))).toBeTruthy());
    vi.mocked(detectRasterFields).mockRejectedValue(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: strings.scanPageFields }));
    await waitFor(() => expect(screen.getByText(strings.scanFailed)).toBeTruthy());
  });

  it("una busqueda repetida sustituye las sugerencias raster de esa pagina (no se acumulan)", async () => {
    page.hasText = false;
    const a: DetectedField = {
      id: "raster-0-0",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.5, width: 0.4, height: 0.03 },
      source: "heuristic-raster",
      confidence: "low",
    };
    vi.mocked(detectRasterFields).mockResolvedValue([a]);
    const seen: DetectedField[][] = [];
    render(<Harness initial={[]} onFields={(next) => seen.push(next)} />);
    fireEvent.click(await screen.findByRole("button", { name: strings.scanPageFields }));
    await waitFor(() => expect(seen.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: strings.scanPageFields }));
    await waitFor(() => expect(seen.length).toBe(2));
    expect(seen[1]).toHaveLength(1);
  });
});
