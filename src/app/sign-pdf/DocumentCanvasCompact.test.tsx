import { useState, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import {
  DocumentCanvas,
  type CanvasSelection,
  type PlacementTool,
  type SignTextEditConfig,
  type SoloConfig,
} from "@/app/sign-pdf/DocumentCanvas";
import { CanvasCompactContext } from "@/app/sign-pdf/canvasCompact";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { makeBlock, makeEdit } from "@/app/edit-pdf/editTestUtils";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";

/**
 * B1: el lienzo COMPACTO de PDF Pro (Firmar) en escritorio junta el dueno de la firma, el zoom y las paginas en UNA
 * barra y deja los contadores y «Borrar» debajo de la hoja: ~125 px mas de hoja visible a 1280x800. En movil y fuera
 * de PDF Pro, todo sigue como siempre (tarjeta aparte, contadores encima). Con pdf.js simulado.
 */

const analysis = vi.hoisted(() => ({ blocks: [] as unknown[] }));

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
    analyzeDocPageText: vi.fn(async (_doc: unknown, pageIndex: number) => ({
      blocks: (analysis.blocks as TextBlock[]).filter((block) => block.pageIndex === pageIndex),
      hasTextLayer: true,
      failed: false,
      hiddenCount: 0,
    })),
  };
});

const strings = SIGN_STRINGS.es;
const inline = EDIT_STRINGS.es.inline;
const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", { type: "application/pdf" });
const TITLE = makeBlock("p0-b0", { text: "Contrato", box: { x: 50, y: 740, width: 200, height: 18 }, fontSize: 16 });

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
});

beforeEach(() => {
  analysis.blocks = [TITLE];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Un telefono: `min-width: 768px` NO se cumple (PDF Pro usa paneles solo desde ahi). */
function stubMobile() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

function Harness({
  compact = true,
  solo,
  edits = [],
  withEdit = false,
}: {
  compact?: boolean;
  solo?: SoloConfig;
  edits?: TextEdit[];
  withEdit?: boolean;
}) {
  const [tool, setTool] = useState<PlacementTool>("select");
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [textEdits, setTextEdits] = useState<TextEdit[]>(edits);
  const config: SignTextEditConfig | undefined = withEdit
    ? { edits: textEdits, onEditsChange: setTextEdits, strings: inline }
    : undefined;
  const canvas: ReactNode = (
    <DocumentCanvas
      file={FILE}
      signers={[{ id: "sg-1", name: "Ana", color: "#0d4bff" }]}
      activeSignerId="sg-1"
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
      pinchZoomEnabled
      solo={solo}
      textEdit={config}
    />
  );
  return <CanvasCompactContext.Provider value={compact}>{canvas}</CanvasCompactContext.Provider>;
}

async function ready() {
  await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
}

const bar = () => document.querySelector<HTMLElement>("[data-canvas-sticky]")!;
const host = () => document.querySelector<HTMLElement>('[data-canvas="host"]')!;
const statusRow = () => document.querySelector<HTMLElement>("[data-canvas-status-row]")!;
const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const signerGroup = () => screen.getByRole("radiogroup", { name: strings.activeSignerLabel });

const SOLO_NO_SIGNATURE: SoloConfig = { signaturePng: "", ratio: 0, onCreateSignature: () => {}, onOpenSaved: () => {} };
const SOLO_WITH_SIGNATURE: SoloConfig = { signaturePng: "data:image/png;base64,AAAA", ratio: 0.4, onCreateSignature: () => {} };

describe("lienzo compacto en escritorio: una sola barra", () => {
  it("el dueno de los huecos va DENTRO de la barra de zoom y paginas, sin tarjeta aparte", async () => {
    render(<Harness />);
    await ready();
    expect(bar().contains(signerGroup())).toBe(true);
    expect(signerGroup().closest(".surface-card")).toBeNull();
    expect(bar().querySelector("[data-canvas-controls]")).not.toBeNull();
    // La barra sigue teniendo zoom y paginador.
    expect(within(bar()).getByRole("group", { name: strings.zoomGroupLabel })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: strings.nextPage })).toBeTruthy();
  });

  it("los contadores y «Borrar» van DEBAJO de la hoja", async () => {
    render(<Harness />);
    await ready();
    expect(follows(host(), statusRow())).toBe(true);
    expect(within(statusRow()).getByRole("button", { name: strings.clearPageAll })).toBeTruthy();
    expect(within(statusRow()).getByRole("button", { name: strings.clearAllAll })).toBeTruthy();
  });

  it("«Solo yo» sin firma: «Crear firma» y «Firmas guardadas» en la barra; la frase de ayuda queda para lectores de pantalla", async () => {
    render(<Harness solo={SOLO_NO_SIGNATURE} />);
    await ready();
    expect(within(bar()).getByRole("button", { name: strings.createSignature })).toBeTruthy();
    expect(within(bar()).getByRole("button", { name: strings.vaultButton })).toBeTruthy();
    const hint = screen.getByText(strings.noSignature);
    expect(hint.className).toContain("sr-only");
    expect(bar().contains(hint)).toBe(true);
  });

  it("«Solo yo» con firma: «Cambiar firma» en la barra", async () => {
    render(<Harness solo={SOLO_WITH_SIGNATURE} />);
    await ready();
    expect(within(bar()).getByRole("button", { name: strings.changeSignature })).toBeTruthy();
    expect(within(bar()).getByText(strings.soloSignatureLabel)).toBeTruthy();
  });

  it("no se pinta nada dos veces (ni dos grupos de firmantes ni dos filas de contadores)", async () => {
    render(<Harness />);
    await ready();
    expect(screen.getAllByRole("radiogroup", { name: strings.activeSignerLabel })).toHaveLength(1);
    expect(document.querySelectorAll("[data-canvas-status-row]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-canvas-sticky]")).toHaveLength(1);
  });

  it("la hoja pierde margen: el contenedor del lienzo es mas ajustado que en la herramienta suelta", async () => {
    render(<Harness />);
    await ready();
    expect(host().parentElement!.className).toContain("p-1.5");
    expect(host().parentElement!.className).not.toMatch(/(^|\s)p-3(\s|$)/);
    expect(bar().className).toContain("mb-1.5");
  });
});

describe("fuera del compacto o en movil: como siempre", () => {
  it("herramienta suelta (no compacto): tarjeta aparte con el dueno, contadores encima de la hoja", async () => {
    render(<Harness compact={false} />);
    await ready();
    expect(bar().contains(signerGroup())).toBe(false);
    expect(signerGroup().closest(".surface-card")).not.toBeNull();
    expect(bar().querySelector("[data-canvas-controls]")).toBeNull();
    expect(follows(statusRow(), host())).toBe(true);
    expect(host().parentElement!.className).toContain("p-3");
    expect(bar().className).toContain("mb-3");
  });

  it("compacto en movil (menos de 768 px): tambien tarjeta aparte y contadores encima", async () => {
    stubMobile();
    render(<Harness />);
    await ready();
    expect(bar().contains(signerGroup())).toBe(false);
    expect(signerGroup().closest(".surface-card")).not.toBeNull();
    expect(follows(statusRow(), host())).toBe(true);
  });

  it("«Solo yo» en movil: la frase de ayuda se ve (no es sr-only)", async () => {
    stubMobile();
    render(<Harness solo={SOLO_NO_SIGNATURE} />);
    await ready();
    expect(screen.getByText(strings.noSignature).className).not.toContain("sr-only");
  });
});

describe("la nota del texto original en el lienzo compacto", () => {
  const EDIT = makeEdit({ id: "e1", blockId: "p0-b0", text: "Hecho" });

  it("compacto: el panel de «Editar texto» NO repite la nota (la cabecera del modo la pliega con los demas avisos)", async () => {
    render(<Harness withEdit edits={[EDIT]} />);
    await ready();
    const panel = document.querySelector<HTMLElement>("[data-edit-text-panel]")!;
    expect(panel.textContent).toContain(strings.editTextCount(1));
    expect(panel.textContent).not.toContain(strings.editTextNote);
    expect(within(panel).queryByRole("link", { name: strings.editTextFlattenLink })).toBeNull();
  });

  it("herramienta suelta: la nota y el enlace siguen en el panel", async () => {
    render(<Harness compact={false} withEdit edits={[EDIT]} />);
    await ready();
    const panel = document.querySelector<HTMLElement>("[data-edit-text-panel]")!;
    expect(panel.textContent).toContain(strings.editTextNote);
    expect(within(panel).getByRole("link", { name: strings.editTextFlattenLink })).toBeTruthy();
  });
});
