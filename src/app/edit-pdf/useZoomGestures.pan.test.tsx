import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useZoomGestures } from "@/app/edit-pdf/useZoomGestures";

/**
 * M5 · GE-01: con una herramienta armada la hoja lleva `touch-action: none` (el dedo dibuja) y el navegador no desplaza con dos
 * dedos: el hook lo hace a mano con el movimiento del centro de los dos dedos (vertical a la region con scroll, horizontal a la
 * tarjeta con zoom). Sin `touch-action: none` lo hace el propio navegador y el hook NO duplica el desplazamiento.
 */
const scroller = { scrollBy: vi.fn() };

function Harness() {
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(2);
  const api = useZoomGestures({ stageRef: stage, hostRef: host, clipRef: clip, zoom, setZoom, scrollRef });
  return (
    <div ref={scrollRef} data-testid="scroller">
      <div ref={stage}>
        <div ref={clip} data-testid="clip">
          <div ref={host} data-testid="host" {...api.pinchProps} />
        </div>
      </div>
    </div>
  );
}

const touch = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y });
const host = () => document.querySelector<HTMLElement>('[data-testid="host"]')!;

function twoFingersDrag(dx: number, dy: number) {
  fireEvent.pointerDown(host(), touch(1, 100, 300));
  fireEvent.pointerDown(host(), touch(2, 200, 300));
  for (let step = 1; step <= 4; step += 1) {
    fireEvent.pointerMove(host(), touch(1, 100 + (dx * step) / 4, 300 + (dy * step) / 4));
    fireEvent.pointerMove(host(), touch(2, 200 + (dx * step) / 4, 300 + (dy * step) / 4));
  }
  fireEvent.pointerUp(host(), touch(1, 100 + dx, 300 + dy));
  fireEvent.pointerUp(host(), touch(2, 200 + dx, 300 + dy));
}

function stubTouchAction(value: string) {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = real(element, pseudo);
    if (element instanceof HTMLElement && element.dataset.testid === "host") {
      return new Proxy(style, { get: (target, key) => (key === "touchAction" ? value : Reflect.get(target, key)) });
    }
    return style;
  });
}

beforeEach(() => {
  scroller.scrollBy.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useZoomGestures · dos dedos desplazan con una herramienta armada", () => {
  it("con `touch-action: none` el centro de los dos dedos desplaza la region con scroll (el contenido sigue a los dedos)", () => {
    stubTouchAction("none");
    render(<Harness />);
    const region = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    region.scrollBy = scroller.scrollBy as unknown as typeof region.scrollBy;
    twoFingersDrag(0, -80);
    const total = scroller.scrollBy.mock.calls.reduce((sum, [options]) => sum + (options as { top: number }).top, 0);
    // Los dedos suben 80 px: la hoja sube con ellos (el scroll crece 80).
    expect(total).toBeCloseTo(80, 5);
    for (const [options] of scroller.scrollBy.mock.calls) expect((options as ScrollToOptions).behavior).toBe("instant");
  });

  it("con zoom el movimiento horizontal mueve la tarjeta (scrollLeft) en sentido contrario al de los dedos", () => {
    stubTouchAction("none");
    render(<Harness />);
    const clip = document.querySelector<HTMLElement>('[data-testid="clip"]')!;
    clip.scrollLeft = 200;
    twoFingersDrag(-60, 0);
    // jsdom conserva scrollLeft como propiedad asignable: los dedos van 60 px a la izquierda, la tarjeta avanza 60.
    expect(clip.scrollLeft).toBe(260);
  });

  it("sin `touch-action: none` el navegador ya desplaza: el hook no duplica el movimiento", () => {
    stubTouchAction("pan-y");
    render(<Harness />);
    const region = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    region.scrollBy = scroller.scrollBy as unknown as typeof region.scrollBy;
    twoFingersDrag(0, -80);
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("un solo dedo nunca desplaza a mano", () => {
    stubTouchAction("none");
    render(<Harness />);
    const region = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    region.scrollBy = scroller.scrollBy as unknown as typeof region.scrollBy;
    fireEvent.pointerDown(host(), touch(1, 100, 300));
    fireEvent.pointerMove(host(), touch(1, 100, 200));
    fireEvent.pointerUp(host(), touch(1, 100, 200));
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });
});
