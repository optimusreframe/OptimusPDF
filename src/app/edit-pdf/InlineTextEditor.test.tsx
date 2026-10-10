import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  InlineTextEditor,
  frameStyle,
  textBoxStyle,
  textCssStyle,
  type InlineTextEditorProps,
  type TextCssInput,
} from "@/app/edit-pdf/InlineTextEditor";
import { readEditableText, type TextFrame } from "@/app/edit-pdf/editCanvasMath";

const FRAME: TextFrame = { left: 40, top: 60, width: 220, height: 20, angle: 0 };
const CSS: TextCssInput = {
  fontKey: "times",
  bold: true,
  italic: false,
  fontSize: 12,
  color: "#112233",
  align: "center",
  lineHeight: 1.5,
};

function setup(overrides: Partial<InlineTextEditorProps> = {}) {
  const props: InlineTextEditorProps = {
    frame: FRAME,
    text: "Hola mundo",
    css: CSS,
    scale: 1.5,
    label: "Editando",
    hint: "Esc para terminar",
    onTextChange: vi.fn(),
    onExit: vi.fn(),
    onHistory: vi.fn(),
    ...overrides,
  };
  const view = render(<InlineTextEditor {...props} />);
  const editor = screen.getByRole("textbox", { name: "Editando" });
  return { props, editor, ...view };
}

function typeInto(editor: HTMLElement, value: string) {
  editor.textContent = value;
  fireEvent.input(editor);
}

describe("InlineTextEditor — semantica y estilo", () => {
  it("es un textbox multilinea con nombre y descripcion", () => {
    const { editor } = setup();
    expect(editor.getAttribute("aria-multiline")).toBe("true");
    expect(editor.getAttribute("contenteditable")).toBe("plaintext-only");
    const described = document.getElementById(editor.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Esc para terminar");
  });

  it("empieza con el texto del bloque y el foco dentro, con el cursor al final", () => {
    const { editor } = setup();
    expect(editor.textContent).toBe("Hola mundo");
    expect(document.activeElement).toBe(editor);
    const selection = window.getSelection();
    expect(selection?.isCollapsed).toBe(true);
    expect(selection?.anchorNode && editor.contains(selection.anchorNode)).toBe(true);
  });

  it("se alinea EXACTAMENTE con el marco del bloque y crece hacia abajo", () => {
    const { editor } = setup();
    expect(editor.style.left).toBe("40px");
    expect(editor.style.top).toBe("60px");
    expect(editor.style.width).toBe("220px");
    expect(editor.style.minHeight).toBe("20px");
    expect(editor.style.transformOrigin).toMatch(/^0(px)? 0(px)?$/);
    expect(editor.className).toContain("whitespace-pre-wrap");
    expect(editor.style.overflowWrap).toBe("normal");
  });

  it("usa la fuente CSS equivalente, el tamano escalado por el zoom, color, alineacion e interlineado", () => {
    const { editor } = setup();
    expect(editor.style.fontFamily).toContain("Times New Roman");
    expect(editor.style.fontWeight).toBe("700");
    expect(editor.style.fontStyle).toBe("normal");
    expect(editor.style.fontSize).toBe("18px");
    expect(editor.style.color).toBe("rgb(17, 34, 51)");
    expect(editor.style.textAlign).toBe("center");
    expect(editor.style.lineHeight).toBe("1.5");
    expect(editor.style.fontKerning).toBe("none");
  });

  it("textCssStyle usa 1,2 de interlineado por defecto, igual que el exportador", () => {
    expect(textCssStyle({ ...CSS, lineHeight: undefined }, 1).lineHeight).toBe(1.2);
    expect(textCssStyle({ ...CSS, fontKey: "liberation-serif" }, 1).fontFamily).toContain("Times New Roman");
  });

  it("frameStyle gira el marco y aplica la correccion vertical en su propio eje", () => {
    const style = frameStyle({ ...FRAME, angle: 90 }, 2);
    expect(style.transform).toBe("rotate(90deg) translateY(-2px)");
    expect(frameStyle(FRAME, 0).transform).toBeUndefined();
    expect(textBoxStyle(FRAME, CSS, 1).fontSize).toBe("12px");
  });

  it("registra los @font-face del catalogo una sola vez", () => {
    const first = setup();
    first.unmount();
    setup();
    expect(document.querySelectorAll("#optimus-catalog-font-faces")).toHaveLength(1);
  });
});

describe("InlineTextEditor — entrada de texto", () => {
  it("emite el texto al teclear y no repite el mismo valor", () => {
    const { editor, props } = setup();
    typeInto(editor, "Hola mundo!");
    expect(props.onTextChange).toHaveBeenCalledTimes(1);
    expect(props.onTextChange).toHaveBeenLastCalledWith("Hola mundo!");
    fireEvent.input(editor);
    expect(props.onTextChange).toHaveBeenCalledTimes(1);
  });

  it("si el texto de fuera cambia (deshacer) reescribe el DOM", () => {
    const { editor, rerender, props } = setup();
    typeInto(editor, "Hola mundo!");
    rerender(<InlineTextEditor {...props} text="Hola" />);
    expect(editor.textContent).toBe("Hola");
  });

  it("si el texto de fuera ya es el que hay no toca el DOM ni mueve el cursor", () => {
    const { editor, rerender, props } = setup();
    const node = editor.firstChild;
    typeInto(editor, "Hola mundo!");
    const typedNode = editor.firstChild;
    rerender(<InlineTextEditor {...props} text="Hola mundo!" />);
    expect(editor.firstChild).toBe(typedNode);
    expect(node).not.toBeNull();
  });

  it("inserta la tecla que abrio la edicion al final", () => {
    const { editor, props } = setup({ seed: "Z" });
    expect(editor.textContent).toBe("Hola mundoZ");
    expect(props.onTextChange).toHaveBeenCalledWith("Hola mundoZ");
  });

  it("mientras dura una composicion IME no emite; al terminar emite el texto final", () => {
    const { editor, props } = setup();
    fireEvent.compositionStart(editor);
    typeInto(editor, "Hola mundo に");
    typeInto(editor, "Hola mundo にほ");
    expect(props.onTextChange).not.toHaveBeenCalled();
    editor.textContent = "Hola mundo にほん";
    fireEvent.compositionEnd(editor);
    expect(props.onTextChange).toHaveBeenCalledTimes(1);
    expect(props.onTextChange).toHaveBeenCalledWith("Hola mundo にほん");
  });

  it("un cambio de fuera durante la composicion no pisa lo que se esta componiendo", () => {
    const { editor, rerender, props } = setup();
    fireEvent.compositionStart(editor);
    editor.textContent = "componiendo";
    rerender(<InlineTextEditor {...props} text="otro" />);
    expect(editor.textContent).toBe("componiendo");
  });

  it("pegar varias lineas deja un solo nodo de texto con saltos, sin <div> ni <br>", () => {
    const { editor } = setup({ text: "" });
    fireEvent.paste(editor, { clipboardData: { getData: () => "a\nb\nc" } });
    expect(editor.querySelector("div, br, p")).toBeNull();
    expect(editor.textContent).toBe("a\nb\nc");
  });

  it("pegar inserta SOLO texto plano (sin HTML) y emite el cambio", () => {
    const { editor, props } = setup({ text: "" });
    const data = {
      getData: (type: string) => (type === "text/plain" ? "linea 1\r\nlinea 2" : "<b>negrita</b>"),
    };
    fireEvent.paste(editor, { clipboardData: data });
    expect(editor.querySelector("b")).toBeNull();
    expect(readEditableText(editor)).toBe("linea 1\nlinea 2");
    expect(props.onTextChange).toHaveBeenLastCalledWith("linea 1\nlinea 2");
  });
});

describe("InlineTextEditor — teclado", () => {
  it("Esc termina; Mayus+Intro termina; Intro solo hace un salto de linea", () => {
    const { editor, props } = setup();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(props.onExit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(props.onExit).toHaveBeenLastCalledWith("shift-enter", null);
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(props.onExit).toHaveBeenLastCalledWith("escape", null);
  });

  it("Esc durante una composicion IME no termina la edicion", () => {
    const { editor, props } = setup();
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
    fireEvent.keyDown(editor, { key: "Process" });
    expect(props.onExit).not.toHaveBeenCalled();
  });

  it("Ctrl/Cmd+Z deshace el historial de la sesion (no el nativo) y Ctrl+Mayus+Z / Ctrl+Y rehacen", () => {
    const { editor, props } = setup();
    const undo = fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(undo).toBe(false); // preventDefault: el undo del navegador no corre
    expect(props.onHistory).toHaveBeenLastCalledWith("undo");
    fireEvent.keyDown(editor, { key: "z", metaKey: true });
    expect(props.onHistory).toHaveBeenLastCalledWith("undo");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true, shiftKey: true });
    expect(props.onHistory).toHaveBeenLastCalledWith("redo");
    fireEvent.keyDown(editor, { key: "y", ctrlKey: true });
    expect(props.onHistory).toHaveBeenLastCalledWith("redo");
    expect(props.onHistory).toHaveBeenCalledTimes(4);
  });

  it("el undo del menu del navegador (beforeinput historyUndo) tambien va al historial de la sesion", () => {
    const { editor, props } = setup();
    const event = new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true });
    act(() => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(props.onHistory).toHaveBeenLastCalledWith("undo");
  });

  it("al perder el foco avisa con el elemento que lo recibe", () => {
    const { editor, props } = setup();
    const other = document.createElement("button");
    document.body.appendChild(other);
    fireEvent.blur(editor, { relatedTarget: other });
    expect(props.onExit).toHaveBeenLastCalledWith("blur", other);
    fireEvent.blur(editor);
    expect(props.onExit).toHaveBeenLastCalledWith("blur", null);
    other.remove();
  });

  it("no avisa del blur mientras se compone", () => {
    const { editor, props } = setup();
    fireEvent.compositionStart(editor);
    fireEvent.blur(editor);
    expect(props.onExit).not.toHaveBeenCalled();
  });
});

describe("InlineTextEditor — navegacion por teclado sin desplazar la pagina", () => {
  /** Cursor en el ELEMENTO (sin nodo de texto): el caso en que el navegador no consume la tecla. */
  function caretOnElement(editor: HTMLElement) {
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const caret = () => {
    const selection = window.getSelection()!;
    return { node: selection.anchorNode, offset: selection.anchorOffset };
  };

  it("al abrir, el cursor esta dentro de un nodo de texto (tambien con el bloque vacio)", () => {
    const filled = setup({ text: "Hola" });
    expect(caret().node?.nodeType).toBe(3);
    expect(caret().offset).toBe(4);
    filled.unmount();
    const empty = setup({ text: "" });
    expect(caret().node?.nodeType).toBe(3);
    expect(empty.editor.contains(caret().node)).toBe(true);
  });

  it.each(["End", "Home", "PageUp", "PageDown"])(
    "%s con el cursor fuera de un nodo de texto se consume (la pagina no se desplaza) y mueve el cursor",
    (key) => {
      const { editor } = setup({ text: "Hola mundo" });
      caretOnElement(editor);
      const notPrevented = fireEvent.keyDown(editor, { key });
      expect(notPrevented, `${key} debe hacer preventDefault`).toBe(false);
      expect(caret().node?.nodeType).toBe(3);
      expect(caret().offset).toBe(key === "End" || key === "PageDown" ? 10 : 0);
    },
  );

  it("Ctrl+Inicio / Ctrl+Fin tambien, y con el bloque vacio (sin nodo de texto previo)", () => {
    const { editor } = setup({ text: "" });
    editor.textContent = "";
    for (const [key, ctrlKey] of [["Home", true], ["End", true], ["Home", false], ["End", false]] as const) {
      editor.textContent = "";
      caretOnElement(editor);
      expect(fireEvent.keyDown(editor, { key, ctrlKey })).toBe(false);
      expect(caret().node?.nodeType).toBe(3);
    }
  });

  it("las flechas con el cursor fuera de un nodo de texto tampoco llegan a la pagina", () => {
    const { editor } = setup({ text: "Hola" });
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      caretOnElement(editor);
      expect(fireEvent.keyDown(editor, { key }), key).toBe(false);
      expect(caret().node?.nodeType).toBe(3);
    }
  });

  it("tambien con el cursor YA dentro del texto y sin poder moverse (Fin al final): la pagina no se desplaza", () => {
    const { editor } = setup({ text: "Hola mundo" });
    // Cursor al final: Fin, Av Pag y Flecha derecha no pueden mover nada, y aun asi se consumen.
    for (const key of ["End", "PageDown", "ArrowRight", "ArrowDown"]) {
      expect(fireEvent.keyDown(editor, { key }), key).toBe(false);
      expect(caret().offset).toBe(10);
    }
    expect(fireEvent.keyDown(editor, { key: "PageUp" })).toBe(false);
    expect(caret().offset).toBe(0);
    for (const key of ["Home", "ArrowLeft", "ArrowUp"]) {
      expect(fireEvent.keyDown(editor, { key }), key).toBe(false);
      expect(caret().offset).toBe(0);
    }
  });

  it("con una seleccion, Flecha izquierda/derecha la colapsa en su extremo", () => {
    const { editor } = setup({ text: "Hola mundo" });
    const node = editor.firstChild!;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(caret().offset).toBe(6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    expect(caret().offset).toBe(2);
  });

  it("no rompe lo demas: Esc, deshacer, pegado y composicion siguen igual", () => {
    const { editor, props } = setup({ text: "Hola" });
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(props.onHistory).toHaveBeenCalledWith("undo");
    fireEvent.keyDown(editor, { key: "End", isComposing: true }); // IME: ni se toca
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(props.onExit).toHaveBeenCalledWith("escape", null);
    fireEvent.paste(editor, { clipboardData: { getData: () => "xy" } });
    expect(props.onTextChange).toHaveBeenLastCalledWith("Holaxy");
  });
});

describe("InlineTextEditor — con estado de React", () => {
  function Harness() {
    const [text, setText] = useState("uno");
    return (
      <>
        <InlineTextEditor
          frame={FRAME}
          text={text}
          css={CSS}
          scale={1}
          label="Editando"
          hint=""
          onTextChange={setText}
          onExit={() => undefined}
          onHistory={() => setText("uno")}
        />
        <output>{text}</output>
      </>
    );
  }

  it("teclear actualiza el estado sin reescribir el DOM y el historial lo devuelve", () => {
    render(<Harness />);
    const editor = screen.getByRole("textbox");
    typeInto(editor, "uno dos");
    expect(document.querySelector("output")?.textContent).toBe("uno dos");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(document.querySelector("output")?.textContent).toBe("uno");
    expect(editor.textContent).toBe("uno");
  });
});

describe("readEditableText", () => {
  function root(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el;
  }

  it("lee texto plano, <br> y bloques <div>, y normaliza espacios duros", () => {
    expect(readEditableText(root("uno<br>dos"))).toBe("uno\ndos");
    expect(readEditableText(root("uno<div>dos</div><div>tres</div>"))).toBe("uno\ndos\ntres");
    expect(readEditableText(root("a&nbsp;b​c"))).toBe("a bc");
    expect(readEditableText(root("l1\r\nl2"))).toBe("l1\nl2");
    expect(readEditableText(root(""))).toBe("");
  });

  it("descarta el salto de linea centinela del final (Chrome plaintext-only y el <br> de Firefox)", () => {
    expect(readEditableText(root("uno\n\n"))).toBe("uno\n"); // Intro al final: un salto real + el centinela
    expect(readEditableText(root("uno\n"))).toBe("uno");
    expect(readEditableText(root("uno<br>"))).toBe("uno");
    expect(readEditableText(root("uno\ndos"))).toBe("uno\ndos");
  });
});
