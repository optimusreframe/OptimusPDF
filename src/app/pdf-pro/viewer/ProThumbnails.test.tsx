import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ProThumbnails, PRO_MAX_THUMBS, THUMB_CSS_WIDTH, THUMB_PAGE_STEP } from "@/app/pdf-pro/viewer/ProThumbnails";
import { createViewerStore } from "@/app/pdf-pro/viewer/viewerStore";
import {
  SetLanguage,
  ViewerHarness,
  installIntersectionObserver,
  installLayoutEnv,
  makeSnapshot,
  mixedPages,
  pdfMocks,
  resetViewerGlobals,
  settle,
  type FakeIntersection,
  type LayoutEnv,
} from "@/app/pdf-pro/viewer/viewerTestUtils";

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return {
    ...actual,
    openPdfDocument: utils.pdfMocks.open,
    closePdfDocument: utils.pdfMocks.close,
    renderPageToDataUrl: utils.pdfMocks.thumb,
  };
});

const V = PRO_STRINGS.es.viewer;
let env: LayoutEnv;
let io: FakeIntersection | null = null;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  env = installLayoutEnv();
  resetViewerGlobals();
  io = null;
});
afterEach(() => {
  cleanup();
  io?.restore();
  env.restore();
});

async function mount(pages: number | ReturnType<typeof mixedPages>, props: React.ComponentProps<typeof ProThumbnails> = {}) {
  const store = createViewerStore();
  const snapshot = makeSnapshot(pages);
  const count = typeof pages === "number" ? pages : pages.length;
  const ui = (current: typeof snapshot) => (
    <ViewerHarness snapshot={current} store={store} pageCountHint={count}>
      <ProThumbnails {...props} />
    </ViewerHarness>
  );
  const utils = render(ui(snapshot));
  await settle();
  return { ...utils, store, swap: (next: typeof snapshot) => utils.rerender(ui(next)) };
}

/** Deja pasar unos fotogramas: el observador de visibilidad avisa con `requestAnimationFrame`. */
const frames = (ms = 80) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const options = () => screen.getAllByRole("option");
const option = (index: number) => document.querySelector<HTMLElement>(`[data-thumb-index="${index}"]`)!;
const thumbImages = () => document.querySelectorAll("[data-thumb-index] img");

describe("lista de miniaturas", () => {
  it("es un listbox multiseleccion con una opcion por pagina", async () => {
    await mount(12);
    const list = screen.getByRole("listbox", { name: V.thumbsListLabel(12) });
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    expect(within(list).getAllByRole("option")).toHaveLength(12);
  });

  it("cada opcion se llama «Pagina N»", async () => {
    await mount(3);
    expect(options().map((el) => el.getAttribute("aria-label"))).toEqual([V.thumbLabel(1), V.thumbLabel(2), V.thumbLabel(3)]);
  });

  it("la pagina actual lleva aria-current y la lista sigue al visor", async () => {
    const { store } = await mount(5);
    expect(option(0).getAttribute("aria-current")).toBe("page");
    act(() => store.setCurrentPage(3));
    expect(option(3).getAttribute("aria-current")).toBe("page");
    expect(option(0).getAttribute("aria-current")).toBeNull();
  });

  it("antes de que pdf.js abra el documento ya hay una opcion por pagina (con la pista del numero de paginas)", async () => {
    pdfMocks.state.openDelay = 80;
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(7)} store={store} pageCountHint={7}>
        <ProThumbnails />
      </ViewerHarness>,
    );
    expect(screen.getAllByRole("option")).toHaveLength(7);
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 150))));
  });

  it("sin paginas no pinta nada", async () => {
    const store = createViewerStore();
    const { container } = render(
      <ViewerHarness snapshot={null} store={store}>
        <ProThumbnails />
      </ViewerHarness>,
    );
    await settle();
    expect(container.querySelector("[role=listbox]")).toBeNull();
  });

  it("reserva el alto de cada miniatura con la proporcion real de su pagina", async () => {
    await mount([
      { w: 595, h: 842 },
      { w: 842, h: 595 },
      { w: 200, h: 800 },
    ]);
    await vi.waitFor(() => {
      const ratio = (index: number) =>
        Number.parseFloat((option(index).querySelector("span") as HTMLElement).style.aspectRatio.split("/")[1]);
      expect(ratio(0)).toBeCloseTo(842 / 595, 4);
      expect(ratio(1)).toBeCloseTo(595 / 842, 4);
      expect(ratio(2)).toBeCloseTo(4, 4);
    });
  });

  it("una sola miniatura es parada de tabulador", async () => {
    await mount(8);
    expect(options().filter((el) => el.tabIndex === 0)).toHaveLength(1);
    expect(option(0).tabIndex).toBe(0);
  });

  it("las etiquetas salen en ingles con el idioma en", async () => {
    const store = createViewerStore();
    render(
      <ViewerHarness snapshot={makeSnapshot(3)} store={store} pageCountHint={3}>
        <SetLanguage language="en" />
        <ProThumbnails />
      </ViewerHarness>,
    );
    await settle();
    expect(screen.getByRole("listbox", { name: PRO_STRINGS.en.viewer.thumbsListLabel(3) })).toBeTruthy();
    expect(option(1).getAttribute("aria-label")).toBe(PRO_STRINGS.en.viewer.thumbLabel(2));
  });
});

describe("clic y seleccion multiple", () => {
  it("un clic salta a esa pagina y avisa al terminar", async () => {
    const onAfterNavigate = vi.fn();
    const { store } = await mount(10, { onAfterNavigate });
    fireEvent.click(option(6));
    expect(store.getCurrentPage()).toBe(6);
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("Ctrl o Cmd + clic alterna la seleccion sin saltar", async () => {
    const { store } = await mount(10);
    fireEvent.click(option(2), { ctrlKey: true });
    fireEvent.click(option(5), { metaKey: true });
    expect(store.getSelectedPages()).toEqual([2, 5]);
    expect(store.getCurrentPage()).toBe(0);
    expect(option(2).getAttribute("aria-selected")).toBe("true");
    expect(option(3).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(option(2), { ctrlKey: true });
    expect(store.getSelectedPages()).toEqual([5]);
  });

  it("Mayus + clic selecciona el rango desde el ancla", async () => {
    const { store } = await mount(10);
    fireEvent.click(option(2), { ctrlKey: true });
    fireEvent.click(option(6), { shiftKey: true });
    expect(store.getSelectedPages()).toEqual([2, 3, 4, 5, 6]);
  });

  it("la seleccion es la MISMA del visor (el almacen compartido)", async () => {
    const { store } = await mount(10);
    act(() => store.setSelectedPages([1, 8]));
    expect(option(1).getAttribute("aria-selected")).toBe("true");
    expect(option(8).getAttribute("aria-selected")).toBe("true");
  });

  it("en la columna lateral el recuento NO se repite (esta en la barra del visor)", async () => {
    const { store } = await mount(10);
    act(() => store.setSelectedPages([1, 2, 3]));
    expect(document.querySelector("[data-selection-count]")).toBeNull();
    expect(screen.queryByRole("button", { name: V.clearSelection })).toBeNull();
  });

  it("en la rejilla de la hoja de movil muestra cuantas y un boton para quitarlas", async () => {
    const { store } = await mount(10, { variant: "grid" });
    expect(document.querySelector("[data-selection-count]")).toBeNull();
    act(() => store.setSelectedPages([1, 2, 3]));
    expect(document.querySelector("[data-selection-count]")!.textContent).toBe(V.selectedCount(3));
    fireEvent.click(screen.getByRole("button", { name: V.clearSelection }));
    expect(store.getSelectedPages()).toEqual([]);
    expect(document.querySelector("[data-selection-count]")).toBeNull();
  });
});

describe("teclado (roving tabindex)", () => {
  async function focused(count = 20) {
    const utils = await mount(count);
    act(() => option(0).focus());
    return utils;
  }

  it("las flechas mueven el foco y el unico tabulador", async () => {
    await focused();
    fireEvent.keyDown(option(0), { key: "ArrowDown" });
    expect(document.activeElement).toBe(option(1));
    expect(options().filter((el) => el.tabIndex === 0).map((el) => el.dataset.thumbIndex)).toEqual(["1"]);
    fireEvent.keyDown(option(1), { key: "ArrowUp" });
    expect(document.activeElement).toBe(option(0));
  });

  it("izquierda y derecha tambien (rejilla de la hoja movil)", async () => {
    await focused();
    fireEvent.keyDown(option(0), { key: "ArrowRight" });
    expect(document.activeElement).toBe(option(1));
    fireEvent.keyDown(option(1), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(option(0));
  });

  it("en los extremos no se sale de la lista", async () => {
    await focused(5);
    fireEvent.keyDown(option(0), { key: "ArrowUp" });
    expect(document.activeElement).toBe(option(0));
    fireEvent.keyDown(option(0), { key: "End" });
    expect(document.activeElement).toBe(option(4));
    fireEvent.keyDown(option(4), { key: "ArrowDown" });
    expect(document.activeElement).toBe(option(4));
    fireEvent.keyDown(option(4), { key: "Home" });
    expect(document.activeElement).toBe(option(0));
  });

  it("Av Pag y Re Pag saltan varias miniaturas", async () => {
    await focused(30);
    fireEvent.keyDown(option(0), { key: "PageDown" });
    expect(document.activeElement).toBe(option(THUMB_PAGE_STEP));
    fireEvent.keyDown(option(THUMB_PAGE_STEP), { key: "PageUp" });
    expect(document.activeElement).toBe(option(0));
  });

  it("Intro salta a la pagina enfocada sin quitar el foco de la lista", async () => {
    const { store } = await focused();
    fireEvent.keyDown(option(0), { key: "ArrowDown" });
    fireEvent.keyDown(option(1), { key: "ArrowDown" });
    fireEvent.keyDown(option(2), { key: "Enter" });
    expect(store.getCurrentPage()).toBe(2);
    expect(document.activeElement).toBe(option(2));
  });

  it("Espacio alterna la seleccion de la miniatura enfocada", async () => {
    const { store } = await focused();
    fireEvent.keyDown(option(0), { key: " " });
    expect(store.getSelectedPages()).toEqual([0]);
    fireEvent.keyDown(option(0), { key: " " });
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("Mayus + flecha amplia la seleccion desde donde estaba el foco", async () => {
    const { store } = await focused();
    fireEvent.keyDown(option(0), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(option(1), { key: "ArrowDown", shiftKey: true });
    expect(store.getSelectedPages()).toEqual([0, 1, 2]);
    expect(document.activeElement).toBe(option(2));
  });

  it("Esc quita la seleccion y Ctrl+A la completa", async () => {
    const { store } = await focused(6);
    fireEvent.keyDown(option(0), { key: "a", ctrlKey: true });
    expect(store.getSelectedPages()).toHaveLength(6);
    fireEvent.keyDown(option(0), { key: "Escape" });
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("Esc sin seleccion no hace nada (deja pasar el evento)", async () => {
    await focused();
    const notPrevented = fireEvent.keyDown(option(0), { key: "Escape" });
    expect(notPrevented).toBe(true);
  });

  it("otras teclas no se interceptan", async () => {
    await focused();
    expect(fireEvent.keyDown(option(0), { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(option(0), { key: "x" })).toBe(true);
  });
});

describe("carga perezosa", () => {
  it("sin observador de visibilidad hace la activa y sus vecinas, de una en una", async () => {
    // jsdom no trae IntersectionObserver: la tira cae a la ventana alrededor de la pagina actual.
    await mount(60);
    await settle(10);
    const done = pdfMocks.thumbCalls.map((call) => call.index);
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThan(15);
    expect(pdfMocks.thumbMaxInFlight).toBe(1);
  });

  it("solo se dibujan las miniaturas que la lista tiene a la vista", async () => {
    io = installIntersectionObserver();
    await mount(100);
    io.setVisible([40, 41, 42]);
    await frames();
    const done = new Set(pdfMocks.thumbCalls.map((call) => call.index));
    expect([...done].every((index) => [40, 41, 42].includes(index))).toBe(true);
    expect(done.size).toBe(3);
    await vi.waitFor(() => expect(thumbImages()).toHaveLength(3));
  });

  it("al desplazar la lista se piden las nuevas y no se repiten las hechas", async () => {
    io = installIntersectionObserver();
    await mount(100);
    io.setVisible([0, 1, 2]);
    await frames();
    const first = pdfMocks.thumbCalls.length;
    expect(first).toBe(3);
    io.setVisible([1, 2, 3, 4]);
    await frames();
    const indexes = pdfMocks.thumbCalls.map((call) => call.index);
    expect(indexes.filter((i) => i === 1)).toHaveLength(1);
    expect(pdfMocks.thumbCalls.length).toBe(first + 2);
  });

  it("la concurrencia es 1 aunque haya muchas a la vista", async () => {
    io = installIntersectionObserver();
    await mount(100);
    io.setVisible(Array.from({ length: 30 }, (_, i) => i));
    await frames(200);
    expect(pdfMocks.thumbMaxInFlight).toBe(1);
    expect(pdfMocks.thumbCalls.length).toBe(30);
  });

  it("las mas cercanas a la pagina actual van primero", async () => {
    io = installIntersectionObserver();
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 20));
    pdfMocks.state.thumbGate = gate;
    const { store } = await mount(100);
    act(() => store.setCurrentPage(50));
    io.setVisible([10, 49, 50, 51, 90]);
    await frames(120);
    expect(pdfMocks.thumbCalls[0].index).toBe(50);
  });

  it("no guarda mas de 80 miniaturas en memoria aunque se recorra todo el documento", async () => {
    io = installIntersectionObserver();
    await mount(300);
    for (let start = 0; start < 300; start += 20) {
      io.setVisible(Array.from({ length: 20 }, (_, i) => start + i));
      await frames(150);
    }
    // Se pidieron las 300 (hizo falta expulsar) y, aun asi, nunca hay mas de 80 en memoria.
    expect(pdfMocks.thumbCalls.length).toBeGreaterThanOrEqual(280);
    expect(PRO_MAX_THUMBS).toBe(80);
    expect(thumbImages().length).toBeLessThanOrEqual(80);
    expect(thumbImages().length).toBeGreaterThan(20);
  });

  it("el bitmap se pide al ancho de miniatura (120-160 px) multiplicado por la densidad hasta 2", async () => {
    await mount(3);
    await settle(6);
    expect(pdfMocks.thumbCalls[0].maxWidth).toBe(THUMB_CSS_WIDTH);
    expect(THUMB_CSS_WIDTH).toBeGreaterThanOrEqual(120);
    expect(THUMB_CSS_WIDTH).toBeLessThanOrEqual(160);
  });

  it("al cambiar de documento se descartan las miniaturas viejas y se hacen las nuevas", async () => {
    const { swap } = await mount(4);
    await settle(10);
    const before = pdfMocks.thumbCalls.length;
    expect(before).toBeGreaterThan(0);
    swap(makeSnapshot(4));
    await settle(12);
    expect(pdfMocks.thumbCalls.length).toBeGreaterThan(before);
  });
});
