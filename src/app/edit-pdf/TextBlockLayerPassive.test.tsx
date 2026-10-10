import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { TextBlockLayer, type LayerHandlers } from "@/app/edit-pdf/TextBlockLayer";
import { makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { PINCH_START_EVENT } from "@/app/edit-pdf/useZoomGestures";

/** Con una herramienta de dibujo armada los bloques de texto no reciben puntero (W5-U4b). */

const s = EDIT_STRINGS.es.inline;
const A = makeBlock("p0-b0", { text: "Titulo", box: { x: 50, y: 780, width: 120, height: 20 } });

function handlers(): LayerHandlers {
  return {
    onSelect: vi.fn(),
    onBeginEdit: vi.fn(),
    onDelete: vi.fn(),
    onNudge: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onGesture: vi.fn(),
    onTabIntoBar: vi.fn(() => false),
  };
}

function mount(passive: boolean | undefined, selected = false) {
  const h = handlers();
  render(
    <TextBlockLayer
      metrics={metricsFor()}
      blocks={[A]}
      edits={[]}
      pending={null}
      selectedKey={selected ? "p0-b0" : null}
      editingKey={null}
      editingCover={null}
      coarse={false}
      passive={passive}
      strings={s}
      handlers={h}
    />,
  );
  return h;
}

const region = () => document.querySelector<HTMLElement>('[data-element-id="p0-b0"]')!;
afterEach(cleanup);

describe("TextBlockLayer: passive", () => {
  it("por defecto los bloques reciben el puntero", () => {
    mount(undefined);
    expect(region().className).toContain("pointer-events-auto");
    expect(region().className).not.toContain("pointer-events-none");
  });

  it("passive: la region no recibe el puntero", () => {
    mount(true);
    expect(region().className).toContain("pointer-events-none");
    expect(region().className).not.toContain("pointer-events-auto");
  });

  it("passive: los tiradores del bloque seleccionado tampoco", () => {
    mount(true, true);
    const handles = document.querySelectorAll<HTMLElement>("[data-resize-handle]");
    // (A es un bloque bajo: sus tiradores son externos y solo hay dos.)
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(handle.className).toContain("pointer-events-none");
  });

  it("passive sigue siendo alcanzable por teclado (enfocable y con sus atajos)", () => {
    const h = mount(true);
    expect(region().tabIndex).toBe(0);
    fireEvent.keyDown(region(), { key: "Delete" });
    expect(h.onDelete).toHaveBeenCalledWith("p0-b0");
  });

  it("un pellizco cancela el arrastre de un bloque en curso", () => {
    const h = mount(false, true);
    fireEvent.pointerDown(region(), { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.pointerMove(region(), { pointerId: 1, pointerType: "touch", clientX: 40, clientY: 30 });
    expect(h.onGesture).toHaveBeenCalledWith(true);
    act(() => {
      window.dispatchEvent(new Event(PINCH_START_EVENT));
    });
    fireEvent.pointerUp(region(), { pointerId: 1, pointerType: "touch", clientX: 40, clientY: 30 });
    expect(h.onMove).not.toHaveBeenCalled();
    expect(h.onGesture).toHaveBeenLastCalledWith(false);
  });
});
