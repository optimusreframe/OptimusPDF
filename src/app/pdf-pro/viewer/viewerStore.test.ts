import { describe, expect, it, vi } from "vitest";
import { createViewerStore, EMPTY_VIEWER_STATE, type ViewerImpl } from "@/app/pdf-pro/viewer/viewerStore";
import { VIEWER_MAX_ZOOM, VIEWER_MIN_ZOOM } from "@/app/pdf-pro/viewer/viewerTypes";

function storeWith(pages: number) {
  const store = createViewerStore();
  store.setPageCount(pages);
  return store;
}

function fakeImpl(): ViewerImpl & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scrollToPage: vi.fn((index: number) => {
      calls.push(`scroll:${index}`);
    }),
    captureZoomAnchor: vi.fn(() => {
      calls.push("capture");
      return { page: 2, fy: 0.5, fx: 0.5, vx: 10, vy: 20 };
    }),
    focus: vi.fn(() => {
      calls.push("focus");
    }),
  };
}

describe("estado inicial y suscripcion", () => {
  it("arranca vacio, en zoom 1 (ajustar al ancho) y sin seleccion", () => {
    const store = createViewerStore();
    expect(store.getState()).toBe(EMPTY_VIEWER_STATE);
    expect(store.getZoom()).toBe(1);
    expect(store.isFitWidth()).toBe(true);
    expect(store.getSelectedPages()).toEqual([]);
    expect(store.getVisiblePages()).toEqual([]);
  });

  it("notifica a los suscriptores solo cuando algo cambia y permite darse de baja", () => {
    const store = storeWith(5);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.setCurrentPage(2);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setCurrentPage(2);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.setCurrentPage(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("cada cambio crea un estado nuevo (inmutable) para useSyncExternalStore", () => {
    const store = storeWith(5);
    const before = store.getState();
    store.setCurrentPage(4);
    expect(store.getState()).not.toBe(before);
    expect(before.currentPage).toBe(0);
  });
});

describe("pagina actual y paginas visibles", () => {
  it("setCurrentPage se acota al documento", () => {
    const store = storeWith(10);
    store.setCurrentPage(99);
    expect(store.getCurrentPage()).toBe(9);
    store.setCurrentPage(-4);
    expect(store.getCurrentPage()).toBe(0);
  });

  it("al reducirse el documento la pagina actual se acota", () => {
    const store = storeWith(10);
    store.setCurrentPage(8);
    store.setPageCount(4);
    expect(store.getCurrentPage()).toBe(3);
    expect(store.getPageCount()).toBe(4);
  });

  it("setVisiblePages ignora una lista igual y getVisiblePages devuelve una copia", () => {
    const store = storeWith(10);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setVisiblePages([2, 3]);
    store.setVisiblePages([2, 3]);
    expect(listener).toHaveBeenCalledTimes(1);
    const copy = store.getVisiblePages();
    copy.push(99);
    expect(store.getVisiblePages()).toEqual([2, 3]);
  });

  it("las visibles fuera del nuevo tamano se descartan", () => {
    const store = storeWith(10);
    store.setVisiblePages([7, 8, 9]);
    store.setPageCount(8);
    expect(store.getVisiblePages()).toEqual([7]);
  });
});

describe("scrollToPage", () => {
  it("acota el indice, actualiza la pagina actual y delega en el visor", () => {
    const store = storeWith(10);
    const impl = fakeImpl();
    store.attach(impl);
    store.scrollToPage(99, { focus: true });
    expect(store.getCurrentPage()).toBe(9);
    expect(impl.scrollToPage).toHaveBeenCalledWith(9, { focus: true });
    store.scrollToPage(-3);
    expect(impl.scrollToPage).toHaveBeenLastCalledWith(0, {});
  });

  it("sin documento no hace nada", () => {
    const store = createViewerStore();
    const impl = fakeImpl();
    store.attach(impl);
    store.scrollToPage(3);
    expect(impl.scrollToPage).not.toHaveBeenCalled();
  });

  it("sin visor acoplado solo actualiza el estado (no falla)", () => {
    const store = storeWith(5);
    expect(() => store.scrollToPage(3)).not.toThrow();
    expect(store.getCurrentPage()).toBe(3);
  });

  it("al desacoplar el visor ya no se le llama", () => {
    const store = storeWith(5);
    const impl = fakeImpl();
    const detach = store.attach(impl);
    detach();
    store.scrollToPage(2);
    expect(impl.scrollToPage).not.toHaveBeenCalled();
  });

  it("el desplazamiento del usuario avisa como «scroll» solo si la pagina cambio (no al recolocar el visor)", () => {
    const store = storeWith(10);
    const listener = vi.fn();
    store.setNavigationListener(listener);
    store.setCurrentPage(3, true);
    store.setCurrentPage(3, true);
    store.setCurrentPage(5);
    expect(listener.mock.calls).toEqual([["scroll"]]);
  });

  it("avisa al oyente de navegacion (anuncios) con el tipo de cambio", () => {
    const store = storeWith(5);
    const listener = vi.fn();
    store.setNavigationListener(listener);
    store.scrollToPage(1);
    store.setZoom(2);
    expect(listener.mock.calls).toEqual([["page"], ["zoom"]]);
    store.setNavigationListener(null);
    store.scrollToPage(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("focus delega en el visor", () => {
    const store = storeWith(5);
    const impl = fakeImpl();
    store.attach(impl);
    store.focus();
    expect(impl.focus).toHaveBeenCalled();
  });
});

describe("zoom", () => {
  it("setZoom acota a 0,5-4 y marca «ajustar al ancho» solo en 1", () => {
    const store = storeWith(5);
    store.setZoom(9);
    expect(store.getZoom()).toBe(VIEWER_MAX_ZOOM);
    expect(store.isFitWidth()).toBe(false);
    store.setZoom(0.01);
    expect(store.getZoom()).toBe(VIEWER_MIN_ZOOM);
    store.setZoom(1);
    expect(store.isFitWidth()).toBe(true);
  });

  it("un zoom igual al actual no cambia nada ni captura ancla", () => {
    const store = storeWith(5);
    const impl = fakeImpl();
    store.attach(impl);
    store.setZoom(1);
    expect(impl.captureZoomAnchor).not.toHaveBeenCalled();
  });

  it("captura el ancla ANTES de cambiar el estado y se recoge una sola vez", () => {
    const store = storeWith(5);
    const impl = fakeImpl();
    store.attach(impl);
    const seen: number[] = [];
    store.subscribe(() => seen.push(impl.calls.length));
    store.setZoom(2, { clientX: 5, clientY: 6 });
    expect(impl.calls).toEqual(["capture"]);
    expect(impl.captureZoomAnchor).toHaveBeenCalledWith({ clientX: 5, clientY: 6 });
    expect(seen).toEqual([1]);
    expect(store.takePendingAnchor()).toEqual({ page: 2, fy: 0.5, fx: 0.5, vx: 10, vy: 20 });
    expect(store.takePendingAnchor()).toBeNull();
  });

  it("zoomIn y zoomOut siguen los pasos oficiales", () => {
    const store = storeWith(5);
    store.zoomIn();
    expect(store.getZoom()).toBe(1.25);
    store.zoomIn();
    expect(store.getZoom()).toBe(1.5);
    store.zoomOut();
    store.zoomOut();
    store.zoomOut();
    expect(store.getZoom()).toBe(0.75);
  });

  it("fitWidth vuelve a 1", () => {
    const store = storeWith(5);
    store.setZoom(3);
    store.fitWidth();
    expect(store.getZoom()).toBe(1);
    expect(store.isFitWidth()).toBe(true);
  });

  it("el zoom sobrevive a un cambio de documento (snapshot) y al reset", () => {
    const store = storeWith(5);
    store.setZoom(2);
    store.setPageCount(7);
    expect(store.getZoom()).toBe(2);
    store.reset();
    expect(store.getZoom()).toBe(2);
    expect(store.getPageCount()).toBe(0);
  });
});

describe("seleccion de paginas", () => {
  it("setSelectedPages descarta indices invalidos y fuera de rango", () => {
    const store = storeWith(5);
    store.setSelectedPages([0, 2, 9, -1, 1.5, 4]);
    expect(store.getSelectedPages()).toEqual([0, 2, 4]);
  });

  it("togglePage alterna", () => {
    const store = storeWith(5);
    store.togglePage(2);
    store.togglePage(3);
    expect(store.getSelectedPages()).toEqual([2, 3]);
    store.togglePage(2);
    expect(store.getSelectedPages()).toEqual([3]);
  });

  it("togglePage ignora indices fuera del documento", () => {
    const store = storeWith(3);
    store.togglePage(7);
    store.togglePage(-1);
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("selectRange parte del ancla de la ultima seleccion y la mantiene", () => {
    const store = storeWith(10);
    store.togglePage(2);
    store.selectRange(5);
    expect(store.getSelectedPages()).toEqual([2, 3, 4, 5]);
    store.selectRange(0);
    expect(store.getSelectedPages()).toEqual([0, 1, 2]);
  });

  it("selectRange sin ancla parte de la pagina actual", () => {
    const store = storeWith(10);
    store.setCurrentPage(4);
    store.selectRange(6);
    expect(store.getSelectedPages()).toEqual([4, 5, 6]);
  });

  it("selectAll y clearSelection", () => {
    const store = storeWith(4);
    store.selectAll();
    expect(store.getSelectedPages()).toEqual([0, 1, 2, 3]);
    store.clearSelection();
    expect(store.getSelectedPages()).toEqual([]);
  });

  it("clearSelection sin seleccion no notifica", () => {
    const store = storeWith(4);
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearSelection();
    expect(listener).not.toHaveBeenCalled();
  });

  it("al reducirse el documento se podan las paginas seleccionadas que ya no existen", () => {
    const store = storeWith(10);
    store.setSelectedPages([1, 8, 9]);
    store.setPageCount(5);
    expect(store.getSelectedPages()).toEqual([1]);
  });

  it("una seleccion igual a la actual no notifica", () => {
    const store = storeWith(5);
    store.setSelectedPages([1, 2]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSelectedPages([2, 1]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("getSelectedPages devuelve una lista ordenada y nueva", () => {
    const store = storeWith(10);
    store.setSelectedPages([7, 1, 4]);
    const list = store.getSelectedPages();
    expect(list).toEqual([1, 4, 7]);
    list.push(0);
    expect(store.getSelectedPages()).toEqual([1, 4, 7]);
  });
});

describe("capas y barras registradas por los modos", () => {
  it("la ultima capa registrada manda y al retirarla vuelve la anterior", () => {
    const store = storeWith(3);
    const first = vi.fn(() => null);
    const second = vi.fn(() => null);
    const offFirst = store.registerOverlay(first);
    const offSecond = store.registerOverlay(second);
    expect(store.getOverlay()).toBe(second);
    offSecond();
    expect(store.getOverlay()).toBe(first);
    offFirst();
    expect(store.getOverlay()).toBeNull();
  });

  it("registrar o retirar una capa cambia slotVersion (el visor repinta)", () => {
    const store = storeWith(3);
    const before = store.getState().slotVersion;
    const off = store.registerOverlay(() => null);
    expect(store.getState().slotVersion).toBe(before + 1);
    off();
    expect(store.getState().slotVersion).toBe(before + 2);
    off();
    expect(store.getState().slotVersion).toBe(before + 2);
  });

  it("la barra de pagina funciona igual", () => {
    const store = storeWith(3);
    const toolbar = vi.fn(() => null);
    const off = store.registerPageToolbar(toolbar);
    expect(store.getPageToolbar()).toBe(toolbar);
    off();
    expect(store.getPageToolbar()).toBeNull();
  });
});
