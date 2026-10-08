import { describe, expect, it } from "vitest";
import {
  appleSpring,
  crossFadeTransition,
  nearestSnapPoint,
  prefersReducedMotion,
  project,
  reducedAnimateOptions,
  reducedValueTransition,
  relativeVelocity,
  rubberband,
  shouldCommitGesture,
  springs,
  withCrossFadeOpacity,
  withVelocity,
} from "./motion";

describe("appleSpring", () => {
  it("convierte response 0.4 / damping 1 a la rigidez y amortiguacion de UIKit", () => {
    const s = appleSpring({ response: 0.4, dampingRatio: 1 });
    // stiffness = (2π/0.4)² = 246.74; damping = 4π/0.4 = 31.42
    expect(s.stiffness).toBeCloseTo(246.74, 2);
    expect(s.damping).toBeCloseTo(31.416, 3);
    expect(s.mass).toBe(1);
    expect(s.type).toBe("spring");
  });

  it("con dampingRatio 1 queda criticamente amortiguado: damping² = 4·k·m", () => {
    for (const response of [0.2, 0.3, 0.4, 0.5]) {
      const s = appleSpring({ response, dampingRatio: 1 });
      expect(s.damping ** 2).toBeCloseTo(4 * s.stiffness * s.mass, 6);
    }
  });

  it("con dampingRatio 0.8 queda subamortiguado (rebota)", () => {
    const s = appleSpring({ response: 0.3, dampingRatio: 0.8 });
    expect(s.stiffness).toBeCloseTo(438.65, 2);
    expect(s.damping).toBeCloseTo(33.51, 2);
    expect(s.damping ** 2).toBeLessThan(4 * s.stiffness * s.mass);
  });

  it("rechaza response <= 0 y dampingRatio negativo", () => {
    expect(() => appleSpring({ response: 0, dampingRatio: 1 })).toThrow(RangeError);
    expect(() => appleSpring({ response: -1, dampingRatio: 1 })).toThrow(RangeError);
    expect(() => appleSpring({ response: 0.3, dampingRatio: -0.1 })).toThrow(RangeError);
  });
});

describe("springs (presets)", () => {
  const ratio = (s: { stiffness: number; damping: number; mass: number }) =>
    s.damping / (2 * Math.sqrt(s.stiffness * s.mass));

  it("default, snappy y gentle no rebotan (ratio 1)", () => {
    expect(ratio(springs.default)).toBeCloseTo(1, 9);
    expect(ratio(springs.snappy)).toBeCloseTo(1, 9);
    expect(ratio(springs.gentle)).toBeCloseTo(1, 9);
  });

  it("momentum y sheet llevan ~0.8 de damping, solo para gestos con inercia", () => {
    expect(ratio(springs.momentum)).toBeCloseTo(0.8, 9);
    expect(ratio(springs.sheet)).toBeCloseTo(0.8, 9);
  });

  it("snappy responde mas rapido que default y default mas que gentle", () => {
    expect(springs.snappy.stiffness).toBeGreaterThan(springs.default.stiffness);
    expect(springs.default.stiffness).toBeGreaterThan(springs.gentle.stiffness);
  });
});

describe("withVelocity", () => {
  it("añade la velocidad del gesto sin alterar el spring", () => {
    const t = withVelocity(springs.default, -850);
    expect(t).toMatchObject({ ...springs.default, velocity: -850 });
  });

  it("normaliza velocidades no finitas a 0", () => {
    expect(withVelocity(springs.default, Number.NaN).velocity).toBe(0);
    expect(withVelocity(springs.default, Number.POSITIVE_INFINITY).velocity).toBe(0);
  });
});

describe("project (proyeccion de momentum)", () => {
  it("1000 px/s con rate 0.998 proyecta 499 px", () => {
    // (1000/1000) · 0.998 / 0.002 = 499
    expect(project(1000)).toBeCloseTo(499, 9);
  });

  it("500 px/s con rate 0.99 proyecta 49.5 px (mas corto)", () => {
    expect(project(500, 0.99)).toBeCloseTo(49.5, 9);
  });

  it("velocidad 0 proyecta 0", () => {
    expect(project(0)).toBe(0);
    expect(project(-0)).toBe(0);
  });

  it("conserva el signo de la velocidad", () => {
    expect(project(-1000)).toBeCloseTo(-499, 9);
    expect(project(-250, 0.99)).toBeCloseTo(-24.75, 9);
  });

  it("es lineal en la velocidad", () => {
    expect(project(2000)).toBeCloseTo(2 * project(1000), 9);
  });

  it("velocidad no finita proyecta 0", () => {
    expect(project(Number.NaN)).toBe(0);
  });

  it("rechaza rate fuera de (0, 1)", () => {
    expect(() => project(100, 1)).toThrow(RangeError);
    expect(() => project(100, 0)).toThrow(RangeError);
    expect(() => project(100, 1.5)).toThrow(RangeError);
  });
});

describe("rubberband", () => {
  it("overshoot 0 devuelve 0", () => {
    expect(rubberband(0, 300)).toBe(0);
  });

  it("100 px de exceso en 300 px de dimension se reducen a ~46.48 px", () => {
    // (100 · 300 · 0.55) / (300 + 0.55 · 100) = 16500 / 355
    expect(rubberband(100, 300)).toBeCloseTo(16500 / 355, 9);
  });

  it("acepta otra constante", () => {
    // (100 · 300 · 0.3) / (300 + 30) = 9000 / 330
    expect(rubberband(100, 300, 0.3)).toBeCloseTo(9000 / 330, 9);
  });

  it("es impar: mismo valor con signo cambiado", () => {
    expect(rubberband(-100, 300)).toBeCloseTo(-rubberband(100, 300), 9);
  });

  it("crece de forma monotona pero nunca supera la dimension", () => {
    let prev = 0;
    for (const o of [10, 50, 100, 500, 1000, 1e5, 1e7]) {
      const v = rubberband(o, 300);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThan(300);
      prev = v;
    }
    expect(rubberband(1e9, 300)).toBeCloseTo(300, 3);
  });

  it("sigue menos que 1:1 (resiste) en cualquier exceso positivo", () => {
    for (const o of [1, 20, 200]) {
      expect(rubberband(o, 300)).toBeLessThan(o);
    }
  });

  it("rechaza dimension <= 0, no finita o NaN (lanza RangeError, nunca NaN)", () => {
    expect(() => rubberband(10, 0)).toThrow(RangeError);
    expect(() => rubberband(10, -5)).toThrow(RangeError);
    expect(() => rubberband(10, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => rubberband(10, Number.NaN)).toThrow(RangeError);
  });

  it("rechaza constant <= 0", () => {
    expect(() => rubberband(10, 300, 0)).toThrow(RangeError);
    expect(() => rubberband(10, 300, -0.5)).toThrow(RangeError);
  });

  it("overshoot ±Infinity devuelve el limite ±dimension", () => {
    expect(rubberband(Number.POSITIVE_INFINITY, 300)).toBe(300);
    expect(rubberband(Number.NEGATIVE_INFINITY, 300)).toBe(-300);
  });

  it("overshoot NaN devuelve 0", () => {
    expect(rubberband(Number.NaN, 300)).toBe(0);
  });
});

describe("nearestSnapPoint", () => {
  it("elige el punto mas cercano", () => {
    expect(nearestSnapPoint(120, [0, 100, 300])).toBe(100);
    expect(nearestSnapPoint(260, [0, 100, 300])).toBe(300);
  });

  it("combinado con project: un flick corto salta al siguiente punto", () => {
    // Pos 40, velocidad 400 px/s => proyecta 40 + 199.6 = 239.6 => snap 300.
    const landing = 40 + project(400);
    expect(nearestSnapPoint(landing, [0, 100, 300])).toBe(300);
    // Sin velocidad, desde 40 vuelve a 0.
    expect(nearestSnapPoint(40 + project(0), [0, 100, 300])).toBe(0);
  });

  it("con empate gana el primero; sin puntos devuelve el valor", () => {
    expect(nearestSnapPoint(50, [0, 100])).toBe(0);
    expect(nearestSnapPoint(42, [])).toBe(42);
  });
});

describe("relativeVelocity", () => {
  it("normaliza por la distancia restante (50 px/s sobre 100 px = 0.5)", () => {
    expect(relativeVelocity(50, 50, 150)).toBe(0.5);
  });

  it("mantiene el signo relativo a la direccion del objetivo", () => {
    expect(relativeVelocity(50, 150, 50)).toBe(-0.5);
  });

  it("sin distancia restante devuelve 0", () => {
    expect(relativeVelocity(50, 100, 100)).toBe(0);
  });
});

describe("shouldCommitGesture", () => {
  it("con velocidad clara decide por el signo, no por la posicion", () => {
    expect(shouldCommitGesture({ velocity: 400, offset: 10, distance: 300 })).toBe(true);
    expect(shouldCommitGesture({ velocity: -400, offset: 290, distance: 300 })).toBe(false);
  });

  it("con el dedo quieto decide por la fraccion recorrida", () => {
    expect(shouldCommitGesture({ velocity: 0, offset: 149, distance: 300 })).toBe(false);
    expect(shouldCommitGesture({ velocity: 0, offset: 150, distance: 300 })).toBe(true);
  });

  it("distancia 0 nunca confirma", () => {
    expect(shouldCommitGesture({ velocity: 999, offset: 0, distance: 0 })).toBe(false);
  });
});

describe("reduced motion", () => {
  it("prefersReducedMotion devuelve false sin window (SSR / node)", () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it("crossFadeTransition es un fundido corto sin spring", () => {
    expect(crossFadeTransition).not.toHaveProperty("type", "spring");
    expect(crossFadeTransition.duration).toBeLessThanOrEqual(0.2);
  });

  it("reducedAnimateOptions añade reduceMotion sin mutar la entrada", () => {
    const options = { duration: 1 };
    const reduced = reducedAnimateOptions(options, true);
    expect(reduced).toEqual({ duration: 1, reduceMotion: true });
    expect(reducedAnimateOptions(options, false)).toEqual({ duration: 1, reduceMotion: false });
    expect(options).toEqual({ duration: 1 });
    expect(reduced).not.toBe(options);
  });

  it("reducedValueTransition salta al destino solo con reduced + posicional", () => {
    expect(reducedValueTransition(springs.default, true, true)).toEqual({ type: false });
    expect(reducedValueTransition(springs.default, true, false)).toBe(springs.default);
    expect(reducedValueTransition(springs.default, false, true)).toBe(springs.default);
    expect(reducedValueTransition(springs.default, false, false)).toBe(springs.default);
  });

  it("withCrossFadeOpacity deja el spring y pone fundido en opacity", () => {
    const t = withCrossFadeOpacity(springs.momentum);
    expect(t).toMatchObject({ ...springs.momentum, opacity: crossFadeTransition });
    expect(springs.momentum).not.toHaveProperty("opacity");
  });

  it("el destino del snap es el mismo con o sin movimiento reducido; solo cambia la transicion", () => {
    const points = [0, 100, 300];
    const x = 40;
    const v = 400;
    const landing = x + project(v);
    const targetReduced = nearestSnapPoint(landing, points);
    const targetFull = nearestSnapPoint(landing, points);
    expect(targetReduced).toBe(300);
    expect(targetReduced).toBe(targetFull);
    expect(reducedValueTransition(withVelocity(springs.momentum, v), true, true)).toEqual({ type: false });
    expect(reducedValueTransition(withVelocity(springs.momentum, v), false, true)).toMatchObject({
      type: "spring",
      velocity: v,
    });
  });
});
