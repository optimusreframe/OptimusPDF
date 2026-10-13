import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DocumentCanvas,
  type CanvasSelection,
  type PlacementTool,
  type SignTextEditConfig,
} from "@/app/sign-pdf/DocumentCanvas";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { makeBlock, makeEdit } from "@/app/edit-pdf/editTestUtils";
import { analyzeDocPageText } from "@/lib/pdf/textBlocks";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";
import type { SignatureField } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";

/**
 * Herramienta «Editar texto» dentro del lienzo de Firmar (W6-A): la capa de
 * bloques de Editar PDF montada sobre la MISMA imagen, como un modo del lienzo.
 * Con pdf.js simulado (pagina de 600 x 800 pt, 1 px por punto) y el analisis de
 * texto sustituido por bloques de prueba.
 */

const analysis = vi.hoisted(() => ({
  current: null as null | { blocks: unknown[]; hasTextLayer: boolean; failed: boolean; hiddenCount: number },
  delay: false,
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({
        cleanup: () => {},
        view: [0, 0, 600, 800],
        rotate: 0,
        getViewport: () => ({ width: 600, height: 800 }),
      }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});
vi.mock("@/lib/pdf/textBlocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/textBlocks")>();
  return {
    ...actual,
    analyzeDocPageText: vi.fn(async (_doc: unknown, pageIndex: number) => {
      if (analysis.delay) await new Promise((resolve) => setTimeout(resolve, 150));
      const base = analysis.current!;
      return {
        ...base,
        blocks: (base.blocks as TextBlock[]).filter((block) => block.pageIndex === pageIndex),
      };
    }),
  };
});

const strings = SIGN_STRINGS.es;
const inline = EDIT_STRINGS.es.inline;

const TITLE = makeBlock("p0-b0", { text: "Contrato de servicios", box: { x: 50, y: 740, width: 200, height: 18 }, fontSize: 16 });
const CLAUSE = makeBlock("p0-b1", { text: "Clausula primera", box: { x: 50, y: 700, width: 160, height: 14 } });
const OTHER_PAGE = makeBlock("p1-b0", { text: "Anexo", pageIndex: 1, box: { x: 50, y: 700, width: 80, height: 14 } });

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  // jsdom no maqueta: la hoja necesita un ancho de layout para medir la pagina.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
});

beforeEach(() => {
  vi.mocked(analyzeDocPageText).mockClear();
  analysis.delay = false;
  analysis.current = { blocks: [TITLE, CLAUSE, OTHER_PAGE], hasTextLayer: true, failed: false, hiddenCount: 0 };
});

const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", { type: "application/pdf" });

const SLOT: SignatureField = {
  id: "s1",
  signerId: "sg-1",
  pageIndex: 0,
  type: "signature",
  rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.1 },
};

type HarnessProps = {
  withEdit?: boolean;
  initialEdits?: TextEdit[];
  onEdits?: (edits: TextEdit[]) => void;
  initialTool?: PlacementTool;
  textFields?: DetectedField[];
  slots?: SignatureField[];
  onToolChange?: (tool: PlacementTool) => void;
  externalEdits?: TextEdit[];
};

function Harness({
  withEdit = true,
  initialEdits = [],
  onEdits,
  initialTool = "select",
  slots = [],
  onToolChange,
  externalEdits,
}: HarnessProps) {
  const [tool, setTool] = useState<PlacementTool>(initialTool);
  const [edits, setEdits] = useState<TextEdit[]>(initialEdits);
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const config: SignTextEditConfig | undefined = withEdit
    ? {
        edits: externalEdits ?? edits,
        onEditsChange: (next) => {
          setEdits(next);
          onEdits?.(next);
        },
        strings: inline,
      }
    : undefined;
  return (
    <DocumentCanvas
      file={FILE}
      signers={[{ id: "sg-1", name: "Ana", color: "#0d4bff" }]}
      activeSignerId="sg-1"
      onActiveSignerIdChange={() => {}}
      tool={tool}
      onToolChange={(next) => {
        setTool(next);
        onToolChange?.(next);
      }}
      slots={slots}
      onSlotsChange={() => {}}
      textFields={[]}
      onTextFieldsChange={() => {}}
      values={{}}
      onValueChange={() => {}}
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selection={selection}
      onSelectionChange={setSelection}
      editingId={editingId}
      onEditingIdChange={setEditingId}
      strings={strings}
      textEdit={config}
    />
  );
}

const palette = () => screen.getByRole("toolbar", { name: strings.paletteLabel });
const editButton = () => within(palette()).queryByRole("button", { name: strings.toolEditText });
async function ready() {
  await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
}
async function activate() {
  await ready();
  fireEvent.click(editButton()!);
  await waitFor(() => expect(document.querySelector('[data-block-layer] [data-element-id="p0-b0"]')).toBeTruthy());
}
const block = (id: string) => document.querySelector<HTMLElement>(`[data-block-layer] [data-element-id="${id}"][data-drag-mode="move"]`)!;
const layer = () => document.querySelector<HTMLElement>("[data-edit-text-layer]")!;

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  fireEvent.input(editor);
}

describe("la herramienta en la paleta", () => {
  it("sin configuracion (ajuste apagado) NO existe en la paleta ni hay capa", async () => {
    render(<Harness withEdit={false} />);
    await ready();
    expect(editButton()).toBeNull();
    expect(layer()).toBeNull();
    // El resto de la paleta sigue igual.
    expect(within(palette()).getByRole("button", { name: strings.toolSelect })).toBeTruthy();
  });

  it("con configuracion aparece con su atajo E y se activa con el clic y con la tecla E", async () => {
    render(<Harness />);
    await ready();
    const button = editButton()!;
    expect(button.getAttribute("aria-keyshortcuts")).toBe("E");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(editButton()!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(editButton()!);
    expect(editButton()!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(document.body, { key: "e" });
    expect(editButton()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("activarla muestra la pista de uso y anuncia el cambio de herramienta", async () => {
    render(<Harness />);
    await activate();
    expect(screen.getByText(strings.editTextHint)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(strings.toolArmedStatus(strings.toolEditText))).toBeTruthy());
  });

  it("una sola region viva (`role=status`) para los anuncios del lienzo, tambien en este modo", async () => {
    render(<Harness />);
    await activate();
    expect(document.querySelectorAll("[data-canvas-announcer]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-block-live]")).toHaveLength(0);
  });
});

describe("los bloques del texto original", () => {
  it("con la herramienta activa cada bloque de la pagina es una region accesible con su texto", async () => {
    render(<Harness />);
    await activate();
    expect(block("p0-b0").getAttribute("aria-label")).toContain("Contrato de servicios");
    expect(block("p0-b1").getAttribute("aria-label")).toContain("Clausula primera");
    // Solo los de la pagina visible.
    expect(document.querySelector('[data-element-id="p1-b0"]')).toBeNull();
  });

  it("fuera de la herramienta no se analiza ni se pintan bloques (cero coste en el flujo de siempre)", async () => {
    render(<Harness />);
    await ready();
    await act(async () => {});
    expect(analyzeDocPageText).not.toHaveBeenCalled();
    expect(document.querySelector("[data-block-layer] [data-element-id]")).toBeNull();
  });

  it("mientras analiza lo dice; una pagina escaneada o un fallo tambien", async () => {
    analysis.delay = true;
    const { unmount } = render(<Harness />);
    await ready();
    fireEvent.click(editButton()!);
    expect((await screen.findByText(inline.analyzing)).closest("[data-edit-text-status]")).toBeTruthy();
    unmount();
    analysis.delay = false;
    analysis.current = { blocks: [], hasTextLayer: false, failed: false, hiddenCount: 0 };
    render(<Harness />);
    await ready();
    fireEvent.click(editButton()!);
    expect(await screen.findByText(inline.scanned)).toBeTruthy();
  });

  it("un fallo del analisis se avisa con amabilidad", async () => {
    analysis.current = { blocks: [], hasTextLayer: false, failed: true, hiddenCount: 0 };
    render(<Harness />);
    await ready();
    fireEvent.click(editButton()!);
    expect(await screen.findByText(inline.analysisFailed)).toBeTruthy();
  });

  it("los bloques que no se pueden editar se cuentan", async () => {
    analysis.current = {
      blocks: [TITLE, { ...CLAUSE, editable: false, readOnlyReason: "no-unicode" }],
      hasTextLayer: true,
      failed: false,
      hiddenCount: 0,
    };
    render(<Harness />);
    await activate();
    expect(await screen.findByText(inline.nonEditableCount(1))).toBeTruthy();
  });
});

describe("editar un texto", () => {
  it("Intro sobre un bloque abre el editor en el sitio y teclear crea UNA edicion que reemplaza el bloque", async () => {
    const seen: TextEdit[][] = [];
    render(<Harness onEdits={(edits) => seen.push(edits)} />);
    await activate();
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    const editor = await screen.findByRole("textbox", { name: inline.editorLabel });
    expect((editor as HTMLElement).textContent).toBe("Clausula primera");
    typeInto(editor, "Clausula segunda");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const edit = seen[seen.length - 1][0];
    expect(edit.blockId).toBe("p0-b1");
    expect(edit.text).toBe("Clausula segunda");
    expect(edit.pageIndex).toBe(0);
    expect(seen[seen.length - 1]).toHaveLength(1);
  });

  it("abrir y cerrar sin cambiar nada NO crea ediciones (un bloque sin tocar no ensucia el documento)", async () => {
    const seen: TextEdit[][] = [];
    render(<Harness onEdits={(edits) => seen.push(edits)} />);
    await activate();
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    const editor = await screen.findByRole("textbox", { name: inline.editorLabel });
    typeInto(editor, "Clausula primera");
    fireEvent.keyDown(editor, { key: "Escape" });
    await act(async () => {});
    expect(seen).toEqual([]);
  });

  it("doble clic en un bloque lo edita", async () => {
    render(<Harness />);
    await activate();
    const target = block("p0-b0");
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    expect(await screen.findByRole("textbox", { name: inline.editorLabel })).toBeTruthy();
  });

  it("teclear una letra con un bloque enfocado EDITA ese bloque y NO cambia de herramienta", async () => {
    const tools: PlacementTool[] = [];
    render(<Harness onToolChange={(tool) => tools.push(tool)} />);
    await activate();
    tools.length = 0;
    block("p0-b1").focus();
    fireEvent.keyDown(block("p0-b1"), { key: "t" });
    expect(await screen.findByRole("textbox", { name: inline.editorLabel })).toBeTruthy();
    expect(tools).toEqual([]);
    expect(editButton()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("Supr sobre un bloque lo borra: la edicion lo deja vacio (cubre el original y no redibuja)", async () => {
    const seen: TextEdit[][] = [];
    render(<Harness onEdits={(edits) => seen.push(edits)} />);
    await activate();
    fireEvent.keyDown(block("p0-b1"), { key: "Delete" });
    // Bajo carga el efecto puede emitir la lista mas de una vez entre dos
    // sondeos de waitFor: lo que importa es que NINGUNA emision contradiga el
    // borrado (todas dejan el bloque vacio) y que haya al menos una.
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    for (const edits of seen) {
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ blockId: "p0-b1", text: "" });
    }
  });

  it("el original se cubre con un color muestreado de la pagina (blanco si no hay imagen que leer)", async () => {
    const seen: TextEdit[][] = [];
    render(<Harness onEdits={(edits) => seen.push(edits)} />);
    await activate();
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    typeInto(await screen.findByRole("textbox", { name: inline.editorLabel }), "Otra");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[seen.length - 1][0].cover.color).toBe("#ffffff");
  });
});

describe("deshacer y rehacer", () => {
  async function withOneEdit() {
    const seen: TextEdit[][] = [];
    render(<Harness onEdits={(edits) => seen.push(edits)} />);
    await activate();
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    const editor = await screen.findByRole("textbox", { name: inline.editorLabel });
    typeInto(editor, "Cambiado");
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: inline.editorLabel })).toBeNull());
    return seen;
  }

  it("el boton Deshacer quita el cambio y Rehacer lo repone", async () => {
    const seen = await withOneEdit();
    const undo = screen.getByRole("button", { name: strings.editTextUndo });
    const redo = screen.getByRole("button", { name: strings.editTextRedo });
    expect(undo.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(undo);
    await waitFor(() => expect(seen[seen.length - 1]).toEqual([]));
    expect(screen.getByRole("button", { name: strings.editTextRedo }).getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(redo);
    await waitFor(() => expect(seen[seen.length - 1][0].text).toBe("Cambiado"));
  });

  it("Ctrl+Z / Ctrl+Mayus+Z con la herramienta activa", async () => {
    const seen = await withOneEdit();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(seen[seen.length - 1]).toEqual([]));
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(seen[seen.length - 1][0].text).toBe("Cambiado"));
  });

  it("sin cambios Deshacer esta deshabilitado (aria-disabled, no `disabled`: el foco no cae a <body>)", async () => {
    render(<Harness />);
    await activate();
    const undo = screen.getByRole("button", { name: strings.editTextUndo });
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.hasAttribute("disabled")).toBe(false);
  });

  it("fuera de la herramienta Ctrl+Z no toca las ediciones (el lienzo de siempre no tiene deshacer global)", async () => {
    const seen = await withOneEdit();
    fireEvent.click(editButton()!); // vuelve a Seleccionar
    const before = seen.length;
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await act(async () => {});
    expect(seen.length).toBe(before);
  });
});

describe("convive con los huecos y el flujo de firma", () => {
  it("con la herramienta activa los huecos se ven pero no reciben puntero", async () => {
    render(<Harness slots={[SLOT]} />);
    await activate();
    const host = document.querySelector('[data-canvas="host"]')!;
    expect(host.className).toContain("[&_.sign-field-box]:pointer-events-none");
    expect(document.querySelector('[data-element-kind="slot"]')).toBeTruthy();
    fireEvent.click(editButton()!);
    expect(host.className).not.toContain("[&_.sign-field-box]:pointer-events-none");
  });

  it("al volver a Seleccionar las ediciones siguen pintadas (el PDF se ve como quedara) y la capa es inerte", async () => {
    render(<Harness initialEdits={[makeEdit({ id: "e1", blockId: "p0-b1", text: "Editado a mano", box: CLAUSE.box })]} />);
    await ready();
    const host = layer();
    expect(host).toBeTruthy();
    expect(host.hasAttribute("inert")).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector('[data-text-view="p0-b1"]')?.textContent).toContain("Editado a mano");
  });

  it("con la herramienta activa la capa deja de ser inerte", async () => {
    render(<Harness initialEdits={[makeEdit({ id: "e1", blockId: "p0-b1", text: "Editado a mano", box: CLAUSE.box })]} />);
    await activate();
    expect(layer().hasAttribute("inert")).toBe(false);
    expect(layer().getAttribute("aria-hidden")).toBeNull();
  });

  it("Esc con el foco en un bloque suelta el bloque pero NO deja la herramienta; Esc ya fuera de la capa la deja", async () => {
    const tools: PlacementTool[] = [];
    render(<Harness onToolChange={(tool) => tools.push(tool)} />);
    await activate();
    tools.length = 0;
    block("p0-b0").focus();
    fireEvent.keyDown(block("p0-b0"), { key: "Escape" });
    expect(tools).toEqual([]);
    (document.querySelector('[data-canvas="host"]') as HTMLElement).focus();
    fireEvent.keyDown(document.querySelector('[data-canvas="host"]')!, { key: "Escape" });
    expect(tools).toEqual(["select"]);
  });

  it("cambiar de pagina suelta el foco de texto y muestra los bloques de la nueva pagina", async () => {
    render(<Harness />);
    await activate();
    fireEvent.keyDown(block("p0-b0"), { key: "Enter" });
    await screen.findByRole("textbox", { name: inline.editorLabel });
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    await waitFor(() => expect(document.querySelector('[data-block-layer] [data-element-id="p1-b0"]')).toBeTruthy());
    expect(screen.queryByRole("textbox", { name: inline.editorLabel })).toBeNull();
    expect(document.querySelector('[data-element-id="p0-b0"]')).toBeNull();
  });
});

describe("el aviso y el recuento", () => {
  it("sin ediciones y fuera de la herramienta no hay panel", async () => {
    render(<Harness />);
    await ready();
    expect(document.querySelector("[data-edit-text-panel]")).toBeNull();
  });

  it("con ediciones fuera de la herramienta: recuento, nota de que al firmar se quita el original (salvo casos especiales) y enlace a Editar PDF", async () => {
    render(
      <Harness
        initialEdits={[
          makeEdit({ id: "e1", blockId: "p0-b1", text: "Uno" }),
          makeEdit({ id: "e2", blockId: "p0-b0", text: "Dos", pageIndex: 1 }),
        ]}
      />,
    );
    await ready();
    const panel = document.querySelector<HTMLElement>("[data-edit-text-panel]")!;
    expect(panel.textContent).toContain(strings.editTextCount(2));
    expect(panel.textContent).toContain(strings.editTextNote);
    // La nota ya no dice que el original «puede seguir existiendo» sin mas: dice que se elimina y cuando no.
    expect(strings.editTextNote).toMatch(/se elimina del archivo/);
    expect(strings.editTextNote).toMatch(/casos especiales/);
    expect(strings.editTextNote).toMatch(/Aplanar página/);
    expect(strings.editTextNote).not.toMatch(/puede seguir existiendo|se dibuja sobre el original/);
    const en = SIGN_STRINGS.en.editTextNote;
    expect(en).toMatch(/is removed from the file/);
    expect(en).toMatch(/special cases/);
    expect(en).toMatch(/Flatten page/);
    expect(en).not.toMatch(/may still exist|drawn over the original/);
    const link = within(panel).getByRole("link", { name: strings.editTextFlattenLink });
    expect(link.getAttribute("href")).toBe("/edit-pdf");
  });

  it("un texto propio vacio no cuenta como edicion", async () => {
    render(<Harness initialEdits={[makeEdit({ id: "e1", text: "  " })]} />);
    await ready();
    expect(document.querySelector("[data-edit-text-panel]")).toBeNull();
  });
});

/**
 * Regresion (probe a 0 ms): el documento devuelve las ediciones con RETRASO. Si se teclea
 * rapido, cuando llega el eco de la lista N la sesion ya va por la N+1; tratarlo como un
 * cambio externo recargaba la sesion con el texto viejo y se perdia una letra
 * («Rcibo» en vez de «Recibo»). Aqui el padre aplica los ecos en una cola que el test vacia
 * DESPUES de teclear, en orden.
 */
function LaggyHarness({ queue, onFlushReady }: { queue: Array<() => void>; onFlushReady: (flush: (count?: number) => Promise<void>) => void }) {
  const [edits, setEdits] = useState<TextEdit[]>([]);
  const [tool, setTool] = useState<PlacementTool>("editText");
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Cada eco en su PROPIO render (como en el navegador): en un solo `act` React los fundiria y no se vería la carrera.
  onFlushReady(async (count = queue.length) => {
    for (const apply of queue.splice(0, count)) await act(async () => apply());
  });
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
      textFields={[]}
      onTextFieldsChange={() => {}}
      values={{}}
      onValueChange={() => {}}
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selection={selection}
      onSelectionChange={setSelection}
      editingId={editingId}
      onEditingIdChange={setEditingId}
      strings={strings}
      textEdit={{
        edits,
        onEditsChange: (next) => queue.push(() => setEdits(next)),
        strings: inline,
      }}
    />
  );
}

describe("teclear rapido: ningun eco tardio del documento pierde una letra", () => {
  it("los ecos de las listas N llegan DESPUES de teclear la N+1: el editor conserva todo lo tecleado", async () => {
    const queue: Array<() => void> = [];
    let flush: (count?: number) => Promise<void> = async () => {};
    render(<LaggyHarness queue={queue} onFlushReady={(fn) => (flush = fn)} />);
    await ready();
    await waitFor(() => expect(document.querySelector('[data-block-layer] [data-element-id="p0-b1"]')).toBeTruthy());
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    const editor = (await screen.findByRole("textbox", { name: inline.editorLabel })) as HTMLElement;
    typeInto(editor, "R");
    typeInto(editor, "Re");
    expect(queue.length).toBe(2);
    // Llega SOLO el eco de «R» cuando la sesion ya va por «Re»: la 2.a tecla no se pierde.
    await flush(1);
    expect(editor.textContent).toBe("Re");
    typeInto(editor, "Rec");
    await flush(1);
    expect(editor.textContent).toBe("Rec");
    await flush();
    expect(editor.textContent).toBe("Rec");
    typeInto(editor, "Reci");
    await flush();
    expect(editor.textContent).toBe("Reci");
  });

  it("tras vaciar los ecos el documento tiene la ULTIMA lista (nada se pierde ni se duplica)", async () => {
    const queue: Array<() => void> = [];
    let flush: (count?: number) => Promise<void> = async () => {};
    const { container } = render(<LaggyHarness queue={queue} onFlushReady={(fn) => (flush = fn)} />);
    await ready();
    await waitFor(() => expect(document.querySelector('[data-block-layer] [data-element-id="p0-b1"]')).toBeTruthy());
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    const editor = (await screen.findByRole("textbox", { name: inline.editorLabel })) as HTMLElement;
    for (const text of ["C", "Cl", "Cla", "Clau"]) typeInto(editor, text);
    await flush();
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: inline.editorLabel })).toBeNull());
    expect(container.querySelector('[data-text-view="p0-b1"]')?.textContent).toBe("Clau");
    expect(document.querySelectorAll('[data-text-view="p0-b1"]')).toHaveLength(1);
  });

  it("un cambio EXTERNO real (borrador restaurado) sigue recargando la sesion aunque haya ecos pendientes", async () => {
    const edit = makeEdit({ id: "ext", blockId: "p0-b1", text: "Desde borrador", box: CLAUSE.box });
    const { rerender } = render(<Harness externalEdits={[]} />);
    await ready();
    fireEvent.click(editButton()!);
    rerender(<Harness externalEdits={[edit]} />);
    await waitFor(() => expect(layer().querySelector('[data-text-view="p0-b1"]')?.textContent).toContain("Desde borrador"));
  });
});

describe("ediciones que cambian desde fuera", () => {
  it("un borrador restaurado (ediciones nuevas desde fuera) recarga la sesion y se pinta", async () => {
    const edit = makeEdit({ id: "e1", blockId: "p0-b1", text: "Restaurado", box: CLAUSE.box });
    const { rerender } = render(<Harness externalEdits={[]} />);
    await ready();
    expect(layer().querySelector('[data-text-view="p0-b1"]')).toBeNull();
    rerender(<Harness externalEdits={[edit]} />);
    await waitFor(() => expect(layer().querySelector('[data-text-view="p0-b1"]')?.textContent).toContain("Restaurado"));
  });

  it("no hay bucle: entregar las ediciones y recibirlas de vuelta no vuelve a entregarlas", async () => {
    const onEdits = vi.fn();
    render(<Harness onEdits={onEdits} />);
    await activate();
    fireEvent.keyDown(block("p0-b1"), { key: "Enter" });
    typeInto(await screen.findByRole("textbox", { name: inline.editorLabel }), "Una vez");
    await waitFor(() => expect(onEdits).toHaveBeenCalled());
    const calls = onEdits.mock.calls.length;
    await act(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onEdits.mock.calls.length).toBe(calls);
  });
});
