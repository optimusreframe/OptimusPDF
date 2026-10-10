import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { usePageImage, RERENDER_DEBOUNCE_MS, type PageImageParams } from "@/app/sign-pdf/usePageImage";

/**
 * Imagen nitida de la pagina (W6-A) con un pdf.js simulado: lo que se comprueba es
 * a que tamano se pide el render (DPR y zoom), que un render obsoleto se cancela,
 * que la cache evita repetir trabajo, que el respaldo de baja resolucion entra
 * cuando no hay motor y que las URL se liberan.
 */

type RenderCall = { scale: number; canvasWidth: number; cancelled: boolean; resolve: () => void };
const pdf = vi.hoisted(() => ({
  renders: [] as Array<{ scale: number; canvasWidth: number; cancelled: boolean; resolve: () => void }>,
  hold: false,
  hasRender: true,
  hasText: true,
  pageOpens: [] as number[],
  fallbackScales: [] as number[],
  openFails: false,
  fallbackFails: false,
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => {
      if (pdf.openFails) throw new actual.PdfError("corrupt");
      return {
        numPages: 3,
        getPage: async (number: number) => {
          pdf.pageOpens.push(number);
          const page: Record<string, unknown> = {
            cleanup: () => {},
            getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
            getTextContent: async () => ({ items: pdf.hasText ? [{ str: "Hola" }] : [] }),
          };
          if (pdf.hasRender) {
            page.render = ({ canvas }: { canvas: HTMLCanvasElement }) => {
              const call: RenderCall = {
                scale: canvas.width / 595,
                canvasWidth: canvas.width,
                cancelled: false,
                resolve: () => {},
              };
              pdf.renders.push(call);
              const promise = new Promise<void>((resolve, reject) => {
                call.resolve = resolve;
                if (!pdf.hold) resolve();
                (call as RenderCall & { reject?: (e: Error) => void }).reject = reject;
              });
              return {
                promise,
                cancel: () => {
                  call.cancelled = true;
                  const error = new Error("cancelled");
                  error.name = "RenderingCancelledException";
                  (call as RenderCall & { reject?: (e: Error) => void }).reject?.(error);
                },
              };
            };
          }
          return page;
        },
      };
    },
    renderPageToDataUrl: async (_page: unknown, options: { scale?: number } = {}) => {
      if (pdf.fallbackFails) throw new actual.PdfError("corrupt");
      pdf.fallbackScales.push(options.scale ?? 0);
      return "data:image/jpeg;base64,FALLBACK";
    },
    closePdfDocument: async () => {},
  };
});

let blobCounter = 0;
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  pdf.renders = [];
  pdf.hold = false;
  pdf.hasRender = true;
  pdf.hasText = true;
  pdf.pageOpens = [];
  pdf.fallbackScales = [];
  pdf.openFails = false;
  pdf.fallbackFails = false;
  blobCounter = 0;
  created.length = 0;
  revoked.length = 0;
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
    callback(new Blob([new Uint8Array(8)], { type: "image/png" }));
  } as never;
  URL.createObjectURL = vi.fn(() => {
    blobCounter += 1;
    const url = `blob:img-${blobCounter}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FILE = new File([new Uint8Array([1, 2, 3])], "doc.pdf", { type: "application/pdf" });

function Probe(props: PageImageParams) {
  const image = usePageImage(props);
  return (
    <div>
      <output data-testid="src">{image.src ?? "none"}</output>
      <output data-testid="sharp">{String(image.sharp)}</output>
      <output data-testid="loading">{String(image.loading)}</output>
      <output data-testid="aspect">{image.aspect === null ? "null" : image.aspect.toFixed(4)}</output>
      <output data-testid="pages">{image.pageCount}</output>
      <output data-testid="width">{image.pixelWidth}</output>
      <output data-testid="text">{String(image.hasText)}</output>
      <output data-testid="srcPage">{String(image.srcPage)}</output>
    </div>
  );
}

const read = (id: string) => screen.getByTestId(id).textContent;

describe("usePageImage — resolucion", () => {
  it("a DPR 1 pide un bitmap del ancho mostrado y lo entrega como blob (no un JPEG)", async () => {
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("sharp")).toBe("true"));
    expect(pdf.renders).toHaveLength(1);
    expect(pdf.renders[0].canvasWidth).toBe(600);
    expect(read("src")).toMatch(/^blob:img-/);
    expect(read("width")).toBe("600");
    expect(pdf.fallbackScales).toEqual([]);
  });

  it("a DPR 2 el bitmap tiene el doble de pixeles que el ancho de maquetacion", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("sharp")).toBe("true"));
    expect(pdf.renders[0].canvasWidth).toBe(1200);
  });

  it("sin medir (ancho 0) usa el ancho maximo del lienzo (640 px), nunca 0", async () => {
    render(<Probe file={FILE} pageIndex={0} layoutWidth={0} zoom={1} />);
    await waitFor(() => expect(read("sharp")).toBe("true"));
    expect(pdf.renders[0].canvasWidth).toBe(640);
  });

  it("al acercar vuelve a dibujar a mayor resolucion (nitido, no estirado)", async () => {
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("width")).toBe("600"));
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={2} />);
    await waitFor(() => expect(read("width")).toBe("1200"), { timeout: 3000 });
    expect(pdf.renders.map((call) => call.canvasWidth)).toEqual([600, 1200]);
  });

  it("zooms seguidos se funden: el render intermedio no llega a lanzarse (espera de asentamiento)", async () => {
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("width")).toBe("600"));
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={2} />);
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={3} />);
    await waitFor(() => expect(read("width")).toBe("1800"), { timeout: 3000 });
    expect(pdf.renders.map((call) => call.canvasWidth)).toEqual([600, 1800]);
  });

  it("un zoom continuo (pellizco) dentro del mismo paso de 0,25 no relanza el render", async () => {
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1.01} />);
    await waitFor(() => expect(read("sharp")).toBe("true"));
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1.2} />);
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1.24} />);
    await new Promise((resolve) => setTimeout(resolve, RERENDER_DEBOUNCE_MS + 150));
    expect(pdf.renders).toHaveLength(1);
  });

  it("a DPR 3 y zoom x3 respeta el tope de 16 MP", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
    render(<Probe file={FILE} pageIndex={0} layoutWidth={640} zoom={3} />);
    await waitFor(() => expect(read("sharp")).toBe("true"));
    const width = pdf.renders[0].canvasWidth;
    expect(width * Math.floor((842 / 595) * width)).toBeLessThanOrEqual(16_000_000);
    expect(Math.max(width, Math.floor((842 / 595) * width))).toBeLessThanOrEqual(4096);
  });
});

describe("usePageImage — cancelacion y cache", () => {
  it("un render obsoleto se cancela cuando cambia el zoom y su resultado no se muestra", async () => {
    pdf.hold = true;
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(pdf.renders).toHaveLength(1));
    // Llega el primero: asi hay una imagen mostrada y el siguiente cambio sale con retardo.
    await act(async () => pdf.renders[0].resolve());
    await waitFor(() => expect(read("sharp")).toBe("true"));
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={2} />);
    await waitFor(() => expect(pdf.renders).toHaveLength(2), { timeout: 3000 });
    // Zoom otra vez: el render de x2 (aun en vuelo) queda obsoleto.
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={3} />);
    await waitFor(() => expect(pdf.renders[1].cancelled).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(pdf.renders).toHaveLength(3), { timeout: 3000 });
    await act(async () => pdf.renders[2].resolve());
    await waitFor(() => expect(read("width")).toBe("1800"));
  });

  it("volver a una pagina ya dibujada sale de la cache: no se repite el render", async () => {
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("0"));
    const first = read("src");
    rerender(<Probe file={FILE} pageIndex={1} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("1"));
    expect(pdf.renders).toHaveLength(2);
    rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("0"));
    expect(pdf.renders).toHaveLength(2);
    expect(read("src")).toBe(first);
  });

  it("mientras llega la pagina nueva se sigue mostrando la anterior y `loading` es true", async () => {
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("0"));
    const first = read("src");
    pdf.hold = true;
    rerender(<Probe file={FILE} pageIndex={1} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("loading")).toBe("true"));
    expect(read("src")).toBe(first);
    await waitFor(() => expect(pdf.renders).toHaveLength(2));
    await act(async () => pdf.renders[1].resolve());
    await waitFor(() => expect(read("loading")).toBe("false"));
  });

  it("al desmontar libera todas las URL de objeto (sin fugas de memoria)", async () => {
    const { rerender, unmount } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("0"));
    rerender(<Probe file={FILE} pageIndex={1} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("1"));
    unmount();
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it("la cache no deja mas de 6 imagenes vivas (documentos de 100+ paginas o 10 documentos no disparan la memoria)", async () => {
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("0"));
    // Solo hay 3 paginas simuladas: se alterna con zoom distinto para generar muchas claves.
    for (const zoom of [1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3]) {
      rerender(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={zoom} />);
      await waitFor(() => expect(read("width")).toBe(String(Math.floor(600 * zoom))), { timeout: 3000 });
    }
    const alive = created.filter((url) => !revoked.includes(url));
    expect(alive.length).toBeLessThanOrEqual(6);
  });
});

describe("usePageImage — respaldo y fallos", () => {
  it("sin motor de render (la pagina no tiene render) cae a la vista previa de siempre, con la escala pedida", async () => {
    pdf.hasRender = false;
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("src")).toBe("data:image/jpeg;base64,FALLBACK"));
    expect(read("sharp")).toBe("false");
    expect(pdf.fallbackScales[0]).toBeGreaterThan(0);
  });

  it("sin canvas 2D (contexto nulo) tambien cae al respaldo y no vuelve a intentar el render nitido", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const { rerender } = render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("sharp")).toBe("false"));
    rerender(<Probe file={FILE} pageIndex={1} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("srcPage")).toBe("1"));
    expect(pdf.renders).toHaveLength(0);
  });

  it("si toBlob falla se usa el respaldo (fallo amable, la pagina se ve)", async () => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
      callback(null);
    } as never;
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("src")).toBe("data:image/jpeg;base64,FALLBACK"));
  });

  it("un documento que no se puede abrir avisa con el codigo de error y no deja la pantalla cargando", async () => {
    pdf.openFails = true;
    const onError = vi.fn();
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("corrupt"));
    expect(read("loading")).toBe("false");
  });

  it("si ni el respaldo funciona avisa del error", async () => {
    pdf.hasRender = false;
    pdf.fallbackFails = true;
    const onError = vi.fn();
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("corrupt"));
  });
});

describe("usePageImage — datos de la pagina", () => {
  it("entrega la proporcion de la pagina y el numero de paginas", async () => {
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("aspect")).toBe((595 / 842).toFixed(4)));
    expect(read("pages")).toBe("3");
  });

  it("sabe si la pagina trae texto (una escaneada no): base de la accion «Buscar huecos»", async () => {
    pdf.hasText = false;
    render(<Probe file={FILE} pageIndex={0} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(read("text")).toBe("false"));
  });

  it("sin archivo no hay nada que cargar", () => {
    render(<Probe file={null} pageIndex={0} layoutWidth={600} zoom={1} />);
    expect(read("src")).toBe("none");
    expect(read("loading")).toBe("false");
  });

  it("una pagina pedida fuera de rango se recorta a la ultima", async () => {
    render(<Probe file={FILE} pageIndex={9} layoutWidth={600} zoom={1} />);
    await waitFor(() => expect(pdf.pageOpens).toContain(3));
  });
});
