import { describe, expect, it } from "vitest";
import { ALREADY_OPTIMIZED_TOLERANCE, isAlreadyOptimized } from "@/app/scan-to-pdf/sizeNote";

describe("isAlreadyOptimized", () => {
  it("dentro del 5 % de Original = ya optimizado (mas o menos)", () => {
    expect(ALREADY_OPTIMIZED_TOLERANCE).toBe(0.05);
    expect(isAlreadyOptimized(1_000_000, 1_000_000)).toBe(true);
    expect(isAlreadyOptimized(960_000, 1_000_000)).toBe(true);
    expect(isAlreadyOptimized(1_050_000, 1_000_000)).toBe(true);
    expect(isAlreadyOptimized(940_000, 1_000_000)).toBe(false);
    expect(isAlreadyOptimized(1_060_000, 1_000_000)).toBe(false);
    expect(isAlreadyOptimized(500_000, 1_000_000)).toBe(false);
  });
  it("sin base valida no afirma nada", () => {
    expect(isAlreadyOptimized(100, 0)).toBe(false);
    expect(isAlreadyOptimized(Number.NaN, 100)).toBe(false);
  });
});
