import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ProViewer } from "@/app/pdf-pro/viewer/ProViewer";
import { createViewerStore } from "@/app/pdf-pro/viewer/viewerStore";
import { computeLayout, baseWidthFor } from "@/app/pdf-pro/viewer/viewerLayout";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import {
  VIEWER_MAX_IMAGES,
  VIEWER_MAX_MOUNTED,
  VIEWER_PAD_X,
  type ViewerPageInfo,
} from "@/app/pdf-pro/viewer/viewerTypes";
import {
  SetLanguage,
  ViewerHarness,
  installLayoutEnv,
  makeSnapshot,
  mixedPages,
  pagesOf,
  pdfMocks,
  resetViewerGlobals,
  settle,
  type LayoutEnv,
  type PageSpec,
} from "@/app/pdf-pro/viewer/viewerTestUtils";

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, openPdfDocument: utils.pdfMocks.open, closePdfDocument: utils.pdfMocks.close };
});
vi.mock("@/lib/pdf/pageRaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/pageRaster")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, renderPageRaster: utils.pdfMocks.render };
});

const V = PRO_STRINGS.es.viewer;
let env: LayoutEnv;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  env = installLayoutEnv({ width: 800, height: 600 });
  resetViewerGlobals();
});
afterEach(() => {
  cleanup();
  env.restore();
  vi.restoreAllMocks();
  resetReducedMotionPrefCache();
});

const sleep = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

type MountOptions = Partial<React.ComponentProps<typeof ProViewer>> & { store?: ReturnType<typeof createViewerStore> };

async function mount(pages: number | PageSpec[], options: MountOptions = {}) {
  const store = options.store ?? createViewerStore();
  const snapshot = makeSnapshot(pages);
  const { store: _ignored, ...props } = options;
  void _ignored;
  const ui = (current: typeof snapshot) => (
    <ViewerHarness snapshot={current} store={store}>
      <ProViewer {...props} />
    </ViewerHarness>
  );
  const utils = render(ui(snapshot));
  await settle();
  return { ...utils, store, snapshot, swap: (next: typeof snapshot) => utils.rerender(ui(next)) };
}

const articles = () => Array.from(document.querySelectorAll<HTMLElement>("article[data-page-index]"));
const indexes = () => articles().map((el) => Number(el.dataset.pageIndex));
const article = (index: number) => document.querySelector<HTMLElement>(`article[data-page-index="${index}"]`)!;
const feed = () => document.querySelector<HTMLElement>("[data-pro-feed]")!;
const scroller = () => document.querySelector<HTMLElement>("[data-pro-viewer-scroller]")!;
const images = () => document.querySelectorAll("article img");

describe("apertura y estados", () => {
  it("muestra una pagina por cada hoja del documento dentro de un feed con nombre", async () => {
    env.resize(800, 6000);
    await mount(5);
    const region = screen.getByRole("feed", { name: V.feedLabel });
    expect(region.getAttribute("aria-busy")).toBeNull();
    expect(articles()).toHaveLength(5);
  });

  it("mientras el documento se abre muestra «Preparando…» y despues desaparece", async () => {
    pdfMocks.state.openDelay = 60;
    const store = createViewerStore();
    const snapshot = makeSnapshot(3);
    render(
      <ViewerHarness snapshot={snapshot} store={store} pageCountHint={3}>
        <ProViewer />
      </ViewerHarness>,
    );
    expect(screen.getByText(V.loading)).toBeTruthy();
    // Con la pista de paginas, los huecos ya estan reservados (aunque aun marcados como ocupados).
    expect(screen.getByRole("feed").getAttribute("aria-busy")).toBe("true");
    await sleep(200);
    await settle();
    expect(screen.queryByText(V.loading)).toBeNull();
  });

  it("un documento que no se puede abrir muestra un error amable con «Reintentar»", async () => {
    pdfMocks.state.openError = new Error("roto");
    await mount(3);
    expect(screen.getByRole("alert").textContent).toContain(V.errorTitle);
    expect(screen.queryByRole("feed")).toBeNull();
    pdfMocks.state.openError = null;
    fireEvent.click(screen.getByRole("button", { name: V.retry }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(articles().length).toBeGreaterThan(0);
  });

  it("un documento sin paginas lo dice", async () => {
    await mount([]);
    expect(screen.getByText(V.noPages)).toBeTruthy();
    expect(screen.queryByRole("feed")).toBeNull();
  });

  it("sin snapshot no hay hojas ni error", async () => {
    render(
      <ViewerHarness snapshot={null}>
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    expect(articles()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("abre UN solo documento de pdf.js por snapshot y lo cierra al desmontar", async () => {
    const { unmount } = await mount(4);
    expect(pdfMocks.open).toHaveBeenCalledTimes(1);
    unmount();
    await settle();
    expect(pdfMocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("virtualizacion: ventana y altura reservada", () => {
  it("con 500 paginas solo se montan unas pocas, empezando por la primera", async () => {
    await mount(500);
    expect(articles().length).toBeLessThanOrEqual(VIEWER_MAX_MOUNTED);
    expect(indexes()[0]).toBe(0);
  });

  it("la altura del contenido es la suma exacta de las proporciones reales (barra de scroll correcta)", async () => {
    const specs = mixedPages(500);
    await mount(specs);
    const base = baseWidthFor(800);
    const aspects = new Float32Array(
      specs.map((s) => {
        const w = s.view ? s.view[2] - s.view[0] : s.w;
        const h = s.view ? s.view[3] - s.view[1] : s.h;
        return (s.rotate ?? 0) % 180 ? w / h : h / w;
      }),
    );
    const expected = computeLayout(aspects, 500, base).total;
    // Las medidas llegan por lotes: cuando estan todas, la barra de scroll es exacta.
    await waitFor(() => expect(parseFloat(feed().style.height)).toBeCloseTo(expected, 0));
  });

  it("cada hoja reserva su alto con su propia proporcion (apaisada, cuadrada, estrecha)", async () => {
    env.resize(800, 9000);
    await mount([
      { w: 595, h: 842 },
      { w: 842, h: 595 },
      { w: 300, h: 300 },
      { w: 200, h: 800 },
    ]);
    const base = baseWidthFor(800);
    expect(parseFloat(article(0).style.height)).toBeCloseTo(base * (842 / 595), 1);
    expect(parseFloat(article(1).style.height)).toBeCloseTo(base * (595 / 842), 1);
    expect(parseFloat(article(2).style.height)).toBeCloseTo(base, 1);
    expect(parseFloat(article(3).style.height)).toBeCloseTo(base * 4, 1);
    for (const index of [0, 1, 2, 3]) expect(parseFloat(article(index).style.width)).toBeCloseTo(base, 1);
  });

  it("una pagina girada 90 grados usa el alto/ancho intercambiados", async () => {
    env.resize(800, 3000);
    await mount([{ w: 595, h: 842, rotate: 90 }]);
    expect(parseFloat(article(0).style.height)).toBeCloseTo(baseWidthFor(800) * (595 / 842), 1);
  });

  it("el CropBox manda sobre el MediaBox", async () => {
    await mount([{ w: 600, h: 800, view: [100, 100, 500, 300] }]);
    expect(parseFloat(article(0).style.height)).toBeCloseTo(baseWidthFor(800) * (200 / 400), 1);
  });

  it("al desplazarse se montan las paginas de esa zona y se desmontan las de arriba", async () => {
    await mount(500);
    expect(indexes()).toContain(0);
    env.scrollTo(100_000);
    await settle();
    const now = indexes();
    expect(now).not.toContain(0);
    expect(now.length).toBeLessThanOrEqual(VIEWER_MAX_MOUNTED);
    // Cada pagina montada esta realmente cerca de la ventana visible.
    for (const index of now) {
      const top = parseFloat(article(index).style.top);
      expect(top).toBeGreaterThan(100_000 - 14_000);
      expect(top).toBeLessThan(100_000 + 600 + 14_000);
    }
  });

  it("la pagina actual del almacen sigue el desplazamiento", async () => {
    const { store } = await mount(60);
    expect(store.getCurrentPage()).toBe(0);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[20]);
    await settle();
    expect(store.getCurrentPage()).toBe(20);
    expect(store.getVisiblePages()).toContain(20);
  });

  it("las hojas montadas llevan su posicion en el documento (aria-posinset/aria-setsize)", async () => {
    await mount(500);
    expect(article(0).getAttribute("aria-posinset")).toBe("1");
    expect(article(0).getAttribute("aria-setsize")).toBe("500");
    expect(article(0).getAttribute("aria-label")).toBe(V.pageOf(1, 500));
  });

  it("onPageVisible avisa una vez por cada pagina que entra en la vista", async () => {
    const seen: number[] = [];
    await mount(60, { onPageVisible: (index) => seen.push(index) });
    expect(seen).toContain(0);
    const before = seen.length;
    // Sin moverse no repite.
    env.scrollTo(0);
    await settle();
    expect(seen.length).toBe(before);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[30]);
    await settle();
    expect(seen).toContain(30);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("el tamano del visor cambia el ancho de las hojas y conserva la pagina que se veia", async () => {
    const { store } = await mount(60);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[15]);
    await settle();
    expect(store.getCurrentPage()).toBe(15);
    env.resize(500, 600);
    await settle();
    expect(parseFloat(article(15).style.width)).toBeCloseTo(500 - 2 * VIEWER_PAD_X, 1);
    expect(store.getCurrentPage()).toBe(15);
  });
});

describe("imagenes y render", () => {
  it("dibuja las paginas de la ventana y no mas imagenes vivas que el tope", async () => {
    await mount(500);
    expect(images().length).toBeGreaterThan(0);
    expect(images().length).toBeLessThanOrEqual(VIEWER_MAX_IMAGES);
    expect(article(0).dataset.state).toBe("ready");
  });

  it("nunca hay mas de 2 renders a la vez", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    pdfMocks.render.mockImplementation(async (page: { index: number }, plan: { width: number; height: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { blob: new Blob([String(page.index)]), width: plan.width, height: plan.height };
    });
    env.resize(800, 3000);
    await mount(20);
    await sleep(120);
    expect(pdfMocks.render.mock.calls.length).toBeGreaterThan(2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("no dibuja nada hasta que el visor tiene medida (el primer bitmap sale al tamano de verdad, no a uno provisional)", async () => {
    env.resize(0, 6000);
    await mount(3);
    await sleep(200);
    expect(pdfMocks.renderCalls).toHaveLength(0);
    env.resize(800, 6000);
    await sleep(200);
    await settle();
    expect(pdfMocks.renderCalls.length).toBeGreaterThan(0);
    // 768 px de hoja a zoom 1 (nunca los 200 px del ancho minimo provisional).
    expect(new Set(pdfMocks.renderCalls.map((call) => call.width))).toEqual(new Set([768]));
  });

  it("la pagina central se dibuja primero", async () => {
    let release!: () => void;
    pdfMocks.state.renderGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.resize(800, 3000);
    await mount(20);
    release();
    await settle();
    const first = pdfMocks.renderCalls[0];
    expect(first.index).toBe(0);
  });

  it("el bitmap se pide al tamano real de pantalla: ancho x zoom x densidad", async () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    try {
      await mount(2);
      const call = pdfMocks.renderCalls.find((c) => c.index === 0)!;
      // 768 px de hoja a zoom 1, densidad 2 => 1536 px de ancho de bitmap.
      expect(call.width).toBe(1536);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    }
  });

  it("un render pendiente se cancela al salir la pagina de la ventana", async () => {
    pdfMocks.state.renderGate = new Promise(() => undefined);
    await mount(500);
    const firstSignal = pdfMocks.renderCalls[0]?.signal;
    expect(firstSignal).toBeDefined();
    expect(firstSignal!.aborted).toBe(false);
    env.scrollTo(150_000);
    await settle();
    expect(firstSignal!.aborted).toBe(true);
  });

  it("al desmontar se cancelan los renders y se liberan las URL", async () => {
    pdfMocks.state.renderGate = new Promise(() => undefined);
    const { unmount } = await mount(10);
    const signals = pdfMocks.renderCalls.map((call) => call.signal!);
    expect(signals.length).toBeGreaterThan(0);
    unmount();
    await settle();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("una pagina cuyo render falla muestra un aviso y no se reintenta en bucle", async () => {
    pdfMocks.state.failRender = new Set([0]);
    await mount(3);
    expect(article(0).dataset.state).toBe("error");
    expect(article(0).textContent).toContain(V.pageFailed);
    const callsFor0 = pdfMocks.renderCalls.filter((call) => call.index === 0).length;
    await sleep(150);
    expect(pdfMocks.renderCalls.filter((call) => call.index === 0).length).toBe(callsFor0);
    expect(article(1).dataset.state).toBe("ready");
  });

  it("reutiliza el render de una pagina ya dibujada al volver a ella (cache LRU)", async () => {
    await mount(60);
    const before = pdfMocks.renderCalls.filter((c) => c.index === 0).length;
    env.scrollTo(200_000 > 60 * 1100 ? 40_000 : 20_000);
    await settle();
    env.scrollTo(0);
    await settle();
    expect(article(0).dataset.state).toBe("ready");
    expect(pdfMocks.renderCalls.filter((c) => c.index === 0).length).toBe(before);
  });
});

describe("zoom", () => {
  it("los botones del almacen cambian el ancho de las hojas", async () => {
    const { store } = await mount(5);
    const base = baseWidthFor(800);
    expect(parseFloat(article(0).style.width)).toBeCloseTo(base, 1);
    act(() => store.zoomIn());
    expect(parseFloat(article(0).style.width)).toBeCloseTo(base * 1.25, 1);
    act(() => store.zoomOut());
    act(() => store.zoomOut());
    expect(parseFloat(article(0).style.width)).toBeCloseTo(base * 0.75, 1);
    act(() => store.fitWidth());
    expect(parseFloat(article(0).style.width)).toBeCloseTo(base, 1);
  });

  it("con zoom el contenido se ensancha y puede desplazarse en horizontal", async () => {
    const { store } = await mount(5);
    act(() => store.setZoom(3));
    expect(parseFloat(feed().style.width)).toBeGreaterThan(800);
  });

  it("Ctrl + rueda hacia arriba acerca y hacia abajo aleja", async () => {
    const { store } = await mount(5);
    fireEvent.wheel(scroller(), { ctrlKey: true, deltaY: -120, clientX: 400, clientY: 300 });
    expect(store.getZoom()).toBeGreaterThan(1);
    const zoomed = store.getZoom();
    fireEvent.wheel(scroller(), { ctrlKey: true, deltaY: 240, clientX: 400, clientY: 300 });
    expect(store.getZoom()).toBeLessThan(zoomed);
  });

  it("Cmd + rueda tambien", async () => {
    const { store } = await mount(5);
    fireEvent.wheel(scroller(), { metaKey: true, deltaY: -120 });
    expect(store.getZoom()).toBeGreaterThan(1);
  });

  it("la rueda sin Ctrl se deja al navegador (desplazamiento normal)", async () => {
    const { store } = await mount(5);
    const notPrevented = fireEvent.wheel(scroller(), { deltaY: 120 });
    expect(notPrevented).toBe(true);
    expect(store.getZoom()).toBe(1);
  });

  it("Ctrl + rueda cancela el zoom de la pagina entera del navegador", async () => {
    await mount(5);
    const notPrevented = fireEvent.wheel(scroller(), { ctrlKey: true, deltaY: -120 });
    expect(notPrevented).toBe(false);
  });

  it("el pellizco con dos dedos acerca en proporcion a la distancia", async () => {
    const { store } = await mount(5);
    const touch = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: x }) as Touch;
    fireEvent.touchStart(scroller(), { touches: [touch(300, 300), touch(400, 300)] });
    fireEvent.touchMove(scroller(), { touches: [touch(250, 300), touch(450, 300)] });
    expect(store.getZoom()).toBeCloseTo(2, 1);
    fireEvent.touchEnd(scroller(), { touches: [] });
    fireEvent.touchMove(scroller(), { touches: [touch(0, 0), touch(400, 0)] });
    expect(store.getZoom()).toBeCloseTo(2, 1);
  });

  it("un solo dedo no hace zoom", async () => {
    const { store } = await mount(5);
    const touch = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: 1 }) as Touch;
    fireEvent.touchStart(scroller(), { touches: [touch(300, 300)] });
    fireEvent.touchMove(scroller(), { touches: [touch(100, 100)] });
    expect(store.getZoom()).toBe(1);
  });

  it("el zoom mantiene la pagina que se veia", async () => {
    const { store } = await mount(60);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[12]);
    await settle();
    act(() => store.setZoom(2));
    await settle();
    expect(store.getCurrentPage()).toBe(12);
  });

  it("el bitmap se vuelve a dibujar a la nueva nitidez cuando el zoom se asienta", async () => {
    const { store } = await mount(3);
    const widths = new Set(pdfMocks.renderCalls.filter((c) => c.index === 0).map((c) => c.width));
    act(() => store.setZoom(2));
    await sleep(300);
    await settle();
    const after = new Set(pdfMocks.renderCalls.filter((c) => c.index === 0).map((c) => c.width));
    expect(after.size).toBe(widths.size + 1);
    expect(Math.max(...after)).toBeGreaterThan(Math.max(...widths));
  });

  it("zooms continuos dentro del mismo paso de 0,25 no lanzan otro render", async () => {
    const { store } = await mount(2);
    act(() => store.setZoom(1.3));
    await sleep(300);
    const afterFirst = pdfMocks.renderCalls.length;
    act(() => store.setZoom(1.4));
    act(() => store.setZoom(1.45));
    await sleep(300);
    expect(pdfMocks.renderCalls.length).toBe(afterFirst);
  });
});

describe("teclado y foco", () => {
  it("una sola hoja es parada de tabulador (la pagina actual)", async () => {
    await mount(5);
    const stops = articles().filter((el) => el.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0].dataset.pageIndex).toBe("0");
  });

  it("la parada de tabulador sigue a la pagina actual", async () => {
    await mount(60);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[25]);
    await settle();
    const stops = articles().filter((el) => el.tabIndex === 0);
    expect(stops.map((el) => el.dataset.pageIndex)).toEqual(["25"]);
  });

  it("Av Pag y Re Pag cambian de pagina y llevan el foco", async () => {
    const { store } = await mount(10);
    article(0).focus();
    fireEvent.keyDown(article(0), { key: "PageDown" });
    await settle();
    expect(store.getCurrentPage()).toBe(1);
    expect(document.activeElement).toBe(article(1));
    fireEvent.keyDown(article(1), { key: "PageUp" });
    await settle();
    expect(store.getCurrentPage()).toBe(0);
    expect(document.activeElement).toBe(article(0));
  });

  it("Av Pag en la ultima pagina no se sale del documento", async () => {
    const { store } = await mount(3);
    store.scrollToPage(2, { behavior: "instant" });
    await settle();
    article(2).focus();
    fireEvent.keyDown(article(2), { key: "PageDown" });
    await settle();
    expect(store.getCurrentPage()).toBe(2);
  });

  it("Inicio y Fin saltan a la primera y a la ultima", async () => {
    const { store } = await mount(60);
    article(0).focus();
    fireEvent.keyDown(article(0), { key: "End" });
    await settle();
    expect(store.getCurrentPage()).toBe(59);
    expect(document.activeElement).toBe(article(59));
    fireEvent.keyDown(article(59), { key: "Home" });
    await settle();
    expect(store.getCurrentPage()).toBe(0);
  });

  it("las flechas desplazan el visor (y no cambian de pagina de golpe)", async () => {
    await mount(10);
    article(0).focus();
    const before = env.scrollTop();
    fireEvent.keyDown(article(0), { key: "ArrowDown" });
    expect(env.scrollTop()).toBeGreaterThan(before);
    const after = env.scrollTop();
    fireEvent.keyDown(article(0), { key: "ArrowUp" });
    expect(env.scrollTop()).toBeLessThan(after);
  });

  it("+ - y 0 hacen zoom con el foco en una pagina", async () => {
    const { store } = await mount(5);
    article(0).focus();
    fireEvent.keyDown(article(0), { key: "+" });
    expect(store.getZoom()).toBe(1.25);
    fireEvent.keyDown(article(0), { key: "=" });
    expect(store.getZoom()).toBe(1.5);
    fireEvent.keyDown(article(0), { key: "-" });
    expect(store.getZoom()).toBe(1.25);
    fireEvent.keyDown(article(0), { key: "0" });
    expect(store.getZoom()).toBe(1);
  });

  it("las teclas escritas dentro de un control de la capa superpuesta no se interceptan", async () => {
    const { store } = await mount(5, {
      renderPageOverlay: () => <input aria-label="campo" data-testid="field" />,
    });
    const field = screen.getAllByTestId("field")[0];
    field.focus();
    fireEvent.keyDown(field, { key: "+" });
    fireEvent.keyDown(field, { key: "PageDown" });
    expect(store.getZoom()).toBe(1);
    expect(store.getCurrentPage()).toBe(0);
  });

  it("los botones de la capa superpuesta tampoco pierden sus teclas (+, Av Pag...) frente al visor", async () => {
    const { store } = await mount(5, {
      renderPageOverlay: () => <button type="button" data-testid="overlay-button">acción</button>,
    });
    const button = screen.getAllByTestId("overlay-button")[0];
    button.focus();
    expect(fireEvent.keyDown(button, { key: "+" })).toBe(true);
    expect(fireEvent.keyDown(button, { key: "PageDown" })).toBe(true);
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(true);
    expect(store.getZoom()).toBe(1);
    expect(store.getCurrentPage()).toBe(0);
  });

  it("la hoja con el foco no se desmonta aunque el visor se desplace lejos", async () => {
    await mount(500);
    article(0).focus();
    expect(document.activeElement).toBe(article(0));
    env.scrollTo(120_000);
    await settle();
    expect(article(0)).toBeTruthy();
    expect(document.activeElement).toBe(article(0));
  });

  it("al perder el foco la hoja lejana se desmonta", async () => {
    await mount(500);
    article(0).focus();
    env.scrollTo(120_000);
    await settle();
    expect(article(0)).toBeTruthy();
    act(() => article(0).blur());
    await settle();
    expect(document.querySelector('article[data-page-index="0"]')).toBeNull();
  });

  it("scrollToPage con foco enfoca la hoja de destino", async () => {
    const { store } = await mount(60);
    act(() => store.scrollToPage(33, { focus: true, behavior: "instant" }));
    await settle();
    expect(document.activeElement).toBe(article(33));
  });

  it("scrollToPage salta de verdad: la pagina pedida queda arriba y montada", async () => {
    const { store } = await mount(500);
    act(() => store.scrollToPage(321, { behavior: "instant" }));
    await settle();
    expect(article(321)).toBeTruthy();
    expect(store.getCurrentPage()).toBe(321);
  });

  it("api.focus lleva el foco a la pagina actual", async () => {
    const { store } = await mount(5);
    act(() => store.focus());
    await settle();
    expect(document.activeElement).toBe(article(0));
  });
});

describe("desplazamiento suave y movimiento reducido", () => {
  function stubReducedMotion(reduced: boolean) {
    resetReducedMotionPrefCache();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: reduced && query.includes("prefers-reduced-motion"),
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

  afterEach(() => vi.unstubAllGlobals());

  it("saltar a la pagina vecina es suave por defecto", async () => {
    stubReducedMotion(false);
    const { store } = await mount(10);
    const spy = vi.spyOn(Element.prototype, "scrollTo");
    act(() => store.scrollToPage(1));
    expect(spy.mock.calls[0][0]).toMatchObject({ behavior: "smooth" });
  });

  it("un salto largo es inmediato", async () => {
    stubReducedMotion(false);
    const { store } = await mount(60);
    const spy = vi.spyOn(Element.prototype, "scrollTo");
    act(() => store.scrollToPage(40));
    expect(spy.mock.calls[0][0]).toMatchObject({ behavior: "instant" });
  });

  it("con prefers-reduced-motion nunca es suave, ni pidiendolo", async () => {
    stubReducedMotion(true);
    const { store } = await mount(10);
    const spy = vi.spyOn(Element.prototype, "scrollTo");
    act(() => store.scrollToPage(1, { behavior: "smooth" }));
    expect(spy.mock.calls[0][0]).toMatchObject({ behavior: "instant" });
  });
});

describe("seleccion con raton", () => {
  beforeEach(() => env.resize(800, 9000));

  it("Ctrl + clic alterna y Cmd + clic tambien", async () => {
    const { store } = await mount(10);
    fireEvent.click(article(2), { ctrlKey: true });
    fireEvent.click(article(4), { metaKey: true });
    expect(store.getSelectedPages()).toEqual([2, 4]);
    fireEvent.click(article(2), { ctrlKey: true });
    expect(store.getSelectedPages()).toEqual([4]);
  });

  it("Mayus + clic selecciona el rango desde el ancla", async () => {
    const { store } = await mount(10);
    fireEvent.click(article(1), { ctrlKey: true });
    fireEvent.click(article(4), { shiftKey: true });
    expect(store.getSelectedPages()).toEqual([1, 2, 3, 4]);
  });

  it("un clic sencillo no cambia la seleccion (la edicion usa esos clics)", async () => {
    const { store } = await mount(10);
    fireEvent.click(article(3));
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("las hojas seleccionadas se marcan y se anuncian en su descripcion", async () => {
    await mount(10);
    fireEvent.click(article(3), { ctrlKey: true });
    expect(article(3).dataset.selected).toBe("true");
    expect(document.getElementById("pro-page-3-desc")!.textContent).toContain(V.pageSelected);
    expect(article(2).dataset.selected).toBeUndefined();
  });

  it("Escape quita la seleccion y Ctrl+A la completa", async () => {
    const { store } = await mount(10);
    article(0).focus();
    fireEvent.keyDown(article(0), { key: "a", ctrlKey: true });
    expect(store.getSelectedPages()).toHaveLength(10);
    fireEvent.keyDown(article(0), { key: "Escape" });
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("una seleccion controlada se refleja en el almacen y los cambios se notifican", async () => {
    const onSelect = vi.fn();
    const store = createViewerStore();
    const snapshot = makeSnapshot(8);
    const { rerender } = render(
      <ViewerHarness snapshot={snapshot} store={store}>
        <ProViewer selectedPages={new Set([1, 2])} onSelectPages={onSelect} />
      </ViewerHarness>,
    );
    await settle();
    expect(store.getSelectedPages()).toEqual([1, 2]);
    fireEvent.click(article(5), { ctrlKey: true });
    expect(onSelect).toHaveBeenCalled();
    const last = onSelect.mock.calls[onSelect.mock.calls.length - 1][0] as ReadonlySet<number>;
    expect([...last].sort()).toEqual([1, 2, 5]);
    rerender(
      <ViewerHarness snapshot={snapshot} store={store}>
        <ProViewer selectedPages={new Set([7])} onSelectPages={onSelect} />
      </ViewerHarness>,
    );
    await settle();
    expect(store.getSelectedPages()).toEqual([7]);
  });
});

describe("contrato para los modos: capas por pagina y barra", () => {
  it("renderPageOverlay recibe indice, ancho, alto, escala y geometria de cada hoja montada", async () => {
    const calls: ViewerPageInfo[] = [];
    await mount([{ w: 600, h: 800 }, { w: 600, h: 800, rotate: 90 }], {
      renderPageOverlay: (page) => {
        calls.push(page);
        return <span data-testid={`overlay-${page.index}`} />;
      },
    });
    const first = calls.find((call) => call.index === 0)!;
    expect(first.widthPx).toBeCloseTo(baseWidthFor(800), 1);
    expect(first.heightPx).toBeCloseTo(baseWidthFor(800) * (800 / 600), 1);
    expect(first.scale).toBeCloseTo(baseWidthFor(800) / 600, 4);
    expect(first.geometry).toMatchObject({ rotation: 0, viewWidth: 600, viewHeight: 800 });
    const second = calls.find((call) => call.index === 1)!;
    expect(second.geometry.rotation).toBe(90);
    expect(second.geometry.viewWidth).toBe(800);
    expect(second.scale).toBeCloseTo(baseWidthFor(800) / 800, 4);
    expect(article(0).querySelector('[data-testid="overlay-0"]')).toBeTruthy();
  });

  it("la capa se pinta DENTRO de la hoja y solo en las paginas montadas", async () => {
    const seen = new Set<number>();
    await mount(500, {
      renderPageOverlay: (page) => {
        seen.add(page.index);
        return <i />;
      },
    });
    expect(seen.size).toBeLessThanOrEqual(VIEWER_MAX_MOUNTED);
    expect(article(0).querySelectorAll("i")).toHaveLength(1);
  });

  it("una capa registrada con la API aparece y al retirarla desaparece", async () => {
    const { store } = await mount(3);
    expect(article(0).querySelector("b")).toBeNull();
    let off!: () => void;
    act(() => {
      off = store.registerOverlay(() => <b />);
    });
    expect(article(0).querySelector("b")).toBeTruthy();
    act(() => off());
    expect(article(0).querySelector("b")).toBeNull();
  });

  it("la capa de la propiedad tiene prioridad sobre la registrada", async () => {
    const { store } = await mount(2, { renderPageOverlay: () => <u /> });
    act(() => {
      store.registerOverlay(() => <b />);
    });
    expect(article(0).querySelector("u")).toBeTruthy();
    expect(article(0).querySelector("b")).toBeNull();
  });

  it("la barra de pagina solo se pinta en la hoja activa", async () => {
    const { store } = await mount(5, { renderPageToolbar: (page) => <button type="button">barra {page.index}</button> });
    expect(screen.getAllByRole("button", { name: /barra/ })).toHaveLength(1);
    expect(article(0).textContent).toContain("barra 0");
    act(() => store.scrollToPage(3, { behavior: "instant" }));
    await settle();
    expect(screen.getAllByRole("button", { name: /barra/ })).toHaveLength(1);
    expect(article(3).textContent).toContain("barra 3");
  });

  it("una barra registrada con la API tambien funciona", async () => {
    const { store } = await mount(3);
    act(() => {
      store.registerPageToolbar(() => <em>mi barra</em>);
    });
    expect(screen.getAllByText("mi barra")).toHaveLength(1);
  });
});

describe("cambio de snapshot (deshacer / rehacer)", () => {
  it("conserva la pagina visible y el zoom", async () => {
    const { store, swap } = await mount(60);
    act(() => store.setZoom(1.5));
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800) * 1.5);
    env.scrollTo(layout.tops[22]);
    await settle();
    expect(store.getCurrentPage()).toBe(22);
    swap(makeSnapshot(60));
    await settle();
    await settle();
    expect(store.getCurrentPage()).toBe(22);
    expect(store.getZoom()).toBe(1.5);
  });

  it("conserva el punto del documento aunque las paginas cambien de proporcion (girar todas)", async () => {
    const { store, swap } = await mount(60);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[30]);
    await settle();
    expect(store.getCurrentPage()).toBe(30);
    swap(makeSnapshot(pagesOf(60, { w: 595, h: 842, rotate: 90 })));
    await settle();
    await settle();
    expect(store.getCurrentPage()).toBe(30);
    // El scroll se recoloco para la nueva maquetacion (paginas apaisadas, mas bajas).
    expect(env.scrollTop()).toBeLessThan(layout.tops[30]);
  });

  it("abre el documento nuevo con UN documento por snapshot y cierra el anterior", async () => {
    const { swap } = await mount(5);
    expect(pdfMocks.open).toHaveBeenCalledTimes(1);
    swap(makeSnapshot(5));
    await settle();
    expect(pdfMocks.open).toHaveBeenCalledTimes(2);
    expect(pdfMocks.close).toHaveBeenCalledTimes(1);
  });

  it("las paginas que no cambiaron reutilizan su render (huella de pagina)", async () => {
    const { swap } = await mount(4);
    await settle();
    const rendersBefore = pdfMocks.render.mock.calls.length;
    expect(rendersBefore).toBeGreaterThan(0);
    swap(makeSnapshot(4));
    await settle();
    await settle();
    expect(pdfMocks.render.mock.calls.length).toBe(rendersBefore);
    expect(article(0).dataset.state).toBe("ready");
  });

  it("una pagina cuya huella cambio se vuelve a dibujar", async () => {
    pdfMocks.state.signatures = (index) => index;
    const { swap } = await mount(4);
    await settle();
    const before = pdfMocks.render.mock.calls.filter(([page]) => (page as { index: number }).index === 1).length;
    pdfMocks.state.signatures = (index) => (index === 1 ? 999 : index);
    swap(makeSnapshot(4));
    await settle();
    await settle();
    const after = pdfMocks.render.mock.calls.filter(([page]) => (page as { index: number }).index === 1).length;
    const page0Renders = pdfMocks.render.mock.calls.filter(([page]) => (page as { index: number }).index === 0).length;
    expect(after).toBe(before + 1);
    expect(page0Renders).toBe(1);
  });

  it("si el nuevo documento tiene menos paginas, la actual se acota a la ultima", async () => {
    const { store, swap } = await mount(60);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[50]);
    await settle();
    swap(makeSnapshot(10));
    await settle();
    await settle();
    expect(store.getPageCount()).toBe(10);
    expect(store.getCurrentPage()).toBeLessThanOrEqual(9);
  });

  it("la seleccion de paginas inexistentes se poda", async () => {
    const { store, swap } = await mount(20);
    store.setSelectedPages([2, 15, 19]);
    swap(makeSnapshot(10));
    await settle();
    await settle();
    expect(store.getSelectedPages()).toEqual([2]);
  });
});

describe("anuncios por la region viva unica", () => {
  async function mountAnnouncing(pages: number | PageSpec[]) {
    const announce = vi.fn();
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(pages)} store={store} announce={announce}>
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    return { announce, store };
  }

  it("un salto pedido anuncia «Pagina X de N» al instante", async () => {
    const { announce, store } = await mountAnnouncing(60);
    act(() => store.scrollToPage(30, { behavior: "instant" }));
    expect(announce).toHaveBeenCalledWith(V.pageOf(31, 60));
  });

  it("desplazarse hasta otra pagina la anuncia tras una pausa (una sola vez, la ultima)", async () => {
    const { announce } = await mountAnnouncing(60);
    const layout = computeLayout(new Float32Array(60).fill(842 / 595), 60, baseWidthFor(800));
    env.scrollTo(layout.tops[5]);
    env.scrollTo(layout.tops[9]);
    env.scrollTo(layout.tops[12]);
    expect(announce).not.toHaveBeenCalled();
    await sleep(900);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(V.pageOf(13, 60));
  });

  it("recolocar el visor (cambio de tamano) no anuncia nada", async () => {
    const { announce } = await mountAnnouncing(60);
    env.resize(500, 600);
    await sleep(900);
    expect(announce).not.toHaveBeenCalled();
  });

  it("un cambio de zoom se anuncia con el porcentaje tras una pausa", async () => {
    const { announce, store } = await mountAnnouncing(10);
    act(() => store.setZoom(1.25));
    act(() => store.setZoom(1.5));
    await sleep(500);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(V.zoomLevel(150));
  });

  it("un anuncio mas importante (p. ej. «Aplicado») que llega durante la pausa NO es pisado por el de zoom", async () => {
    let lastId = 1;
    const announce = vi.fn();
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(10)} store={store} announce={announce} getAnnouncementId={() => lastId}>
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    act(() => store.setZoom(1.5));
    lastId = 2; // otro mensaje se anuncio mientras tanto
    await sleep(500);
    expect(announce).not.toHaveBeenCalled();
  });

  it("lo mismo con el aviso de la pagina a la que se llego desplazandose", async () => {
    let lastId = 1;
    const announce = vi.fn();
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(60)} store={store} announce={announce} getAnnouncementId={() => lastId}>
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    env.scrollTo(30_000);
    lastId = 2;
    await sleep(900);
    expect(announce).not.toHaveBeenCalled();
  });

  it("si nadie mas anuncio nada, el aviso de zoom sale igualmente", async () => {
    const announce = vi.fn();
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(10)} store={store} announce={announce} getAnnouncementId={() => 7}>
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    act(() => store.setZoom(2));
    await sleep(500);
    expect(announce).toHaveBeenCalledWith(V.zoomLevel(200));
  });

  it("al desmontar no anuncia nada pendiente", async () => {
    const announce = vi.fn();
    const store = createViewerStore();
    const { unmount } = render(
      <ViewerHarness snapshot={makeSnapshot(60)} store={store} announce={announce}>
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    env.scrollTo(30_000);
    unmount();
    await sleep(900);
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("idioma", () => {
  it("las etiquetas de las hojas salen en el idioma activo", async () => {
    env.resize(800, 6000);
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(3)} store={store}>
        <SetLanguage language="en" />
        <ProViewer />
      </ViewerHarness>,
    );
    await settle();
    expect(article(1).getAttribute("aria-label")).toBe(PRO_STRINGS.en.viewer.pageOf(2, 3));
    expect(screen.getByRole("feed", { name: PRO_STRINGS.en.viewer.feedLabel })).toBeTruthy();
    expect(document.getElementById("pro-page-0-desc")!.textContent).toContain(PRO_STRINGS.en.viewer.pageSize(210, 297));
  });

  it("la descripcion de cada hoja da su tamano en mm y su giro", async () => {
    await mount([{ w: 595, h: 842 }, { w: 595, h: 842, rotate: 90 }]);
    expect(document.getElementById("pro-page-0-desc")!.textContent).toContain(V.pageSize(210, 297));
    expect(document.getElementById("pro-page-1-desc")!.textContent).toContain(V.pageRotated(90));
    expect(document.getElementById("pro-page-1-desc")!.textContent).toContain(V.pageSize(297, 210));
  });
});

describe("rendimiento (con simulacros de pdf.js)", () => {
  it("500 paginas mixtas: abre, salta y se desplaza sin montar mas de lo permitido", async () => {
    const { store } = await mount(mixedPages(500));
    let peak = articles().length;
    for (const page of [250, 499, 3, 123, 400, 77]) {
      act(() => store.scrollToPage(page, { behavior: "instant" }));
      await settle(2);
      expect(article(page)).toBeTruthy();
      expect(store.getCurrentPage()).toBe(page);
      peak = Math.max(peak, articles().length);
      expect(images().length).toBeLessThanOrEqual(VIEWER_MAX_IMAGES);
    }
    expect(peak).toBeLessThanOrEqual(VIEWER_MAX_MOUNTED);
  });

  it("se desplaza por todo el documento a saltos sin que las imagenes vivas superen el tope", async () => {
    await mount(mixedPages(500));
    for (let top = 0; top < 60_000; top += 3_700) {
      env.scrollTo(top);
      await settle(1);
      expect(images().length).toBeLessThanOrEqual(VIEWER_MAX_IMAGES);
      expect(articles().length).toBeLessThanOrEqual(VIEWER_MAX_MOUNTED);
    }
  });

  it("espera a que se asienten los renders de una pagina antes de declararla lista", async () => {
    await mount(3);
    await waitFor(() => expect(article(0).dataset.state).toBe("ready"));
  });
});
