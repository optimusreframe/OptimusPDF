import { describe, expect, it } from "vitest";
import {
  EDGE_MAX_SPEED,
  EDGE_ZONE_PX,
  createEdgeAutoScroller,
  edgeVelocity,
} from "@/lib/touch/edgeAutoScroll";
import { revealDelta } from "@/lib/touch/scrollRegion";

describe("edgeVelocity", () => {
  it("no desplaza en el centro de la zona visible", () => {
    expect(edgeVelocity(300, 100, 700)).toBe(0);
  });

  it("sube cerca del borde de arriba y baja cerca del de abajo, en rampa", () => {
    const edge = EDGE_ZONE_PX;
    expect(edgeVelocity(100 + edge / 2, 100, 700)).toBeCloseTo(-EDGE_MAX_SPEED / 2, 5);
    expect(edgeVelocity(100, 100, 700)).toBeCloseTo(-EDGE_MAX_SPEED, 5);
    expect(edgeVelocity(700 - edge / 2, 100, 700)).toBeCloseTo(EDGE_MAX_SPEED / 2, 5);
    expect(edgeVelocity(700, 100, 700)).toBeCloseTo(EDGE_MAX_SPEED, 5);
  });

  it("un dedo que se sale de la zona visible sigue acelerando hasta 1,25x y nunca mas", () => {
    expect(edgeVelocity(-500, 100, 700)).toBeCloseTo(-EDGE_MAX_SPEED * 1.25, 5);
    expect(edgeVelocity(5000, 100, 700)).toBeCloseTo(EDGE_MAX_SPEED * 1.25, 5);
  });

  it("una zona visible estrecha deja siempre un centro quieto", () => {
    expect(edgeVelocity(150, 100, 200)).toBe(0);
  });
});

/** Planificador de pruebas: `frames(n, dt)` ejecuta n fotogramas de dt ms. */
function fakeClock() {
  let time = 0;
  let next: ((time: number) => void) | null = null;
  return {
    now: () => time,
    request: (cb: (time: number) => void) => {
      next = cb;
      return 1;
    },
    cancel: () => {
      next = null;
    },
    frames(count: number, dt: number) {
      for (let i = 0; i < count; i += 1) {
        time += dt;
        const cb = next;
        next = null;
        cb?.(time);
      }
    },
    get pending() {
      return next !== null;
    },
  };
}

describe("createEdgeAutoScroller · por TIEMPO, no por fotograma", () => {
  function run(frameMs: number, seconds: number) {
    const clock = fakeClock();
    let scrolled = 0;
    const scroller = createEdgeAutoScroller({
      pointer: () => ({ x: 100, y: 700 }),
      region: () => ({ top: 100, bottom: 700, left: -Infinity, right: Infinity }),
      scroll: (_dx, dy) => {
        scrolled += dy;
        return { dx: 0, dy };
      },
      onTick: () => {},
      now: clock.now,
      request: clock.request,
      cancel: clock.cancel,
    });
    scroller.start();
    clock.frames(Math.round((seconds * 1000) / frameMs), frameMs);
    scroller.stop();
    return scrolled;
  }

  it("a 60 Hz y a 120 Hz recorre lo mismo en un segundo (con el dedo en el borde: ~640 px/s)", () => {
    const at60 = run(1000 / 60, 1);
    const at120 = run(1000 / 120, 1);
    expect(Math.abs(at60 - EDGE_MAX_SPEED)).toBeLessThan(12);
    expect(Math.abs(at120 - EDGE_MAX_SPEED)).toBeLessThan(12);
    expect(Math.abs(at60 - at120)).toBeLessThan(12);
  });

  it("un fotograma retrasado (pestana en segundo plano) no provoca un salto enorme", () => {
    const clock = fakeClock();
    let scrolled = 0;
    const scroller = createEdgeAutoScroller({
      pointer: () => ({ x: 0, y: 700 }),
      region: () => ({ top: 100, bottom: 700, left: -Infinity, right: Infinity }),
      scroll: (_dx, dy) => {
        scrolled += dy;
        return { dx: 0, dy };
      },
      onTick: () => {},
      now: clock.now,
      request: clock.request,
      cancel: clock.cancel,
    });
    scroller.start();
    clock.frames(1, 5000);
    // dt acotado a 50 ms: como mucho 640 * 0,05 = 32 px.
    expect(scrolled).toBeLessThanOrEqual(33);
  });

  it("sin dedo (null) se detiene solo; stop() es idempotente", () => {
    const clock = fakeClock();
    let point: { x: number; y: number } | null = { x: 0, y: 700 };
    const scroller = createEdgeAutoScroller({
      pointer: () => point,
      region: () => ({ top: 100, bottom: 700, left: -Infinity, right: Infinity }),
      scroll: (_dx, dy) => ({ dx: 0, dy }),
      onTick: () => {},
      now: clock.now,
      request: clock.request,
      cancel: clock.cancel,
    });
    scroller.start();
    scroller.start();
    clock.frames(2, 16);
    expect(scroller.running).toBe(true);
    point = null;
    clock.frames(1, 16);
    expect(clock.pending).toBe(false);
    scroller.stop();
    scroller.stop();
  });

  it("llama a onTick solo si de verdad se desplazo algo (al tope no hay nada que reaplicar)", () => {
    const clock = fakeClock();
    let ticks = 0;
    const scroller = createEdgeAutoScroller({
      pointer: () => ({ x: 0, y: 700 }),
      region: () => ({ top: 100, bottom: 700, left: -Infinity, right: Infinity }),
      scroll: () => ({ dx: 0, dy: 0 }),
      onTick: () => {
        ticks += 1;
      },
      now: clock.now,
      request: clock.request,
      cancel: clock.cancel,
    });
    scroller.start();
    clock.frames(30, 16);
    expect(ticks).toBe(0);
  });
});

describe("revealDelta", () => {
  const region = { top: 100, bottom: 700 };

  it("centra el objetivo en la zona libre (con margen)", () => {
    // Objetivo de 40 px que esta a 900: su centro (920) debe quedar en el centro de [112, 688] = 400.
    expect(revealDelta({ top: 900, bottom: 940 }, region)).toBeCloseTo(520, 5);
    // Objetivo por encima de la zona: delta negativo.
    expect(revealDelta({ top: -300, bottom: -260 }, region)).toBeCloseTo(-680, 5);
  });

  it("`nearest` no mueve lo que ya se ve y mueve lo justo lo que no", () => {
    expect(revealDelta({ top: 300, bottom: 340 }, region, { block: "nearest" })).toBe(0);
    expect(revealDelta({ top: 900, bottom: 940 }, region, { block: "nearest" })).toBe(940 - (700 - 12));
    expect(revealDelta({ top: 20, bottom: 60 }, region, { block: "nearest" })).toBe(20 - (100 + 12));
  });

  it("un objetivo mas alto que la zona alinea su borde de arriba", () => {
    expect(revealDelta({ top: 500, bottom: 1500 }, region)).toBe(500 - 112);
  });
});
