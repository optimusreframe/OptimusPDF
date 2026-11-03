import { createRef, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CANVAS_REVEAL_EVENT,
  DocumentCanvas,
  type CanvasSelection,
  type DocumentCanvasApi,
  type GestureMode,
  type PlacementTool,
} from "@/app/sign-pdf/DocumentCanvas";
import { FINGER_DRAW_PREF_KEY } from "@/app/sign-pdf/canvasGestures";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";

/**
 * M3 · API imperativa del lienzo (`apiRef`) para los duenos de Firmar y Pro: «ver este hueco»
 * (`scrollIntoViewRect`), la zona libre (`getFreeRegion`) y el modo de gesto (`getGestureMode`).
 * jsdom no hace layout: el rectangulo de cada elemento y el scroller del documento se simulan.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {}, getViewport: () => ({ width: 600, height: 800 }) }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

const strings = SIGN_STRINGS.es;
const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", { type: "application/pdf" });

const originalRect = Element.prototype.getBoundingClientRect;
const scrollState = { top: 0 };
let originalScrollTop: PropertyDescriptor | undefined;

beforeAll(() => {
  // Hoja de 600 x 800 en (0, 0); `window` de 1024 x 768 (jsdom).
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const sheet = this instanceof HTMLElement && this.dataset.canvas === "host";
    // La hoja se mueve con el scroll del documento (la parte alta sale por arriba).
    const top = sheet ? -scrollState.top : 0;
    return { width: 600, height: 800, top, left: 0, right: 600, bottom: top + 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(document.documentElement, "scrollTop", {
    configurable: true,
    get: () => scrollState.top,
    set: (value: number) => {
      scrollState.top = Math.max(0, Math.min(value, 5000));
    },
  });
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  if (originalScrollTop) Object.defineProperty(Element.prototype, "scrollTop", originalScrollTop);
  delete (document.documentElement as { scrollTop?: number }).scrollTop;
});

function Harness({
  apiRef,
  gestureMode,
  onPage,
}: {
  apiRef: React.RefObject<DocumentCanvasApi | null>;
  gestureMode?: GestureMode;
  onPage?: (index: number) => void;
}) {
  const [tool, setTool] = useState<PlacementTool>("select");
  const [slots, setSlots] = useState<SignatureField[]>([]);
  const [textFields, setTextFields] = useState<DetectedField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <DocumentCanvas
      file={FILE}
      signers={[ANA]}
      activeSignerId={ANA.id}
      onActiveSignerIdChange={() => {}}
      tool={tool}
      onToolChange={setTool}
      slots={slots}
      onSlotsChange={setSlots}
      textFields={textFields}
      onTextFieldsChange={setTextFields}
      values={values}
      onValueChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
      pageIndex={pageIndex}
      onPageIndexChange={(index) => {
        setPageIndex(index);
        onPage?.(index);
      }}
      selection={selection}
      onSelectionChange={setSelection}
      editingId={editingId}
      onEditingIdChange={setEditingId}
      strings={strings}
      pinchZoomEnabled
      apiRef={apiRef}
      gestureMode={gestureMode}
    />
  );
}

async function ready() {
  await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
}

describe("DocumentCanvasApi", () => {
  it("expone el modo de gesto: `draw` por defecto («Un dedo dibuja» encendido), `auto` con el interruptor apagado y el de la prop si la hay", async () => {
    const apiRef = createRef<DocumentCanvasApi>();
    window.localStorage.removeItem(FINGER_DRAW_PREF_KEY);
    try {
      // Sin prop manda el interruptor, encendido de fabrica (W3-A3): el dedo dibuja.
      const first = render(<Harness apiRef={apiRef} />);
      await ready();
      expect(apiRef.current?.getGestureMode()).toBe("draw");
      first.unmount();
      // Interruptor apagado (preferencia recordada): el modo de antes.
      window.localStorage.setItem(FINGER_DRAW_PREF_KEY, "0");
      const off = render(<Harness apiRef={apiRef} />);
      await ready();
      expect(apiRef.current?.getGestureMode()).toBe("auto");
      off.unmount();
      // Con la prop manda la prop, sea cual sea la preferencia.
      const second = render(<Harness apiRef={apiRef} gestureMode="draw" />);
      await ready();
      expect(apiRef.current?.getGestureMode()).toBe("draw");
      second.unmount();
      const third = render(<Harness apiRef={apiRef} gestureMode="scroll" />);
      await ready();
      expect(apiRef.current?.getGestureMode()).toBe("scroll");
      third.unmount();
    } finally {
      window.localStorage.removeItem(FINGER_DRAW_PREF_KEY);
    }
  });

  it("getFreeRegion devuelve una caja finita dentro de la ventana", async () => {
    const apiRef = createRef<DocumentCanvasApi>();
    render(<Harness apiRef={apiRef} />);
    await ready();
    const region = apiRef.current!.getFreeRegion();
    expect(region.top).toBeGreaterThanOrEqual(0);
    expect(region.bottom).toBeGreaterThan(region.top);
    expect(region.right).toBeGreaterThan(region.left);
    expect(Number.isFinite(region.bottom)).toBe(true);
  });

  it("scrollIntoViewRect desplaza la pagina para centrar el hueco en la zona libre", async () => {
    const apiRef = createRef<DocumentCanvasApi>();
    render(<Harness apiRef={apiRef} />);
    await ready();
    scrollState.top = 0;
    // Hueco en el pie de la hoja (y = 720..760 de 800): fuera de la ventana de 768 px de alto, casi.
    const done = apiRef.current!.scrollIntoViewRect({ x: 0.3, y: 0.9, width: 0.3, height: 0.05 });
    expect(done).toBe(true);
    // Centro del hueco (740) -> centro de la zona libre menos margen (384): ~356 px.
    expect(scrollState.top).toBeGreaterThan(300);
    expect(scrollState.top).toBeLessThan(420);
  });

  it("el evento de window hace lo mismo que la API (sin `ref`)", async () => {
    const apiRef = createRef<DocumentCanvasApi>();
    render(<Harness apiRef={apiRef} />);
    await ready();
    scrollState.top = 0;
    act(() => {
      window.dispatchEvent(new CustomEvent(CANVAS_REVEAL_EVENT, { detail: { rect: { x: 0.3, y: 0.9, width: 0.3, height: 0.05 } } }));
    });
    expect(scrollState.top).toBeGreaterThan(300);
  });

  it("pedir un hueco de otra pagina cambia de pagina y lo atiende al pintarla", async () => {
    const apiRef = createRef<DocumentCanvasApi>();
    const onPage = vi.fn();
    render(<Harness apiRef={apiRef} onPage={onPage} />);
    await ready();
    scrollState.top = 0;
    const done = apiRef.current!.scrollIntoViewRect({ x: 0.3, y: 0.9, width: 0.3, height: 0.05 }, { pageIndex: 1 });
    expect(done).toBe(true);
    await waitFor(() => expect(onPage).toHaveBeenCalledWith(1));
    await waitFor(() => expect(scrollState.top).toBeGreaterThan(300));
  });
});
