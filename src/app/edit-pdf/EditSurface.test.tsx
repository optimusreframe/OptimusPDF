import { createRef, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { EditSurface, MAX_FIT_WIDTH_PX, type SurfaceHandle } from "@/app/edit-pdf/EditSurface";
import type { PageMetrics } from "@/app/edit-pdf/editCanvasMath";

type FakePage = {
  view: number[];
  rotate: number;
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  cancels: ReturnType<typeof vi.fn>[];
};

function fakePage(view = [0, 0, 400, 300], rotate = 0, fail: unknown = null): FakePage {
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const swapped = rotate === 90 || rotate === 270;
  const w = Math.abs(view[2] - view[0]);
  const h = Math.abs(view[3] - view[1]);
  const page: FakePage = {
    view,
    rotate,
    cancels,
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: (swapped ? h : w) * scale,
      height: (swapped ? w : h) * scale,
    })),
    render: vi.fn(() => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return { promise: fail ? Promise.reject(fail) : Promise.resolve(), cancel };
    }),
    cleanup: vi.fn(),
  };
  return page;
}

function fakeDoc(pages: FakePage[], failGetPage = false): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (n: number) => {
      if (failGetPage) throw new Error("boom");
      return pages[n - 1];
    }),
  } as unknown as PDFDocumentProxy;
}

const drawImage = vi.fn();
const getImageData = vi.fn((x: number, y: number, w: number, h: number) => {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  return { data, width: w, height: h };
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ drawImage, getImageData }) as unknown as CanvasRenderingContext2D,
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  drawImage.mockClear();
  getImageData.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — restaura el accesor de prueba
  delete HTMLElement.prototype.clientWidth;
});

type HarnessProps = {
  doc: PDFDocumentProxy | null;
  pageIndex?: number;
  zoom?: number;
  onMetrics?: (m: PageMetrics | null, page: number) => void;
  handleRef?: React.Ref<SurfaceHandle>;
};

function Harness({ doc, pageIndex = 0, zoom = 1, onMetrics = () => undefined, handleRef, onRendered }: HarnessProps & { onRendered?: (info: { pageIndex: number }) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  return (
    <EditSurface
      doc={doc}
      pageIndex={pageIndex}
      zoom={zoom}
      hostRef={host}
      clipRef={clip}
      handleRef={handleRef}
      onMetrics={onMetrics}
      onRendered={onRendered}
      loadingLabel="Preparando la página"
      stageLabel="Lienzo"
      hostProps={{ tabIndex: -1, "data-tool": "select" }}
    >
      <span data-testid="child">hijo</span>
    </EditSurface>
  );
}

const host = () => document.querySelector<HTMLElement>("[data-page-index]")!;

describe("EditSurface", () => {
  it("reporta las metricas de la pagina con /Rotate y un CropBox con origen no cero", async () => {
    const onMetrics = vi.fn();
    const doc = fakeDoc([fakePage([20, 10, 380, 290], 90)]);
    render(<Harness doc={doc} onMetrics={onMetrics} />);
    await waitFor(() => expect(onMetrics.mock.calls.some(([m]) => m !== null)).toBe(true));
    const [metrics, page] = onMetrics.mock.calls.find(([m]) => m !== null)!;
    expect(page).toBe(0);
    expect(metrics.geometry.rotation).toBe(90);
    expect(metrics.geometry.box).toEqual({ x: 20, y: 10, width: 360, height: 280 });
    expect(metrics.geometry.viewWidth).toBe(280);
    expect(metrics.cssWidth).toBe(600);
    expect(metrics.scale).toBeCloseTo(600 / 280, 6);
    expect(metrics.cssHeight).toBeCloseTo(360 * (600 / 280), 6);
  });

  it("la hoja mide el ancho disponible hasta un maximo y el zoom la agranda de verdad", async () => {
    const onMetrics = vi.fn();
    const doc = fakeDoc([fakePage()]);
    const { rerender } = render(<Harness doc={doc} onMetrics={onMetrics} zoom={1} />);
    await waitFor(() => expect(host().style.width).toBe("600px"));
    rerender(<Harness doc={doc} onMetrics={onMetrics} zoom={2} />);
    await waitFor(() => expect(host().style.width).toBe("1200px"));
  });

  it("el ancho de la hoja se limita aunque el contenedor sea enorme", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1500 });
    render(<Harness doc={fakeDoc([fakePage()])} zoom={1.25} />);
    await waitFor(() => expect(host().style.width).toBe(`${MAX_FIT_WIDTH_PX * 1.25}px`));
  });

  it("renderiza con la densidad de pixeles de la pantalla (no un JPEG de 900 px)", async () => {
    const page = fakePage([0, 0, 400, 300]);
    render(<Harness doc={fakeDoc([page])} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    // 600 px CSS x devicePixelRatio 2 / 400 pt = escala 3
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 3 });
    const args = page.render.mock.calls[0][0];
    expect(args.canvas.width).toBe(1200);
    expect(args.canvas.height).toBe(900);
    expect(args.intent).toBe("display");
    await waitFor(() => expect(drawImage).toHaveBeenCalled());
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
  });

  it("al hacer zoom vuelve a renderizar NITIDO (mas pixeles) y cancela el render anterior", async () => {
    const page = fakePage([0, 0, 400, 300]);
    const doc = fakeDoc([page]);
    const { rerender } = render(<Harness doc={doc} zoom={1} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    rerender(<Harness doc={doc} zoom={2} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(2));
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 6 });
    expect(page.render.mock.calls[1][0].canvas.width).toBe(2400);
    // El primero ya habia terminado; un tercer cambio cancela el segundo si sigue vivo.
    rerender(<Harness doc={doc} zoom={3} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(3));
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 9 });
  });

  it("un zoom a golpes se agrupa: renderiza una vez, no una por paso", async () => {
    const page = fakePage();
    const doc = fakeDoc([page]);
    const { rerender } = render(<Harness doc={doc} zoom={1} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    page.render.mockClear();
    rerender(<Harness doc={doc} zoom={1.25} />);
    rerender(<Harness doc={doc} zoom={1.5} />);
    rerender(<Harness doc={doc} zoom={2} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(page.render).toHaveBeenCalledTimes(1);
  });

  it("limita el area del canvas para no agotar la memoria", async () => {
    const page = fakePage([0, 0, 2000, 2000]);
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
    render(<Harness doc={fakeDoc([page])} zoom={3} />);
    await waitFor(() => expect(page.render).toHaveBeenCalled());
    const { canvas } = page.render.mock.calls[0][0];
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_001);
  });

  it("cambiar de pagina pide la pagina nueva y avisa de su geometria", async () => {
    const pages = [fakePage([0, 0, 400, 300]), fakePage([0, 0, 200, 100], 90)];
    const doc = fakeDoc(pages);
    const onMetrics = vi.fn();
    const { rerender } = render(<Harness doc={doc} pageIndex={0} onMetrics={onMetrics} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    rerender(<Harness doc={doc} pageIndex={1} onMetrics={onMetrics} />);
    await waitFor(() =>
      expect(onMetrics.mock.calls.some(([m, p]) => m?.geometry.rotation === 90 && p === 1)).toBe(true),
    );
    expect(doc.getPage).toHaveBeenCalledWith(2);
    expect(pages[0].cleanup).toHaveBeenCalled();
    // Durante el cambio las metricas viejas se retiran: la capa nunca se pinta con la geometria de otra pagina.
    expect(onMetrics.mock.calls.some(([m, p]) => m === null && p === -1)).toBe(true);
  });

  it("si la pagina no se puede leer marca el fallo sin lanzar", async () => {
    render(<Harness doc={fakeDoc([fakePage()], true)} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("failed"));
  });

  it("un fallo del render lo marca; una cancelacion no", async () => {
    const failing = fakePage([0, 0, 400, 300], 0, new Error("render roto"));
    const { unmount } = render(<Harness doc={fakeDoc([failing])} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("failed"));
    unmount();
    const cancelled = Object.assign(new Error("cancelado"), { name: "RenderingCancelledException" });
    render(<Harness doc={fakeDoc([fakePage([0, 0, 400, 300], 0, cancelled)])} />);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(host().getAttribute("data-render-state")).toBe("rendering");
  });

  it("sin documento no hay metricas ni render", async () => {
    const onMetrics = vi.fn();
    render(<Harness doc={null} onMetrics={onMetrics} />);
    await act(async () => undefined);
    expect(onMetrics.mock.calls.every(([m]) => m === null)).toBe(true);
    expect(host().getAttribute("data-render-state")).toBe("rendering");
  });

  it("avisa con onRendered cada vez que el canvas se repinta (para volver a muestrear el fondo)", async () => {
    const onRendered = vi.fn();
    const { rerender } = render(<Harness doc={fakeDoc([fakePage()])} onRendered={onRendered} />);
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(1));
    expect(onRendered).toHaveBeenCalledWith({ pageIndex: 0 });
    rerender(<Harness doc={fakeDoc([fakePage()])} zoom={2} onRendered={onRendered} />);
    await waitFor(() => expect(onRendered.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("mientras no esta lista muestra un indicador con nombre y despues lo quita", async () => {
    render(<Harness doc={fakeDoc([fakePage()])} />);
    expect(screen.getByRole("status", { name: "Preparando la página" })).toBeTruthy();
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("la hoja es un grupo con nombre, enfocable por programa, con los hijos dentro", async () => {
    render(<Harness doc={fakeDoc([fakePage()])} />);
    const el = host();
    expect(el.getAttribute("role")).toBe("group");
    expect(el.getAttribute("aria-label")).toBe("Lienzo");
    expect(el.tabIndex).toBe(-1);
    expect(el.getAttribute("data-tool")).toBe("select");
    expect(el.contains(screen.getByTestId("child"))).toBe(true);
    expect(el.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("sampleBackground convierte la caja de usuario a pixeles del canvas y lee solo esa ventana", async () => {
    const handle = createRef<SurfaceHandle>();
    const page = fakePage([0, 0, 400, 300]);
    render(<Harness doc={fakeDoc([page])} handleRef={handle} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    const sample = handle.current!.sampleBackground({ x: 40, y: 250, width: 100, height: 20 });
    expect(sample?.color).toBe("#ffffff");
    expect(getImageData).toHaveBeenCalledTimes(1);
    const [x, y, w, h] = getImageData.mock.calls[0];
    // Escala CSS 1,5 px/pt x relacion canvas/CSS 2 = 3 px del canvas por punto: la caja arranca en (120, 90).
    // Ventana = caja + (8 pt de busqueda de bordes x 3 px/pt + 2) px por lado: se mide en puntos, no en px.
    expect(x).toBe(120 - 26);
    expect(y).toBe(90 - 26);
    expect(w).toBe(300 + 52);
    expect(h).toBe(60 + 52);
  });

  it("una celda con borde: sampleBackground devuelve las franjas del borde (clip) en espacio de usuario y el fondo sale liso", async () => {
    const handle = createRef<SurfaceHandle>();
    render(<Harness doc={fakeDoc([fakePage([0, 0, 400, 300])])} handleRef={handle} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    // Ventana de lectura (352 x 112 px): la caja ocupa las filas 26..86; un borde de 1 pt (3 px) pegado debajo.
    getImageData.mockImplementationOnce((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4).fill(255);
      for (let row = 86; row < 89; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const o = (row * w + col) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
      return { data, width: w, height: h };
    });
    const sample = handle.current!.sampleBackground({ x: 40, y: 250, width: 100, height: 20 });
    expect(sample?.uniform).toBe(true);
    expect(sample?.color).toBe("#ffffff");
    // El borde esta justo bajo el borde inferior de la caja (y = 250 pt): su franja, con 0,5 pt de holgura.
    expect(sample?.clip).toBeDefined();
    const strip = sample!.clip![0];
    expect(strip.y).toBeLessThan(250);
    expect(strip.y + strip.height).toBeGreaterThan(249 - 1.6);
    expect(strip.width).toBeGreaterThan(100);
    expect(strip.height).toBeGreaterThan(1);
  });

  it("sampleBackground devuelve null antes del primer render", () => {
    const handle = createRef<SurfaceHandle>();
    render(<Harness doc={null} handleRef={handle} />);
    expect(handle.current!.sampleBackground({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });
});

/**
 * Wave 10 · C-A1: el contexto 2D del lienzo en que pdf.js dibuja la hoja lo crea la aplicacion, ANTES de `render` y NO
 * opaco. Si no existiera, pdf.js crearia el suyo con `{ alpha: false, willReadFrequently: true }` y Chromium en Linux
 * (fontconfig de Ubuntu) y en Windows (ClearType) dibujaria el texto con antialiasing LCD: franjas de color en el
 * lienzo, distinto al texto de Firmar (que ya crea su contexto no opaco, `pageRaster.test.ts`). Medido en Linux con
 * Docker: 46.577 pixeles con color a DPR 1 (maxima diferencia entre canales 151) frente a 0 con el lienzo no opaco. En
 * macOS no hay LCD, asi que solo esta prueba (y `e2e/specs/edit-quality.spec.ts` en Linux) lo detectan.
 */
describe("EditSurface · el contexto 2D de la hoja no es opaco (C-A1)", () => {
  type Attributes = { alpha?: boolean; willReadFrequently?: boolean } | undefined;

  function spyContexts() {
    return vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => ({ drawImage, getImageData }) as unknown as CanvasRenderingContext2D);
  }

  /** (lienzo, atributos, orden de llamada) de cada `getContext("2d", ...)`. */
  function contextCalls(spy: ReturnType<typeof spyContexts>) {
    return spy.mock.calls.map((args, index) => ({
      canvas: spy.mock.contexts[index] as HTMLCanvasElement,
      type: args[0] as string,
      attributes: args[1] as Attributes,
      order: spy.mock.invocationCallOrder[index],
    }));
  }

  it("el lienzo fuera de pantalla recibe su contexto 2D NO opaco ANTES de que pdf.js dibuje, con `willReadFrequently` como antes", async () => {
    const spy = spyContexts();
    const page = fakePage([0, 0, 400, 300]);
    render(<Harness doc={fakeDoc([page])} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    const { canvas } = page.render.mock.calls[0][0];
    const own = contextCalls(spy).filter((call) => call.canvas === canvas);
    expect(own.length, "el lienzo que se pasa a pdf.js ya tiene contexto propio").toBeGreaterThanOrEqual(1);
    expect(own[0].type).toBe("2d");
    // Explicito `true` (no basta con «no es false»): un lienzo no opaco es lo que garantiza el antialiasing en grises.
    expect(own[0].attributes?.alpha).toBe(true);
    // Lo que pdf.js ponia por su cuenta (la lectura de pixeles de la hoja la hace el muestreo de fondo): no se degrada.
    expect(own[0].attributes?.willReadFrequently).toBe(true);
    // Y antes de dibujar: despues de `render` ya seria tarde (pdf.js habria creado el suyo).
    expect(own[0].order).toBeLessThan(page.render.mock.invocationCallOrder[0]);
  });

  it("dibuja en ESE lienzo (con `intent: display`), lo copia al visible y ningun contexto de la superficie pide `alpha: false`", async () => {
    const spy = spyContexts();
    const handle = createRef<SurfaceHandle>();
    const page = fakePage([0, 0, 400, 300]);
    render(<Harness doc={fakeDoc([page])} handleRef={handle} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    // El muestreo de fondo tambien pide el contexto del lienzo visible.
    handle.current!.sampleBackground({ x: 40, y: 250, width: 100, height: 20 });
    const { canvas, intent } = page.render.mock.calls[0][0];
    expect(intent).toBe("display");
    const visible = document.querySelector<HTMLCanvasElement>("[data-edit-canvas]")!;
    expect(visible).not.toBe(canvas);
    const calls = contextCalls(spy);
    const visibleCalls = calls.filter((call) => call.canvas === visible);
    expect(visibleCalls.length).toBeGreaterThanOrEqual(2); // al copiar el render y al muestrear
    for (const call of calls) {
      expect(call.type).toBe("2d");
      expect(call.attributes?.alpha, "ningun contexto de la superficie es opaco").not.toBe(false);
    }
    for (const call of visibleCalls) expect(call.attributes?.alpha).toBe(true);
    expect(drawImage).toHaveBeenCalledWith(canvas, 0, 0);
  });

  it("cada render nuevo (zoom) crea otra vez el contexto no opaco del lienzo nuevo antes de dibujar", async () => {
    const spy = spyContexts();
    const page = fakePage([0, 0, 400, 300]);
    const doc = fakeDoc([page]);
    const { rerender } = render(<Harness doc={doc} zoom={1} />);
    await waitFor(() => expect(host().getAttribute("data-render-state")).toBe("ready"));
    rerender(<Harness doc={doc} zoom={2} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(2));
    const calls = contextCalls(spy);
    for (const [index, [params]] of page.render.mock.calls.entries()) {
      const own = calls.filter((call) => call.canvas === params.canvas);
      expect(own[0]?.attributes?.alpha, `render ${index + 1}`).toBe(true);
      expect(own[0].order).toBeLessThan(page.render.mock.invocationCallOrder[index]);
    }
    expect(page.render.mock.calls[0][0].canvas).not.toBe(page.render.mock.calls[1][0].canvas);
  });
});
