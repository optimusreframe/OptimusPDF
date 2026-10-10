import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PageStrip } from "@/app/edit-pdf/PageStrip";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

const mocks = vi.hoisted(() => ({ rendered: [] as number[] }));

vi.mock("@/lib/pdf/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdf/core")>()),
  renderPageToDataUrl: async (page: { index: number }) => {
    mocks.rendered.push(page.index);
    return `data:thumb-${page.index}`;
  },
}));

const s = EDIT_STRINGS.es.inline;

function fakeDoc(numPages: number): PDFDocumentProxy {
  return { numPages, getPage: async (n: number) => ({ index: n - 1, cleanup: vi.fn() }) } as unknown as PDFDocumentProxy;
}

type Observer = { callback: IntersectionObserverCallback; elements: Set<Element>; options?: IntersectionObserverInit };
let observers: Observer[] = [];

beforeEach(() => {
  mocks.rendered = [];
  observers = [];
  class FakeObserver {
    private readonly entry: Observer;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.entry = { callback, elements: new Set(), options };
      observers.push(this.entry);
    }
    observe(element: Element) {
      this.entry.elements.add(element);
    }
    unobserve(element: Element) {
      this.entry.elements.delete(element);
    }
    disconnect() {
      this.entry.elements.clear();
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Hace visibles las celdas `pages` (el observador del ultimo montaje). */
function show(pages: number[]) {
  const observer = observers[observers.length - 1];
  act(() => {
    observer.callback(
      pages.map((page) => ({
        isIntersecting: true,
        target: [...observer.elements].find((el) => (el as HTMLElement).dataset.pageThumb === String(page))!,
      })) as unknown as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  });
}

function mount(
  props: Partial<{
    pageCount: number;
    activeIndex: number;
    counts: Map<number, number>;
    flattened: Set<number>;
    onGo: (i: number) => void;
  }> = {},
) {
  const onGo = props.onGo ?? vi.fn();
  const view = render(
    <PageStrip
      doc={fakeDoc(props.pageCount ?? 300)}
      pageCount={props.pageCount ?? 300}
      activeIndex={props.activeIndex ?? 0}
      counts={props.counts ?? new Map()}
      flattened={props.flattened}
      flattenMark="se aplanará"
      onGo={onGo}
      strings={s}
    />,
  );
  return { ...view, onGo };
}

const cell = (index: number) => document.querySelector<HTMLButtonElement>(`[data-page-thumb="${index}"]`)!;

describe("PageStrip", () => {
  it("es una navegacion con nombre y una celda por pagina (300 paginas, sin rasterizar nada aun)", () => {
    mount();
    expect(document.querySelector("nav")!.getAttribute("aria-label")).toBe(s.thumbsLabel);
    expect(document.querySelectorAll("[data-page-thumb]")).toHaveLength(300);
    expect(mocks.rendered).toEqual([]);
  });

  it("observa TODAS las celdas con un solo observador y un margen lateral", () => {
    mount({ pageCount: 50 });
    expect(observers).toHaveLength(1);
    expect(observers[0].elements.size).toBe(50);
    expect(observers[0].options?.rootMargin).toMatch(/^0px \d+px$/);
  });

  it("solo se rasterizan las celdas que el observador dice que se ven", async () => {
    mount();
    show([0, 1, 2, 3]);
    await waitFor(() => expect(cell(3).dataset.thumbLoaded).toBeDefined());
    expect([...mocks.rendered].sort()).toEqual([0, 1, 2, 3]);
    expect(cell(250).dataset.thumbLoaded).toBeUndefined();
    expect(cell(2).querySelector("img")!.getAttribute("src")).toBe("data:thumb-2");
  });

  it("al desplazar la tira se hacen las nuevas", async () => {
    mount();
    show([0, 1]);
    await waitFor(() => expect(cell(1).dataset.thumbLoaded).toBeDefined());
    show([100, 101]);
    await waitFor(() => expect(cell(101).dataset.thumbLoaded).toBeDefined());
    expect(mocks.rendered).toContain(100);
  });

  it("marca la pagina activa con aria-current y le da el unico tabindex 0 (tabindex itinerante)", () => {
    mount({ activeIndex: 7 });
    expect(cell(7).getAttribute("aria-current")).toBe("page");
    expect(cell(6).getAttribute("aria-current")).toBeNull();
    const stops = Array.from(document.querySelectorAll<HTMLElement>("[data-page-thumb]")).filter((el) => el.tabIndex === 0);
    expect(stops).toEqual([cell(7)]);
  });

  it("las flechas, Inicio y Fin mueven el foco; la parada de Tab sigue al foco", () => {
    mount({ activeIndex: 5, pageCount: 20 });
    cell(5).focus();
    fireEvent.keyDown(cell(5), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(6));
    expect(cell(6).tabIndex).toBe(0);
    expect(cell(5).tabIndex).toBe(-1);
    fireEvent.keyDown(cell(6), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(5));
    fireEvent.keyDown(cell(5), { key: "End" });
    expect(document.activeElement).toBe(cell(19));
    fireEvent.keyDown(cell(19), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell(19)); // no da la vuelta
    fireEvent.keyDown(cell(19), { key: "Home" });
    expect(document.activeElement).toBe(cell(0));
  });

  it("clic va a la pagina; mover el foco con flechas NO cambia de pagina", () => {
    const { onGo } = mount({ pageCount: 20 });
    cell(0).focus();
    fireEvent.keyDown(cell(0), { key: "ArrowRight" });
    expect(onGo).not.toHaveBeenCalled();
    fireEvent.click(cell(9));
    expect(onGo).toHaveBeenCalledWith(9);
  });

  it("el nombre de cada celda dice la pagina y sus cambios", () => {
    mount({ pageCount: 5, counts: new Map([[1, 1], [3, 4]]) });
    expect(cell(0).getAttribute("aria-label")).toBe("Ir a la página 1");
    expect(cell(1).getAttribute("aria-label")).toBe("Ir a la página 2 (1 cambio)");
    expect(cell(3).getAttribute("aria-label")).toBe("Ir a la página 4 (4 cambios)");
    expect(cell(3).textContent).toContain("4 · 4");
  });

  it("con muchas paginas hay UNA sola parada de Tab, no 300", () => {
    mount({ pageCount: 300 });
    const stops = Array.from(document.querySelectorAll<HTMLElement>("[data-page-thumb]")).filter((el) => el.tabIndex >= 0);
    expect(stops).toHaveLength(1);
  });

  it("las celdas miden al menos 44 px (objetivo tactil)", () => {
    mount({ pageCount: 3 });
    expect(cell(0).className).toContain("h-[4.5rem]");
    expect(cell(0).className).toContain("w-14");
  });

  it("al cambiar de numero de paginas vuelve a observar y limpia al desmontar", () => {
    const { unmount } = mount({ pageCount: 10 });
    const first = observers[0];
    unmount();
    expect(first.elements.size).toBe(0);
  });

  it("cargar una miniatura solo vuelve a pintar SU celda (300 paginas, memoizado)", async () => {
    const thumbLabel = vi.fn(s.thumbLabel);
    render(
      <PageStrip doc={fakeDoc(300)} pageCount={300} activeIndex={0} counts={new Map()} onGo={vi.fn()} strings={{ ...s, thumbLabel }} />,
    );
    expect(thumbLabel).toHaveBeenCalledTimes(300);
    thumbLabel.mockClear();
    show([0, 1, 2]);
    await waitFor(() => expect(cell(2).dataset.thumbLoaded).toBeDefined());
    // Una repintada por celda que cambia (la miniatura), no por las 300.
    expect(thumbLabel.mock.calls.length).toBeLessThan(15);
  });

  it("sin IntersectionObserver funciona: hace la activa y sus vecinas", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    mount({ activeIndex: 40, pageCount: 100 });
    await waitFor(() => expect(cell(40).dataset.thumbLoaded).toBeDefined());
    expect(mocks.rendered.every((p) => Math.abs(p - 40) <= 5)).toBe(true);
  });
});

describe("PageStrip — paginas que se aplanaran (W5-U5)", () => {
  it("la celda de una pagina aplanada lo dice en su nombre accesible y lleva su marca visible", () => {
    mount({ pageCount: 5, flattened: new Set([2]), counts: new Map([[2, 1]]) });
    expect(cell(2).getAttribute("aria-label")).toBe(`${s.thumbLabel(3, 1)}, se aplanará`);
    expect(cell(2).hasAttribute("data-thumb-flattened")).toBe(true);
    expect(cell(1).hasAttribute("data-thumb-flattened")).toBe(false);
    expect(cell(1).getAttribute("aria-label")).toBe(s.thumbLabel(2, 0));
  });

  it("sin paginas aplanadas las celdas no cambian", () => {
    mount({ pageCount: 3 });
    expect(document.querySelectorAll("[data-thumb-flattened]")).toHaveLength(0);
  });
});

