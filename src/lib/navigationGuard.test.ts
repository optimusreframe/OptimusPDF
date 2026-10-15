import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetNavigationGuardForTests,
  interceptNavigation,
  registerNavigationGuard,
  runWithoutNavigationGuard,
} from "@/lib/navigationGuard";

afterEach(__resetNavigationGuardForTests);

describe("guarda de navegacion (opt-in)", () => {
  it("sin guarda registrada la navegacion nunca se cancela", () => {
    expect(interceptNavigation("/merge-pdf", () => {})).toBe(false);
  });

  it("con guarda: recibe el destino y un `proceed`, y su veredicto manda", () => {
    const guard = vi.fn(() => true);
    registerNavigationGuard(guard);
    const proceed = vi.fn();
    expect(interceptNavigation("/merge-pdf", proceed)).toBe(true);
    expect(guard).toHaveBeenCalledWith("/merge-pdf", proceed);
    guard.mockReturnValue(false);
    expect(interceptNavigation("/", () => {})).toBe(false);
  });

  it("retirar la guarda deja pasar; una guarda mas nueva no la retira la antigua al limpiarse", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const removeFirst = registerNavigationGuard(first);
    const removeSecond = registerNavigationGuard(second);
    removeFirst();
    expect(interceptNavigation("/a", () => {})).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    removeSecond();
    expect(interceptNavigation("/a", () => {})).toBe(false);
  });

  it("`runWithoutNavigationGuard` deja pasar SOLO mientras dura la accion, tambien anidada y aunque lance", () => {
    const guard = vi.fn(() => true);
    registerNavigationGuard(guard);
    let inside: boolean | null = null;
    let nested: boolean | null = null;
    runWithoutNavigationGuard(() => {
      inside = interceptNavigation("/a", () => {});
      runWithoutNavigationGuard(() => {
        nested = interceptNavigation("/b", () => {});
      });
      // Al salir de la anidada sigue la exencion de la externa.
      expect(interceptNavigation("/c", () => {})).toBe(false);
    });
    expect(inside).toBe(false);
    expect(nested).toBe(false);
    expect(guard).not.toHaveBeenCalled();
    expect(interceptNavigation("/d", () => {})).toBe(true);
    expect(() =>
      runWithoutNavigationGuard(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(interceptNavigation("/e", () => {})).toBe(true);
  });
});
