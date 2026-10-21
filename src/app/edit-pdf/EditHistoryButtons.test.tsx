import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EditHistoryButtons } from "@/app/edit-pdf/EditHistoryButtons";

/** M6 · a: deshacer y rehacer como botones de 44 px de la barra del modo de PDF Pro en movil. */
function setup(options: { canUndo?: boolean; canRedo?: boolean } = {}) {
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  render(
    <EditHistoryButtons undoLabel="Deshacer" redoLabel="Rehacer" canUndo={options.canUndo ?? true} canRedo={options.canRedo ?? false} onUndo={onUndo} onRedo={onRedo} />,
  );
  return { onUndo, onRedo };
}

describe("EditHistoryButtons", () => {
  it("dos botones con nombre accesible, atajo y area tactil de 44 px", () => {
    setup();
    const undo = screen.getByRole("button", { name: "Deshacer" });
    const redo = screen.getByRole("button", { name: "Rehacer" });
    for (const button of [undo, redo]) {
      expect(button.className).toContain("size-11");
      expect(button.className).toContain("shrink-0");
    }
    expect(undo.getAttribute("aria-keyshortcuts")).toBe("Control+Z Meta+Z");
    expect(redo.getAttribute("aria-keyshortcuts")).toContain("Control+Y");
    expect(undo.getAttribute("title")).toBe("Deshacer (Ctrl+Z)");
    expect(undo.getAttribute("data-history-button")).toBe("undo");
    expect(redo.getAttribute("data-history-button")).toBe("redo");
  });

  it("los pulsa solo si hay historial; agotado usa aria-disabled (no disabled) y no hace nada", () => {
    const { onUndo, onRedo } = setup({ canUndo: true, canRedo: false });
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    const redo = screen.getByRole("button", { name: "Rehacer" });
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    expect(redo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(redo);
    expect(onRedo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Deshacer" }).hasAttribute("aria-disabled")).toBe(false);
  });
});
