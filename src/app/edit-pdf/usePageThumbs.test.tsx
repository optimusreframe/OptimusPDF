import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { FALLBACK_RADIUS, MAX_THUMBS, THUMB_WIDTH, evictThumbs, nextThumbPage, usePageThumbs } from "@/app/edit-pdf/usePageThumbs";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  inFlight: 0,
  maxInFlight: 0,
  failPages: new Set<number>(),
  delay: 0,
  /** Si hay una puerta, el rasterizado espera a que se abra (control exacto, sin plazos). */
  gate: null as Promise<void> | null,
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdf/core")>()),
  renderPageToDataUrl: async (page: { index: number }, options: { maxWidth: number }) => {
    mocks.render(page.index, options.maxWidth);
    mocks.inFlight += 1;
    mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
    try {
      if (mocks.gate) await mocks.gate;
      else await new Promise((resolve) => setTimeout(resolve, mocks.delay));
      if (mocks.failPages.has(page.index)) throw new Error("render failed");
      return `data:thumb-${page.index}`;
    } finally {
      mocks.inFlight -= 1;
    }
  },
}));

function fakeDoc(numPages: number): PDFDocumentProxy {
  return {
    numPages,
    getPage: async (number: number) => ({ index: number - 1, cleanup: vi.fn() }),
  } as unknown as PDFDocumentProxy;
}

beforeEach(() => {
  mocks.render.mockClear();
  mocks.inFlight = 0;
  mocks.maxInFlight = 0;
  mocks.failPages = new Set();
  mocks.delay = 0;
  mocks.gate = null;
});
afterEach(() => vi.restoreAllMocks());

const pagesRendered = () => mocks.render.mock.calls.map((call) => call[0] as number);

describe("nextThumbPage", () => {
  const none = () => false;

  it("elige la pagina visible mas cercana a la activa", () => {
    const visible = new Set([2, 3, 4, 9]);
    expect(nextThumbPage({ visible, active: 3, pageCount: 20, have: none, failed: none })).toBe(3);
    expect(nextThumbPage({ visible, active: 8, pageCount: 20, have: none, failed: none })).toBe(9);
  });

  it("salta las que ya estan hechas y las que fallaron", () => {
    const visible = new Set([1, 2, 3]);
    expect(nextThumbPage({ visible, active: 2, pageCount: 9, have: (p) => p === 2, failed: (p) => p === 1 })).toBe(3);
  });

  it("sin nada pendiente devuelve undefined", () => {
    expect(nextThumbPage({ visible: new Set([1]), active: 1, pageCount: 4, have: () => true, failed: none })).toBeUndefined();
    expect(nextThumbPage({ visible: new Set(), active: 1, pageCount: 4, have: none, failed: none })).toBeUndefined();
  });

  it("ignora paginas fuera del documento", () => {
    expect(nextThumbPage({ visible: new Set([-1, 7, 12]), active: 0, pageCount: 8, have: none, failed: none })).toBe(7);
  });

  it("sin saber que se ve, usa la activa y sus vecinas", () => {
    const next = nextThumbPage({ visible: null, active: 10, pageCount: 300, have: none, failed: none });
    expect(next).toBe(10);
    const far = nextThumbPage({ visible: null, active: 10, pageCount: 300, have: (p) => Math.abs(p - 10) <= FALLBACK_RADIUS, failed: none });
    expect(far).toBeUndefined();
  });
});

describe("evictThumbs", () => {
  const make = (pages: number[]) => Object.fromEntries(pages.map((p) => [p, `t${p}`]));

  it("no toca nada por debajo del limite", () => {
    const thumbs = make([1, 2, 3]);
    expect(evictThumbs(thumbs, 2, null, 2, 5)).toBe(thumbs);
  });

  it("suelta primero las mas lejanas a la activa", () => {
    const next = evictThumbs(make([0, 1, 2, 3, 4, 5]), 5, null, 5, 3);
    expect(Object.keys(next).map(Number).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it("nunca suelta las que se ven ni la recien hecha", () => {
    const next = evictThumbs(make([0, 1, 2, 3, 4, 5]), 5, new Set([0]), 1, 3);
    expect(Object.keys(next).map(Number)).toContain(0);
    expect(Object.keys(next).map(Number)).toContain(1);
    expect(Object.keys(next)).toHaveLength(3);
  });
});

describe("usePageThumbs", () => {
  it("rasteriza SOLO lo que se ve y a THUMB_WIDTH", async () => {
    const doc = fakeDoc(300);
    const { result } = renderHook(() => usePageThumbs(doc, 0));
    act(() => result.current.setVisible(new Set([0, 1, 2])));
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(3));
    expect(pagesRendered().sort()).toEqual([0, 1, 2]);
    expect(mocks.render.mock.calls[0][1]).toBe(THUMB_WIDTH);
    expect(result.current.thumbs[1]).toBe("data:thumb-1");
    expect(result.current.thumbs[100]).toBeUndefined();
  });

  it("concurrencia 1: nunca hay dos paginas rasterizandose a la vez", async () => {
    mocks.delay = 5;
    const doc = fakeDoc(100);
    const { result } = renderHook(() => usePageThumbs(doc, 0));
    act(() => result.current.setVisible(new Set([0, 1, 2, 3, 4, 5, 6, 7])));
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(8));
    expect(mocks.maxInFlight).toBe(1);
  });

  it("empieza por la pagina activa y sigue por las cercanas", async () => {
    mocks.delay = 2;
    const doc = fakeDoc(100);
    const { result } = renderHook(() => usePageThumbs(doc, 5));
    act(() => result.current.setVisible(new Set([3, 4, 5, 6, 7])));
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(5));
    expect(pagesRendered()[0]).toBe(5);
  });

  it("al desplazar la tira se hacen las nuevas y no se repiten las hechas", async () => {
    const doc = fakeDoc(200);
    const { result } = renderHook(() => usePageThumbs(doc, 0));
    act(() => result.current.setVisible(new Set([0, 1])));
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(2));
    mocks.render.mockClear();
    act(() => result.current.setVisible(new Set([1, 2])));
    await waitFor(() => expect(result.current.thumbs[2]).toBeDefined());
    expect(pagesRendered()).toEqual([2]);
  });

  it("deja de hacer las que ya no se ven", async () => {
    // La primera pagina queda "en marcha" detras de una puerta: el cambio de
    // zona visible ocurre con ella en vuelo, sin depender de cuanto tarde el
    // test en llegar ahi (con un retardo fijo, la maquina cargada dejaba
    // terminar tambien la siguiente antes del cambio).
    let release!: () => void;
    mocks.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const doc = fakeDoc(200);
    const { result } = renderHook(() => usePageThumbs(doc, 0));
    act(() => result.current.setVisible(new Set([0, 1, 2, 3, 4, 5])));
    await waitFor(() => expect(mocks.render.mock.calls.length).toBeGreaterThanOrEqual(1));
    act(() => result.current.setVisible(new Set([150])));
    release();
    await waitFor(() => expect(result.current.thumbs[150]).toBeDefined());
    // Solo termino la que ya estaba en marcha; el resto del grupo anterior se abandono.
    expect(Object.keys(result.current.thumbs).length).toBeLessThanOrEqual(2);
    expect(pagesRendered().filter((p) => p >= 2 && p <= 5)).toHaveLength(0);
  });

  it("la cache no pasa de MAX_THUMBS al recorrer un documento largo", async () => {
    const doc = fakeDoc(400);
    const { result, rerender } = renderHook(({ active }) => usePageThumbs(doc, active), { initialProps: { active: 0 } });
    for (let start = 0; start < 300; start += 10) {
      const group = new Set(Array.from({ length: 10 }, (_, i) => start + i));
      rerender({ active: start });
      act(() => result.current.setVisible(group));
      await waitFor(() => expect(result.current.thumbs[start + 9]).toBeDefined());
    }
    expect(Object.keys(result.current.thumbs).length).toBeLessThanOrEqual(MAX_THUMBS);
    // Y lo reciente sigue ahi.
    expect(result.current.thumbs[299]).toBeDefined();
  });

  it("una pagina que falla no se reintenta en bucle y las demas siguen", async () => {
    mocks.failPages = new Set([1]);
    const doc = fakeDoc(10);
    const { result } = renderHook(() => usePageThumbs(doc, 0));
    act(() => result.current.setVisible(new Set([0, 1, 2])));
    await waitFor(() => expect(result.current.thumbs[2]).toBeDefined());
    expect(pagesRendered().filter((p) => p === 1)).toHaveLength(1);
    expect(result.current.thumbs[1]).toBeUndefined();
  });

  it("otro documento: cache nueva, no se mezclan miniaturas", async () => {
    const first = fakeDoc(10);
    const second = fakeDoc(10);
    const { result, rerender } = renderHook(({ doc }) => usePageThumbs(doc, 0), { initialProps: { doc: first } });
    act(() => result.current.setVisible(new Set([0])));
    await waitFor(() => expect(result.current.thumbs[0]).toBeDefined());
    rerender({ doc: second });
    expect(result.current.thumbs[0]).toBeUndefined();
    await waitFor(() => expect(result.current.thumbs[0]).toBeDefined());
    expect(pagesRendered().filter((p) => p === 0)).toHaveLength(2);
  });

  it("sin documento (o desactivada) no hace nada", async () => {
    const { result } = renderHook(() => usePageThumbs(null, 0));
    act(() => result.current.setVisible(new Set([0])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.render).not.toHaveBeenCalled();
    expect(result.current.thumbs).toEqual({});
    const off = renderHook(() => usePageThumbs(fakeDoc(5), 0, false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.render).not.toHaveBeenCalled();
    expect(off.result.current.thumbs).toEqual({});
  });

  it("sin informacion de lo que se ve hace la activa y sus vecinas, no todo el documento", async () => {
    const doc = fakeDoc(300);
    const { result } = renderHook(() => usePageThumbs(doc, 100));
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(FALLBACK_RADIUS * 2 + 1));
    expect(pagesRendered().every((p) => Math.abs(p - 100) <= FALLBACK_RADIUS)).toBe(true);
  });
});
