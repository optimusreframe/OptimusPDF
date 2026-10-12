import { describe, expect, it } from "vitest";
import {
  allPages,
  describeSelection,
  isSelectionGesture,
  rangeBetween,
  toggled,
} from "@/app/pdf-pro/viewer/viewerSelection";

const mods = (ctrlKey = false, metaKey = false, shiftKey = false) => ({ ctrlKey, metaKey, shiftKey });

describe("seleccion de paginas", () => {
  it("Ctrl o Cmd con clic alterna; Mayus selecciona un rango; el clic sencillo no es un gesto de seleccion", () => {
    expect(isSelectionGesture(mods(true))).toEqual({ ctrl: true, shift: false });
    expect(isSelectionGesture(mods(false, true))).toEqual({ ctrl: true, shift: false });
    expect(isSelectionGesture(mods(false, false, true))).toEqual({ ctrl: false, shift: true });
    expect(isSelectionGesture(mods())).toBeNull();
  });

  it("Mayus gana a Ctrl (como en un gestor de archivos)", () => {
    expect(isSelectionGesture(mods(true, false, true))).toEqual({ ctrl: false, shift: true });
  });

  it("toggled anade y quita sin tocar el original", () => {
    const original = new Set([1, 2]);
    expect([...toggled(original, 3)].sort()).toEqual([1, 2, 3]);
    expect([...toggled(original, 2)]).toEqual([1]);
    expect([...original]).toEqual([1, 2]);
  });

  it("rangeBetween incluye los dos extremos en cualquier sentido", () => {
    expect([...rangeBetween(2, 5)]).toEqual([2, 3, 4, 5]);
    expect([...rangeBetween(5, 2)].sort()).toEqual([2, 3, 4, 5]);
    expect([...rangeBetween(3, 3)]).toEqual([3]);
  });

  it("allPages cubre 0..n-1", () => {
    expect([...allPages(4)]).toEqual([0, 1, 2, 3]);
    expect(allPages(0).size).toBe(0);
  });

  it("describeSelection resume en rangos de lectura (base 1)", () => {
    expect(describeSelection([0])).toBe("1");
    expect(describeSelection([0, 1])).toBe("1, 2");
    expect(describeSelection([0, 1, 2, 3])).toBe("1-4");
    expect(describeSelection([8, 0, 2, 3, 4])).toBe("1, 3-5, 9");
    expect(describeSelection([])).toBe("");
  });
});
