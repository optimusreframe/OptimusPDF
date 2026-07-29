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

afterEach(cleanup);
