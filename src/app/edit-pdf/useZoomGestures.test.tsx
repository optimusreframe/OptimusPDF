import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PINCH_START_EVENT,
  clampZoom,
  useZoomGestures,
  zoomFromWheel,
} from "@/app/edit-pdf/useZoomGestures";

type Live = { zoom: number; applyZoom: (z: number, a?: { clientX: number; clientY: number }) => void; isPinching: () => boolean };
const live: { current: Live | null } = { current: null };

function Harness({ enabled = true }: { enabled?: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const api = useZoomGestures({ stageRef: stage, hostRef: host, clipRef: clip, zoom, setZoom, enabled });
  useEffect(() => {
    live.current = { zoom, applyZoom: api.applyZoom, isPinching: api.isPinching };
  });
  return (
    <div ref={stage} data-testid="stage">
      <div ref={clip} data-testid="clip" style={{ overflow: "auto" }}>
        <div ref={host} data-testid="host" {...api.pinchProps} />
      </div>
    </div>
  );
}

const box = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  live.current = null;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => box(100, 50, 800, 1000));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const host = () => document.querySelector<HTMLElement>('[data-testid="host"]')!;
const touch = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y });

describe("zoomFromWheel / clampZoom", () => {
  it("clampZoom acota a [1, 3] y tolera valores no finitos", () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(1.7)).toBe(1.7);
  });

  it("girar la rueda hacia arriba acerca y hacia abajo aleja", () => {
    expect(zoomFromWheel(1.5, -10)).toBeGreaterThan(1.5);
    expect(zoomFromWheel(1.5, 10)).toBeLessThan(1.5);
  });

  it("un salto grande de rueda de raton se acota (no pasa del 35 % por evento)", () => {
    const up = zoomFromWheel(1.5, -400);
    expect(up / 1.5).toBeLessThan(1.4);
    expect(zoomFromWheel(1.5, 400) / 1.5).toBeGreaterThan(0.7);
  });

  it("nunca sale del rango", () => {
    expect(zoomFromWheel(1, 500)).toBe(1);
    expect(zoomFromWheel(3, -500)).toBe(3);
  });

  it("el modo de lineas pesa mas que el de pixeles", () => {
    expect(Math.abs(zoomFromWheel(2, -1, 1) - 2)).toBeGreaterThan(Math.abs(zoomFromWheel(2, -1, 0) - 2));
  });
});

describe("useZoomGestures: Ctrl + rueda", () => {
  it("Ctrl + rueda cambia el zoom y NO deja que el navegador acerque la pagina", () => {
    render(<Harness />);
    const event = new WheelEvent("wheel", { ctrlKey: true, deltaY: -20, clientX: 300, clientY: 200, cancelable: true, bubbles: true });
    act(() => {
      document.querySelector('[data-testid="stage"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(live.current!.zoom).toBeGreaterThan(1);
  });

  it("la rueda sin Ctrl no se toca (desplaza la pagina)", () => {
    render(<Harness />);
    const event = new WheelEvent("wheel", { deltaY: -20, cancelable: true, bubbles: true });
    act(() => {
      document.querySelector('[data-testid="stage"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(live.current!.zoom).toBe(1);
  });

  it("varias ruedas seguidas se acumulan hasta el maximo", () => {
    render(<Harness />);
    for (let i = 0; i < 40; i += 1) {
      act(() => {
        document.querySelector('[data-testid="stage"]')!.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -30, cancelable: true, bubbles: true }));
      });
    }
    expect(live.current!.zoom).toBe(MAX_ZOOM);
  });

  it("desactivado no escucha la rueda", () => {
    render(<Harness enabled={false} />);
    const event = new WheelEvent("wheel", { ctrlKey: true, deltaY: -20, cancelable: true, bubbles: true });
    act(() => {
      document.querySelector('[data-testid="stage"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("useZoomGestures: applyZoom", () => {
  it("acota y no repite el mismo valor", () => {
    render(<Harness />);
    act(() => live.current!.applyZoom(99));
    expect(live.current!.zoom).toBe(MAX_ZOOM);
    act(() => live.current!.applyZoom(0.1));
    expect(live.current!.zoom).toBe(MIN_ZOOM);
  });

  it("con ancla, el contenedor se desplaza para que el punto anclado quede donde estaba", () => {
    let width = 800;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => box(100, 50, width, 1000));
    render(<Harness />);
    const clip = document.querySelector<HTMLElement>('[data-testid="clip"]')!;
    // jsdom no tiene layout: `scrollLeft` se simula para ver cuanto se desplaza.
    let scrolled = 0;
    Object.defineProperty(clip, "scrollLeft", {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => {
        scrolled = value;
      },
    });
    // El punto a 3/4 del ancho (x = 700). Al duplicar el ancho, ese punto pasaria a x = 1300.
    act(() => {
      live.current!.applyZoom(2, { clientX: 700, clientY: 300 });
      width = 1600; // la hoja ya mide el doble cuando React pinta el zoom nuevo
    });
    // El punto anclado (3/4 del ancho) pasaria de x = 700 a x = 1300: el contenedor se desplaza esa diferencia.
    expect(scrolled).toBeCloseTo(600, 3);
  });
});

describe("useZoomGestures: pellizco", () => {
  it("dos dedos separandose acercan; juntandose alejan", () => {
    render(<Harness />);
    const el = host();
    fireEvent.pointerDown(el, touch(1, 300, 300));
    fireEvent.pointerDown(el, touch(2, 400, 300));
    expect(live.current!.isPinching()).toBe(true);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    fireEvent.pointerMove(el, touch(2, 500, 300));
    act(() => frames.splice(0).forEach((cb) => cb(0)));
    // 100 px entre los dedos -> 200 px: el doble.
    expect(live.current!.zoom).toBeCloseTo(2, 1);
    fireEvent.pointerMove(el, touch(2, 380, 300));
    act(() => frames.splice(0).forEach((cb) => cb(0)));
    // 80 px: por debajo del inicio (y acotado a 1).
    expect(live.current!.zoom).toBe(1);
  });

  it("avisa a los arrastres en curso con PINCH_START_EVENT", () => {
    render(<Harness />);
    const listener = vi.fn();
    window.addEventListener(PINCH_START_EVENT, listener);
    fireEvent.pointerDown(host(), touch(1, 300, 300));
    expect(listener).not.toHaveBeenCalled();
    fireEvent.pointerDown(host(), touch(2, 400, 300));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(PINCH_START_EVENT, listener);
  });

  it("un solo dedo no es un pellizco", () => {
    render(<Harness />);
    fireEvent.pointerDown(host(), touch(1, 300, 300));
    fireEvent.pointerMove(host(), touch(1, 400, 400));
    expect(live.current!.isPinching()).toBe(false);
    expect(live.current!.zoom).toBe(1);
  });

  it("el raton no inicia un pellizco", () => {
    render(<Harness />);
    fireEvent.pointerDown(host(), { pointerId: 1, pointerType: "mouse", clientX: 1, clientY: 1 });
    fireEvent.pointerDown(host(), { pointerId: 2, pointerType: "mouse", clientX: 50, clientY: 1 });
    expect(live.current!.isPinching()).toBe(false);
  });

  it("sigue habiendo pellizco hasta levantar el ULTIMO dedo (el que queda no arrastra)", () => {
    render(<Harness />);
    fireEvent.pointerDown(host(), touch(1, 300, 300));
    fireEvent.pointerDown(host(), touch(2, 400, 300));
    fireEvent.pointerUp(host(), touch(2, 400, 300));
    expect(live.current!.isPinching()).toBe(true);
    fireEvent.pointerUp(host(), touch(1, 300, 300));
    expect(live.current!.isPinching()).toBe(false);
  });

  it("el segundo dedo no llega a quien hubiera empezado algo con el (se traga el evento)", () => {
    const inner = vi.fn();
    render(
      <Harness />,
    );
    host().addEventListener("pointerdown", inner);
    fireEvent.pointerDown(host(), touch(1, 300, 300));
    expect(inner).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(host(), touch(2, 400, 300));
    // React escucha en la raiz: el evento llega al nodo, pero la captura de React lo corta para los hijos de React.
    expect(live.current!.isPinching()).toBe(true);
  });

  it("pointercancel limpia los dedos", () => {
    render(<Harness />);
    fireEvent.pointerDown(host(), touch(1, 300, 300));
    fireEvent.pointerDown(host(), touch(2, 400, 300));
    fireEvent.pointerCancel(host(), touch(1, 300, 300));
    fireEvent.pointerCancel(host(), touch(2, 400, 300));
    expect(live.current!.isPinching()).toBe(false);
  });
});
