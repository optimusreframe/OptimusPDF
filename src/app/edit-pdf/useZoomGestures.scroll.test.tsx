import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useZoomGestures, type UseZoomGestures } from "@/app/edit-pdf/useZoomGestures";

/**
 * Acercar con un ancla mantiene el punto bajo ella. Dentro de PDF Pro (Wave 7 · U6) el ajuste vertical va a la
 * region con scroll propio (`scrollRef`) y no a la ventana.
 */

const state = { live: null as unknown as UseZoomGestures, zoom: 1 };

function Harness({ withScroll }: { withScroll: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gestures = useZoomGestures({
    stageRef,
    hostRef,
    clipRef,
    zoom: state.zoom,
    setZoom: (value) => {
      state.zoom = value;
    },
    scrollRef: withScroll ? scrollRef : undefined,
  });
  useEffect(() => {
    state.live = gestures;
  });
  return (
    <div ref={scrollRef} data-scroll="">
      <div ref={stageRef}>
        <div ref={clipRef}>
          <div ref={hostRef} data-host="" />
        </div>
      </div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.zoom = 1;
});

describe("useZoomGestures con region de scroll propia", () => {
  it("el ajuste vertical tras acercar va a la region (scrollTop) y no a la ventana", () => {
    const windowScroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    let hostTop = 100;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-host")) {
        return { left: 0, top: hostTop, width: 400, height: 800, right: 400, bottom: hostTop + 800, x: 0, y: hostTop, toJSON: () => ({}) } as DOMRect;
      }
      return { left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const { container, rerender } = render(<Harness withScroll />);
    const scroller = container.querySelector<HTMLElement>("[data-scroll]")!;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;
    act(() => state.live.applyZoom(2, { clientX: 200, clientY: 300 }));
    // La hoja crecio: el punto anclado se movio 200 px hacia abajo.
    hostTop = -100;
    rerender(<Harness withScroll />);
    expect(windowScroll).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0][0].top).toBeLessThan(0);
  });

  it("sin region el ajuste vertical sigue yendo a la ventana", () => {
    const windowScroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    let hostTop = 100;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.hasAttribute("data-host")) {
        return { left: 0, top: hostTop, width: 400, height: 800, right: 400, bottom: hostTop + 800, x: 0, y: hostTop, toJSON: () => ({}) } as DOMRect;
      }
      return { left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const { rerender } = render(<Harness withScroll={false} />);
    act(() => state.live.applyZoom(2, { clientX: 200, clientY: 300 }));
    hostTop = -100;
    rerender(<Harness withScroll={false} />);
    expect(windowScroll).toHaveBeenCalled();
  });
});
