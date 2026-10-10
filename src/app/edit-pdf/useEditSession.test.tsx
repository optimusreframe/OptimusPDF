import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  applyOp,
  createEditSession,
  newTextEdit,
  textItem,
  type EditOp,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import {
  isEditableElement,
  matchUndoRedoShortcut,
  useEditSession,
  type UseEditSessionOptions,
} from "@/app/edit-pdf/useEditSession";

/** Hook de la sesion de edicion: API estable para el lienzo y atajos de teclado. */

function addText(id: string, text = "Hola"): EditOp {
  return {
    type: "add",
    item: textItem(
      newTextEdit({
        id,
        pageIndex: 0,
        box: { x: 10, y: 10, width: 100, height: 20 },
        fontKey: "helvetica",
        text,
      }),
    ),
  };
}

function setup(options: UseEditSessionOptions = {}) {
  let clock = 0;
  const hook = renderHook(() =>
    useEditSession({ now: () => (clock += 10_000), ...options }),
  );
  return hook;
}

function key(init: KeyboardEventInit & { target?: Element }) {
  const { target = document.body, ...rest } = init;
  return fireEvent.keyDown(target, { bubbles: true, cancelable: true, ...rest });
}

describe("useEditSession — API", () => {
  it("arranca vacio y expone session/items/selected/canUndo/canRedo", () => {
    const { result } = setup();
    expect(result.current.items).toEqual([]);
    expect(result.current.selected).toBeNull();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.pendingChangeCount).toBe(0);
  });

  it("dispatch / undo / redo cambian el estado y los booleanos", () => {
    const { result } = setup();
    act(() => result.current.dispatch(addText("a")));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.selected?.id).toBe("a");
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.items).toHaveLength(0);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.items).toHaveLength(1);
  });

  it("dispatch, undo, redo, select, reset y load tienen identidad estable entre renders", () => {
    const { result } = setup();
    const first = { ...result.current };
    act(() => result.current.dispatch(addText("a")));
    for (const name of ["dispatch", "undo", "redo", "select", "reset", "load"] as const) {
      expect(result.current[name]).toBe(first[name]);
    }
  });

  it("usa el reloj inyectado para el agrupado de tecleo", () => {
    let t = 0;
    const { result } = renderHook(() => useEditSession({ now: () => t }));
    act(() => result.current.dispatch(addText("a", "")));
    t = 5000;
    act(() => result.current.dispatch({ type: "update", id: "a", patch: { text: "h" } }));
    t = 5100;
    act(() => result.current.dispatch({ type: "update", id: "a", patch: { text: "ho" } }));
    t = 5200;
    act(() => result.current.dispatch({ type: "update", id: "a", patch: { text: "hol" } }));
    expect(result.current.session.history).toHaveLength(2);
    act(() => result.current.undo());
    expect(result.current.pendingChangeCount).toBe(0);
  });

  it("select cambia la seleccion; reset descarta todo; load restaura una sesion", () => {
    const { result } = setup();
    act(() => result.current.dispatch(addText("a")));
    act(() => result.current.dispatch(addText("b")));
    act(() => result.current.select("a"));
    expect(result.current.selected?.id).toBe("a");
    expect(result.current.itemsOnPage(0)).toHaveLength(2);
    expect(result.current.itemsOnPage(3)).toHaveLength(0);
    act(() => result.current.reset());
    expect(result.current.items).toHaveLength(0);
    expect(result.current.canUndo).toBe(false);

    const restored: EditSession = applyOp(createEditSession(), addText("z"), 0);
    act(() => result.current.load(restored));
    expect(result.current.items.map((i) => i.id)).toEqual(["z"]);
  });

  it("acepta una sesion inicial (valor o funcion)", () => {
    const initial = applyOp(createEditSession(), addText("z"), 0);
    expect(setup({ initial }).result.current.items).toHaveLength(1);
    expect(setup({ initial: () => initial }).result.current.items).toHaveLength(1);
  });
});

describe("matchUndoRedoShortcut — puro", () => {
  const base = { key: "z", code: "KeyZ", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  it("Ctrl/Cmd+Z deshace; con Shift rehace; Ctrl+Y rehace", () => {
    expect(matchUndoRedoShortcut({ ...base, ctrlKey: true })).toBe("undo");
    expect(matchUndoRedoShortcut({ ...base, metaKey: true })).toBe("undo");
    expect(matchUndoRedoShortcut({ ...base, ctrlKey: true, shiftKey: true, key: "Z" })).toBe("redo");
    expect(matchUndoRedoShortcut({ ...base, metaKey: true, shiftKey: true })).toBe("redo");
    expect(matchUndoRedoShortcut({ ...base, ctrlKey: true, key: "y", code: "KeyY" })).toBe("redo");
  });
  it("Cmd+Y no (historial del navegador en macOS), ni sin modificador, ni con Alt", () => {
    expect(matchUndoRedoShortcut({ ...base, metaKey: true, key: "y", code: "KeyY" })).toBeNull();
    expect(matchUndoRedoShortcut(base)).toBeNull();
    expect(matchUndoRedoShortcut({ ...base, ctrlKey: true, altKey: true })).toBeNull();
    expect(matchUndoRedoShortcut({ ...base, ctrlKey: true, key: "x", code: "KeyX" })).toBeNull();
  });
  it("distribuciones no latinas: KeyZ por codigo", () => {
    expect(matchUndoRedoShortcut({ ...base, ctrlKey: true, key: "я", code: "KeyZ" })).toBe("undo");
  });
});

describe("useEditSession — atajos de teclado", () => {
  it("Ctrl+Z deshace y Ctrl+Shift+Z / Ctrl+Y rehacen, con preventDefault", () => {
    const { result } = setup();
    act(() => result.current.dispatch(addText("a")));
    let notPrevented = true;
    act(() => {
      notPrevented = key({ key: "z", ctrlKey: true });
    });
    expect(notPrevented).toBe(false); // preventDefault
    expect(result.current.items).toHaveLength(0);
    act(() => void key({ key: "Z", ctrlKey: true, shiftKey: true }));
    expect(result.current.items).toHaveLength(1);
    act(() => void key({ key: "z", metaKey: true }));
    expect(result.current.items).toHaveLength(0);
    act(() => void key({ key: "y", ctrlKey: true }));
    expect(result.current.items).toHaveLength(1);
  });

  it("NO captura el teclado dentro de input, textarea, select ni contenteditable", () => {
    const { result } = setup();
    act(() => result.current.dispatch(addText("a")));
    render(
      <div>
        <input aria-label="campo" />
        <textarea aria-label="area" />
        <select aria-label="lista">
          <option>uno</option>
        </select>
        <div aria-label="editor" contentEditable suppressContentEditableWarning>
          <span data-testid="hijo">texto</span>
        </div>
      </div>,
    );
    for (const target of [
      screen.getByLabelText("campo"),
      screen.getByLabelText("area"),
      screen.getByLabelText("lista"),
      screen.getByTestId("hijo"),
    ]) {
      let notPrevented = false;
      act(() => {
        notPrevented = key({ key: "z", ctrlKey: true, target });
      });
      expect(notPrevented).toBe(true); // sin preventDefault: el campo hace su propio deshacer
      expect(result.current.items).toHaveLength(1);
    }
  });

  it("una casilla (checkbox) no es un campo de texto: el atajo si actua", () => {
    const { result } = setup();
    act(() => result.current.dispatch(addText("a")));
    render(<input type="checkbox" aria-label="marca" />);
    act(() => void key({ key: "z", ctrlKey: true, target: screen.getByLabelText("marca") }));
    expect(result.current.items).toHaveLength(0);
  });

  it("allowInEditable:true captura tambien dentro de campos", () => {
    const { result } = setup({ shortcuts: { allowInEditable: true } });
    act(() => result.current.dispatch(addText("a")));
    render(<textarea aria-label="area" />);
    act(() => void key({ key: "z", ctrlKey: true, target: screen.getByLabelText("area") }));
    expect(result.current.items).toHaveLength(0);
  });

  it("allowInEditable como funcion decide por elemento", () => {
    const { result } = setup({
      shortcuts: { allowInEditable: (el) => el.getAttribute("data-historial") === "global" },
    });
    act(() => result.current.dispatch(addText("a")));
    render(
      <div>
        <textarea aria-label="propio" />
        <textarea aria-label="global" data-historial="global" />
      </div>,
    );
    act(() => void key({ key: "z", ctrlKey: true, target: screen.getByLabelText("propio") }));
    expect(result.current.items).toHaveLength(1);
    act(() => void key({ key: "z", ctrlKey: true, target: screen.getByLabelText("global") }));
    expect(result.current.items).toHaveLength(0);
  });

  it("shortcuts:false o enabled:false no escuchan nada", () => {
    for (const shortcuts of [false, { enabled: false }] as const) {
      const { result, unmount } = setup({ shortcuts });
      act(() => result.current.dispatch(addText("a")));
      act(() => void key({ key: "z", ctrlKey: true }));
      expect(result.current.items).toHaveLength(1);
      unmount();
    }
  });

  it("target inyectable: escucha ahi y se desuscribe al desmontar", () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const { result, unmount } = setup({ shortcuts: { target } });
    act(() => result.current.dispatch(addText("a")));
    expect(add).toHaveBeenCalledWith("keydown", expect.any(Function));
    act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true })));
    expect(result.current.items).toHaveLength(0);
    // El documento ya no es el destino.
    act(() => result.current.dispatch(addText("b")));
    act(() => void key({ key: "z", ctrlKey: true }));
    expect(result.current.items).toHaveLength(1);
    unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("un evento ya cancelado o durante composicion IME se ignora", () => {
    const { result } = setup();
    act(() => result.current.dispatch(addText("a")));
    const ime = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(ime));
    expect(result.current.items).toHaveLength(1);
    const cancelled = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    cancelled.preventDefault();
    act(() => void document.body.dispatchEvent(cancelled));
    expect(result.current.items).toHaveLength(1);
  });

  it("al desmontar se quitan los atajos del documento", () => {
    const { unmount } = setup();
    const remove = vi.spyOn(document, "removeEventListener");
    unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    remove.mockRestore();
  });
});

describe("isEditableElement", () => {
  it("reconoce campos de texto y deja pasar botones, casillas y nodos normales", () => {
    const make = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.firstElementChild as Element;
    };
    expect(isEditableElement(make("<input type='text'>"))).toBe(true);
    expect(isEditableElement(make("<input>"))).toBe(true);
    expect(isEditableElement(make("<textarea></textarea>"))).toBe(true);
    expect(isEditableElement(make("<div contenteditable='true'></div>"))).toBe(true);
    expect(isEditableElement(make("<div contenteditable='false'></div>"))).toBe(false);
    expect(isEditableElement(make("<input type='checkbox'>"))).toBe(false);
    expect(isEditableElement(make("<button></button>"))).toBe(false);
    expect(isEditableElement(make("<div></div>"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});
