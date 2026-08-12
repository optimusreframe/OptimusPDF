import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Piezas que jsdom no implementa y de las que dependen los componentes
 * del lienzo (`FieldPlacer`, `EditCanvas`, `SignaturePlacer`): captura de
 * puntero y `ResizeObserver`. Sin ellas cualquier `pointerdown` revienta
 * antes de llegar a la logica que se quiere comprobar.
 */

if (!Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    const set = captured.get(this) ?? new Set<number>();
    set.add(id);
    captured.set(this, set);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(
    id: number,
  ) {
    captured.get(this)?.delete(id);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(
    id: number,
  ) {
    return captured.get(this)?.has(id) ?? false;
  };
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

/**
 * Node 22+ define `localStorage`/`sessionStorage` como globales propias
 * (detras de `--localstorage-file`) y esas globales tapan la
 * implementacion real de jsdom en `window.localStorage`: cualquier
 * acceso revienta con "Cannot read properties of undefined". Se
 * reemplaza por un Storage en memoria de verdad para que el codigo bajo
 * prueba (drafts, historial de valores, ajustes) pueda usarlo tal cual
 * lo haria en un navegador real.
 */
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(window, key, {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
  });
}

afterEach(cleanup);
