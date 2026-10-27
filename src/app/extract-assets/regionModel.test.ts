import { describe, expect, it } from "vitest";
import { CROP_MIN_FRACTION, type CropFraction } from "@/app/sign-pdf/inkImportModel";
import {
  HANDLE_NAME_KEY,
  HANDLE_STEP,
  HANDLE_STEP_LARGE,
  NUDGE_ACTIONS,
  NUDGE_LABEL_KEY,
  NUDGE_STEP,
  REGION_HANDLES,
  applyNudge,
  handlePoint,
  keyDelta,
  moveHandle,
  nudgeHandle,
} from "@/app/extract-assets/regionModel";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";

/** Rectangulo de recorte (H13): ocho asas, teclado y botones de ajuste, todo puro y en fracciones de la pagina. */

const R: CropFraction = { x: 0.2, y: 0.4, width: 0.3, height: 0.1 };
const close = (rect: CropFraction, expected: CropFraction) => {
  for (const key of ["x", "y", "width", "height"] as const) expect(rect[key], key).toBeCloseTo(expected[key], 6);
};

describe("moveHandle", () => {
  it("una esquina cambia dos lados y deja quietos los opuestos", () => {
    close(moveHandle(R, "se", 0.7, 0.6), { x: 0.2, y: 0.4, width: 0.5, height: 0.2 });
    close(moveHandle(R, "nw", 0.1, 0.3), { x: 0.1, y: 0.3, width: 0.4, height: 0.2 });
    close(moveHandle(R, "ne", 0.6, 0.3), { x: 0.2, y: 0.3, width: 0.4, height: 0.2 });
    close(moveHandle(R, "sw", 0.1, 0.7), { x: 0.1, y: 0.4, width: 0.4, height: 0.3 });
  });
  it("un borde cambia SOLO su lado (el otro eje no se toca)", () => {
    close(moveHandle(R, "e", 0.9, 0.99), { x: 0.2, y: 0.4, width: 0.7, height: 0.1 });
    close(moveHandle(R, "w", 0.05, 0.99), { x: 0.05, y: 0.4, width: 0.45, height: 0.1 });
    close(moveHandle(R, "s", 0.01, 0.8), { x: 0.2, y: 0.4, width: 0.3, height: 0.4 });
    close(moveHandle(R, "n", 0.01, 0.1), { x: 0.2, y: 0.1, width: 0.3, height: 0.4 });
  });
  it("nunca baja del lado minimo ni cruza el lado opuesto, ni sale de la pagina", () => {
    for (const handle of REGION_HANDLES) {
      const squeezed = moveHandle(R, handle, handle.includes("w") ? 5 : handle.includes("e") ? -5 : 0.3, handle.includes("n") ? 5 : handle.includes("s") ? -5 : 0.45);
      expect(squeezed.width, handle).toBeGreaterThanOrEqual(CROP_MIN_FRACTION - 1e-9);
      expect(squeezed.height, handle).toBeGreaterThanOrEqual(CROP_MIN_FRACTION - 1e-9);
      expect(squeezed.x, handle).toBeGreaterThanOrEqual(0);
      expect(squeezed.y, handle).toBeGreaterThanOrEqual(0);
      expect(squeezed.x + squeezed.width, handle).toBeLessThanOrEqual(1 + 1e-9);
      expect(squeezed.y + squeezed.height, handle).toBeLessThanOrEqual(1 + 1e-9);
    }
    close(moveHandle(R, "e", -3, 0), { x: 0.2, y: 0.4, width: CROP_MIN_FRACTION, height: 0.1 });
    close(moveHandle(R, "e", 3, 0), { x: 0.2, y: 0.4, width: 0.8, height: 0.1 });
  });
});

describe("handlePoint y nudgeHandle", () => {
  it("el punto de cada asa", () => {
    expect(handlePoint(R, "nw")).toEqual({ x: 0.2, y: 0.4 });
    expect(handlePoint(R, "se").x).toBeCloseTo(0.5);
    expect(handlePoint(R, "se").y).toBeCloseTo(0.5);
    expect(handlePoint(R, "n")).toEqual({ x: 0.2 + 0.15, y: 0.4 });
    expect(handlePoint(R, "w")).toEqual({ x: 0.2, y: 0.4 + 0.05 });
    expect(handlePoint(R, "e").x).toBeCloseTo(0.5);
    expect(handlePoint(R, "s").y).toBeCloseTo(0.5);
  });
  it("las flechas mueven el asa y un asa de borde ignora el eje que no es suyo", () => {
    close(nudgeHandle(R, "nw", -0.05, -0.05), { x: 0.15, y: 0.35, width: 0.35, height: 0.15 });
    close(nudgeHandle(R, "e", 0.05, 0.3), { x: 0.2, y: 0.4, width: 0.35, height: 0.1 });
    close(nudgeHandle(R, "s", 0.3, 0.05), { x: 0.2, y: 0.4, width: 0.3, height: 0.15 });
    close(nudgeHandle(R, "w", 0.02, 0.5), { x: 0.22, y: 0.4, width: 0.28, height: 0.1 });
    close(nudgeHandle(R, "n", 0.5, -0.02), { x: 0.2, y: 0.38, width: 0.3, height: 0.12 });
  });
  it("una esquina se mueve en los dos ejes (cada esquina, no solo la inferior derecha)", () => {
    for (const handle of ["nw", "ne", "se", "sw"] as const) {
      const moved = nudgeHandle(R, handle, 0.03, 0.03);
      expect(moved.x !== R.x || moved.width !== R.width, handle).toBe(true);
      expect(moved.y !== R.y || moved.height !== R.height, handle).toBe(true);
    }
  });
});

describe("keyDelta", () => {
  it("1 % por flecha y 5 % con Mayus; otras teclas, nada", () => {
    expect(HANDLE_STEP).toBe(0.01);
    expect(HANDLE_STEP_LARGE).toBe(0.05);
    expect(keyDelta("ArrowLeft", false)).toEqual({ dx: -0.01, dy: 0 });
    expect(keyDelta("ArrowRight", true)).toEqual({ dx: 0.05, dy: 0 });
    expect(keyDelta("ArrowUp", false)).toEqual({ dx: 0, dy: -0.01 });
    expect(keyDelta("ArrowDown", true)).toEqual({ dx: 0, dy: 0.05 });
    expect(keyDelta("Enter", false)).toBeNull();
    expect(keyDelta("a", true)).toBeNull();
  });
});

describe("applyNudge · «Ajustar sin arrastrar»", () => {
  it("mover: 2 % por toque, sin cambiar el tamano y sin salir de la pagina", () => {
    expect(NUDGE_STEP).toBe(0.02);
    close(applyNudge(R, "left"), { x: 0.18, y: 0.4, width: 0.3, height: 0.1 });
    close(applyNudge(R, "right"), { x: 0.22, y: 0.4, width: 0.3, height: 0.1 });
    close(applyNudge(R, "up"), { x: 0.2, y: 0.38, width: 0.3, height: 0.1 });
    close(applyNudge(R, "down"), { x: 0.2, y: 0.42, width: 0.3, height: 0.1 });
    expect(applyNudge({ x: 0, y: 0, width: 0.3, height: 0.1 }, "left").x).toBe(0);
    expect(applyNudge({ x: 0.7, y: 0.9, width: 0.3, height: 0.1 }, "down").y).toBeCloseTo(0.9);
  });
  it("ancho y alto: crecen o menguan 2 % manteniendo el centro", () => {
    close(applyNudge(R, "wider"), { x: 0.19, y: 0.4, width: 0.32, height: 0.1 });
    close(applyNudge(R, "narrower"), { x: 0.21, y: 0.4, width: 0.28, height: 0.1 });
    close(applyNudge(R, "taller"), { x: 0.2, y: 0.39, width: 0.3, height: 0.12 });
    close(applyNudge(R, "shorter"), { x: 0.2, y: 0.41, width: 0.3, height: 0.08 });
  });
  it("junto al borde no se sale: el rectangulo crece por el otro lado; nunca baja del minimo ni pasa de la pagina", () => {
    const edge = applyNudge({ x: 0, y: 0, width: 0.3, height: 0.1 }, "wider");
    expect(edge.x).toBe(0);
    expect(edge.width).toBeCloseTo(0.32);
    let tiny = { x: 0.4, y: 0.4, width: 0.06, height: 0.06 };
    for (let i = 0; i < 10; i += 1) tiny = applyNudge(applyNudge(tiny, "narrower"), "shorter");
    expect(tiny.width).toBeCloseTo(CROP_MIN_FRACTION, 6);
    expect(tiny.height).toBeCloseTo(CROP_MIN_FRACTION, 6);
    let big = R;
    for (let i = 0; i < 80; i += 1) big = applyNudge(applyNudge(big, "wider"), "taller");
    expect(big.width).toBeLessThanOrEqual(1);
    expect(big.x + big.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(big.y + big.height).toBeLessThanOrEqual(1 + 1e-9);
  });
  it("las ocho acciones y las ocho asas tienen texto en los dos idiomas", () => {
    expect(NUDGE_ACTIONS).toHaveLength(8);
    expect(REGION_HANDLES).toHaveLength(8);
    for (const dictionary of [es.extract, en.extract]) {
      for (const handle of REGION_HANDLES) expect(String(dictionary[HANDLE_NAME_KEY[handle]]).length).toBeGreaterThan(3);
      for (const action of NUDGE_ACTIONS) expect(String(dictionary[NUDGE_LABEL_KEY[action]]).length).toBeGreaterThan(3);
    }
  });
});
