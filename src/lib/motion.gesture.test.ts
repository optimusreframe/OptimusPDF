import { describe, expect, it } from "vitest";
import {
  createVelocityTracker,
  project,
  resolveSheetRelease,
  springs,
  velocityFromSamples,
} from "./motion";

/*
 * Logica pura de suelta del Sheet (W1-B). Lo que decide cerrar o volver
 * es el SIGNO de la velocidad, no la posicion, salvo dedo quieto.
 */

describe("velocityFromSamples", () => {
  it("con menos de dos muestras devuelve 0", () => {
    expect(velocityFromSamples([])).toBe(0);
    expect(velocityFromSamples([{ value: 10, time: 0 }])).toBe(0);
  });

  it("calcula la pendiente en px/s dentro de la ventana", () => {
    const samples = [
      { value: 0, time: 0 },
      { value: 50, time: 50 },
      { value: 100, time: 100 },
    ];
    expect(velocityFromSamples(samples, 100)).toBeCloseTo(1000);
  });

  it("ignora muestras mas viejas que la ventana", () => {
    const samples = [
      { value: 0, time: 0 },
      { value: 0, time: 500 }, // fuera de la ventana de 100 ms respecto a 650
      { value: 100, time: 600 },
      { value: 150, time: 650 },
    ];
    // Solo cuentan las muestras a <=100 ms de la ultima: 600 -> 650.
    expect(velocityFromSamples(samples, 100)).toBeCloseTo(1000);
  });

  it("conserva el signo (hacia arriba es negativo)", () => {
    const samples = [
      { value: 200, time: 0 },
      { value: 100, time: 100 },
    ];
    expect(velocityFromSamples(samples)).toBeCloseTo(-1000);
  });

  it("si el dedo lleva quieto mas de la ventana antes de soltar, la velocidad es 0", () => {
    const samples = [
      { value: 0, time: 0 },
      { value: 100, time: 100 },
    ];
    expect(velocityFromSamples(samples, 100, 400)).toBe(0);
    expect(velocityFromSamples(samples, 100, 150)).toBeCloseTo(1000);
  });
});

describe("createVelocityTracker", () => {
  it("descarta muestras fuera de la ventana y reporta la velocidad reciente", () => {
    const tracker = createVelocityTracker(100);
    tracker.push(0, 0);
    tracker.push(10, 300);
    tracker.push(60, 350);
    expect(tracker.size).toBe(2);
    expect(tracker.velocity()).toBeCloseTo(1000);
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.velocity()).toBe(0);
  });
});

describe("resolveSheetRelease", () => {
  const distance = 600;

  it("flick rapido hacia abajo cierra aunque el desplazamiento sea pequeño", () => {
    const decision = resolveSheetRelease({ offset: 40, velocity: 1500, distance });
    expect(decision.action).toBe("dismiss");
    expect(decision.target).toBe(distance);
    expect(decision.projected).toBeCloseTo(40 + project(1500));
  });

  it("velocidad hacia arriba vuelve aunque este mas alla de la mitad", () => {
    const decision = resolveSheetRelease({ offset: 450, velocity: -400, distance });
    expect(decision.action).toBe("settle");
    expect(decision.target).toBe(0);
  });

  it("dedo quieto: manda la posicion proyectada frente a la mitad del recorrido", () => {
    expect(resolveSheetRelease({ offset: 250, velocity: 0, distance }).action).toBe("settle");
    expect(resolveSheetRelease({ offset: 350, velocity: 0, distance }).action).toBe("dismiss");
  });

  it("dedo casi quieto justo bajo la mitad: la proyeccion lenta puede empujarlo a cerrar", () => {
    // 40 px/s proyecta ~20 px; 290 + 20 > 300.
    const decision = resolveSheetRelease({ offset: 290, velocity: 40, distance });
    expect(decision.projected).toBeGreaterThan(300);
    expect(decision.action).toBe("dismiss");
  });

  it("con inercia la transicion es springs.sheet con la velocidad heredada", () => {
    const decision = resolveSheetRelease({ offset: 100, velocity: 900, distance });
    expect(decision.transition).toMatchObject({ ...springs.sheet, velocity: 900 });
  });

  it("sin inercia la transicion es springs.default (sin rebote)", () => {
    const decision = resolveSheetRelease({ offset: 100, velocity: 10, distance });
    expect(decision.transition).toMatchObject({ ...springs.default, velocity: 10 });
  });

  it("con reduced motion el snap es instantaneo pero el destino es el mismo", () => {
    const decision = resolveSheetRelease({ offset: 100, velocity: 1500, distance, reduced: true });
    expect(decision.action).toBe("dismiss");
    expect(decision.target).toBe(distance);
    expect(decision.transition).toEqual({ type: false });
  });

  it("velocidad no finita se trata como 0", () => {
    const decision = resolveSheetRelease({ offset: 100, velocity: Number.NaN, distance });
    expect(decision.action).toBe("settle");
    expect(decision.transition).toMatchObject({ velocity: 0 });
  });

  it("recorrido invalido nunca cierra", () => {
    expect(resolveSheetRelease({ offset: 100, velocity: 2000, distance: 0 }).action).toBe("settle");
  });
});
