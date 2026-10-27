import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS, createGridDrag, type DragDeps, type DragLatest, type DragState } from "@/app/scan-to-pdf/gridDrag";
import { computeLayout } from "@/app/scan-to-pdf/gridLayout";

/** El sensor de arrastre sin React: el cuadro (layout) se calcula a mano y `getBoundingClientRect` devuelve el origen. */
function setup(overrides: Partial<DragLatest> = {}) {
  const layout = computeLayout(343);
  const states: Array<DragState | null> = [];
  const onDrop = vi.fn();
  const announce = vi.fn();
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 343, bottom: 800, width: 343, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(container);
  const latest: DragDeps["latest"] = {
    current: {
      layout,
      pageIds: ["a", "b", "c", "d"],
      selection: new Set(),
      onDrop,
      announce,
      dragStart: (n) => `mover ${n}`,
      dragCancel: "cancelado",
      insets: () => ({ top: 0, bottom: 0 }),
      ...overrides,
    },
  };
  const suppress = { current: false };
  const drag = createGridDrag({ latest, container: { current: container }, setDrag: (state) => states.push(state), suppressClick: suppress });
  return { drag, states, onDrop, announce, layout, suppress, container };
}

const move = (type: string, x: number, y: number, pointerId = 1) => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { pointerId: number; clientX: number; clientY: number };
  Object.assign(event, { pointerId, clientX: x, clientY: y });
  window.dispatchEvent(event);
  return event;
};

describe("createGridDrag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("raton: no arranca hasta moverse 5 px; despues sigue al puntero, calcula el hueco y suelta en el", () => {
    const { drag, states, onDrop, announce, layout } = setup();
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", false);
    move("pointermove", 12, 12);
    expect(states).toHaveLength(0);
    move("pointermove", 40, 20);
    expect(drag.active).toBe(true);
    expect(announce).toHaveBeenCalledWith("mover 1");
    // Mitad derecha de la segunda tarjeta (indice 1) -> hueco 2.
    move("pointermove", layout.tileW + 12 + layout.tileW - 4, 20);
    move("pointerup", layout.tileW + 12 + layout.tileW - 4, 20);
    expect(onDrop).toHaveBeenCalledWith(["a"], 2);
    expect(states[states.length - 1]).toBeNull();
    expect(drag.active).toBe(false);
    drag.dispose();
  });

  it("un clic sin mover no es un arrastre: no suelta nada, no suprime el clic", () => {
    const { drag, onDrop, suppress } = setup();
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", false);
    move("pointerup", 10, 10);
    expect(onDrop).not.toHaveBeenCalled();
    expect(suppress.current).toBe(false);
    drag.dispose();
  });

  it("tras arrastrar, el clic que sigue se suprime un turno", () => {
    const { drag, suppress } = setup();
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", false);
    move("pointermove", 60, 60);
    move("pointerup", 60, 60);
    expect(suppress.current).toBe(true);
    vi.runAllTimers();
    expect(suppress.current).toBe(false);
    drag.dispose();
  });

  it("Escape cancela y lo anuncia; pointercancel tambien", () => {
    const { drag, onDrop, announce } = setup();
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", false);
    move("pointermove", 80, 80);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith("cancelado");
    drag.start({ pointerId: 2, clientX: 10, clientY: 10 }, "b", false);
    move("pointermove", 80, 80, 2);
    move("pointercancel", 80, 80, 2);
    expect(onDrop).not.toHaveBeenCalled();
    drag.dispose();
  });

  it("ignora otros punteros (un segundo dedo no mueve ni suelta)", () => {
    const { drag, onDrop } = setup();
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", false);
    move("pointermove", 80, 80, 7);
    expect(drag.active).toBe(false);
    move("pointerup", 80, 80, 7);
    expect(onDrop).not.toHaveBeenCalled();
    drag.dispose();
  });

  it("arrastrar una tarjeta seleccionada arrastra TODA la seleccion en su orden", () => {
    const { drag, onDrop } = setup({ selection: new Set(["d", "b"]) });
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "d", false);
    move("pointermove", 90, 20);
    move("pointerup", 5, 5);
    expect(onDrop).toHaveBeenCalledWith(["b", "d"], 0);
    drag.dispose();
  });

  it("dedo: la pulsacion larga arranca tras LONG_PRESS_MS si no se mueve; antes de eso, mover cancela (es un desplazamiento)", () => {
    const first = setup();
    const marked = vi.fn();
    first.drag.longPress({ pointerId: 1, clientX: 10, clientY: 10 }, "a", marked);
    vi.advanceTimersByTime(LONG_PRESS_MS - 10);
    expect(first.drag.active).toBe(false);
    vi.advanceTimersByTime(20);
    expect(first.drag.active).toBe(true);
    expect(marked).toHaveBeenCalled();
    move("pointermove", 100, 100);
    move("pointerup", 100, 100);
    first.drag.dispose();

    const second = setup();
    second.drag.longPress({ pointerId: 1, clientX: 10, clientY: 10 }, "a");
    vi.advanceTimersByTime(200);
    move("pointermove", 10, 40);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(second.drag.active).toBe(false);
    second.drag.dispose();
  });

  it("touchmove se cancela SOLO mientras se arrastra (para que el navegador no desplace la pagina)", () => {
    const { drag } = setup();
    const idle = new Event("touchmove", { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", true);
    const busy = new Event("touchmove", { cancelable: true });
    window.dispatchEvent(busy);
    expect(busy.defaultPrevented).toBe(true);
    move("pointerup", 10, 10);
    drag.dispose();
  });

  it("dispose retira los oyentes: despues de el nada responde", () => {
    const { drag, onDrop } = setup();
    drag.start({ pointerId: 1, clientX: 10, clientY: 10 }, "a", false);
    drag.dispose();
    move("pointermove", 90, 90);
    move("pointerup", 90, 90);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
