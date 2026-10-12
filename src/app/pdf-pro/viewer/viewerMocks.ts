import { vi } from "vitest";
import type { ViewerSnapshot } from "@/app/pdf-pro/viewer/viewerTypes";

/**
 * Simulacros de pdf.js para las pruebas del visor (SOLO PRUEBAS): un documento de mentira con tamanos, giros y
 * CropBox por pagina, y el render simulado. Este modulo NO importa nada de la aplicacion (salvo tipos): las
 * fabricas de `vi.mock("@/lib/pdf/core")` lo cargan y un ciclo con `core` las dejaria colgadas.
 */

export type PageSpec = { w: number; h: number; rotate?: number; view?: [number, number, number, number] };

const A4: PageSpec = { w: 595, h: 842 };

/** `count` paginas iguales, o una lista explicita. */
export function pagesOf(count: number | PageSpec[], spec: PageSpec = A4): PageSpec[] {
  return typeof count === "number" ? Array.from({ length: count }, () => ({ ...spec })) : count;
}

/** 500 paginas de tamanos mezclados y giradas, como un documento real raro. */
export function mixedPages(count: number): PageSpec[] {
  const shapes: PageSpec[] = [
    { w: 595, h: 842 },
    { w: 842, h: 595 },
    { w: 612, h: 792 },
    { w: 300, h: 300 },
    { w: 200, h: 800 },
    { w: 595, h: 842, rotate: 90 },
    { w: 420, h: 595, rotate: 180 },
    { w: 595, h: 842, rotate: 270, view: [20, 20, 500, 700] },
  ];
  return Array.from({ length: count }, (_, i) => ({ ...shapes[i % shapes.length] }));
}

type FakePage = {
  index: number;
  view: number[];
  rotate: number;
  ref: { num: number; gen: number };
  getViewport: (options: { scale: number }) => { width: number; height: number };
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
};

export function fakePdfDocument(specs: PageSpec[], signatures?: (index: number) => number) {
  const getPage = vi.fn(async (number: number): Promise<FakePage> => {
    const index = number - 1;
    const spec = specs[index];
    if (!spec) throw new Error(`pagina ${number} fuera del documento`);
    const rotate = spec.rotate ?? 0;
    const view = spec.view ?? [0, 0, spec.w, spec.h];
    const boxW = view[2] - view[0];
    const boxH = view[3] - view[1];
    const swapped = rotate % 180 !== 0;
    return {
      index,
      view,
      rotate,
      ref: { num: 10 + index, gen: 0 },
      getViewport: ({ scale }) => ({ width: (swapped ? boxH : boxW) * scale, height: (swapped ? boxW : boxH) * scale }),
      getOperatorList: async () => ({ fnArray: [signatures ? signatures(index) : index], argsArray: [[index]] }),
      render: vi.fn(),
      cleanup: vi.fn(),
    };
  });
  const loadingTask = { destroy: vi.fn(async () => undefined) };
  return { numPages: specs.length, getPage, loadingTask };
}

export type FakePdfDocument = ReturnType<typeof fakePdfDocument>;

/** Los simulacros de `@/lib/pdf/core` y `@/lib/pdf/pageRaster` que cada archivo de prueba conecta con `vi.mock`. */
export const pdfMocks = (() => {
  const specsByBytes = new WeakMap<object, PageSpec[]>();
  const opened: FakePdfDocument[] = [];
  const state = {
    /** Si hay una puerta, el render espera a que se abra. */
    renderGate: null as Promise<void> | null,
    /** Paginas (base 0) cuyo render falla. */
    failRender: new Set<number>(),
    /** Error al abrir (o `null`). */
    openError: null as Error | null,
    /** Puerta de las miniaturas (control exacto del orden). */
    thumbGate: null as Promise<void> | null,
    /** Paginas de un documento cuyos bytes no se registraron (los PDF reales de otras pruebas). */
    defaultPages: 1,
    /** Retardo (ms) al abrir. */
    openDelay: 0,
    signatures: undefined as ((index: number) => number) | undefined,
  };
  const renderCalls: { index: number; width: number; height: number; signal?: AbortSignal }[] = [];
  const openImpl = async (source: Uint8Array) => {
    if (state.openDelay > 0) await new Promise((resolve) => setTimeout(resolve, state.openDelay));
    if (state.openError) throw state.openError;
    const specs = specsByBytes.get(source) ?? pagesOf(state.defaultPages);
    const doc = fakePdfDocument(specs, state.signatures);
    opened.push(doc);
    return doc as never;
  };
  const closeImpl = async () => undefined;
  const renderImpl = async (
    page: { index: number },
    plan: { width: number; height: number },
    options: { signal?: AbortSignal } = {},
  ) => {
    renderCalls.push({ index: page.index, width: plan.width, height: plan.height, signal: options.signal });
    if (state.renderGate) await state.renderGate;
    if (options.signal?.aborted) {
      const error = new Error("cancelled");
      error.name = "RenderingCancelledException";
      throw error;
    }
    if (state.failRender.has(page.index)) throw new Error("render fallido");
    return { blob: new Blob([`page-${page.index}`]), width: plan.width, height: plan.height };
  };
  const thumbCalls: { index: number; maxWidth: number }[] = [];
  let thumbInFlight = 0;
  let thumbMaxInFlight = 0;
  const thumbImpl = async (page: { index: number }, options: { maxWidth?: number } = {}) => {
    thumbCalls.push({ index: page.index, maxWidth: options.maxWidth ?? 0 });
    thumbInFlight += 1;
    thumbMaxInFlight = Math.max(thumbMaxInFlight, thumbInFlight);
    try {
      if (state.thumbGate) await state.thumbGate;
      else await Promise.resolve();
      return `data:thumb-${page.index}`;
    } finally {
      thumbInFlight -= 1;
    }
  };
  const open = vi.fn(openImpl);
  const close = vi.fn(closeImpl);
  const render = vi.fn(renderImpl);
  const thumb = vi.fn(thumbImpl);
  return {
    specsByBytes,
    opened,
    renderCalls,
    state,
    open,
    close,
    render,
    thumb,
    thumbCalls,
    get thumbMaxInFlight() {
      return thumbMaxInFlight;
    },
    reset() {
      thumbCalls.length = 0;
      thumbMaxInFlight = 0;
      state.thumbGate = null;
      opened.length = 0;
      renderCalls.length = 0;
      state.renderGate = null;
      state.failRender = new Set();
      state.openError = null;
      state.openDelay = 0;
      state.defaultPages = 1;
      state.signatures = undefined;
      // Se restauran tambien las implementaciones que una prueba haya cambiado.
      open.mockReset().mockImplementation(openImpl);
      close.mockReset().mockImplementation(closeImpl);
      render.mockReset().mockImplementation(renderImpl);
      thumb.mockReset().mockImplementation(thumbImpl);
    },
  };
})();

let snapshotCounter = 0;

/** Un snapshot cuyos bytes el simulacro de `openPdfDocument` reconoce. */
export function makeSnapshot(count: number | PageSpec[], id?: string): ViewerSnapshot {
  const bytes = new Uint8Array([37, 80, 68, 70, (snapshotCounter += 1) & 255]);
  pdfMocks.specsByBytes.set(bytes, pagesOf(count));
  return { id: id ?? `snap-${snapshotCounter}`, bytes };
}

