import { afterEach, describe, expect, it } from "vitest";
import { modalSheetOpen } from "@/app/pdf-pro/proShortcuts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  attachProUndoShortcuts,
  handleProUndoKey,
  isTextEditingTarget,
  undoActionForKey,
} from "@/app/pdf-pro/proShortcuts";
import { ProWorkingDocProvider, useProMode } from "@/app/pdf-pro/useProWorkingDoc";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import { LanguageProvider } from "@/lib/i18n";
import type { ProModeId } from "@/app/pdf-pro/proTypes";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

const detachers: Array<() => void> = [];
/** Engancha y recuerda el desenganche: un oyente olvidado cancelaria el evento antes que el del test siguiente. */
function attach(doc: ProWorkingDoc): () => void {
  const detach = attachProUndoShortcuts(doc);
  detachers.push(detach);
  return detach;
}

afterEach(() => {
  while (detachers.length > 0) detachers.pop()!();
  cleanup();
});

async function docWithSteps(steps = 2): Promise<ProWorkingDoc> {
  const doc = fakeDoc({ maxSnapshots: 20 });
  await doc.open(fakeFile(), { pageCount: 3 });
  for (let i = 1; i <= steps; i += 1) await doc.commit(fakeBytes(10 + i, i), `Paso ${i}`, "operation", { pageCount: 3 });
  return doc;
}

const cursor = (doc: ProWorkingDoc) => doc.getState().document!.cursor;

function key(target: Element | Document, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("undoActionForKey", () => {
  it("Ctrl/Cmd+Z = deshacer, con Shift = rehacer, Ctrl+Y = rehacer", () => {
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }))).toBe("undo");
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "z", metaKey: true }))).toBe("undo");
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true }))).toBe("redo");
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "y", ctrlKey: true }))).toBe("redo");
  });

  it("sin Ctrl/Cmd, o con Alt, no es un atajo; Cmd+Y tampoco (en Mac no existe)", () => {
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "z" }))).toBeNull();
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, altKey: true }))).toBeNull();
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "y", metaKey: true }))).toBeNull();
    expect(undoActionForKey(new KeyboardEvent("keydown", { key: "x", ctrlKey: true }))).toBeNull();
  });
});

describe("isTextEditingTarget", () => {
  const make = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    return host.firstElementChild as HTMLElement;
  };

  it.each([
    ['<input type="text">', true],
    ['<input>', true],
    ['<input type="search">', true],
    ['<input type="password">', true],
    ['<input type="email">', true],
    ['<input type="number">', true],
    ["<textarea></textarea>", true],
    ["<select><option>a</option></select>", true],
    ['<div contenteditable="true">x</div>', true],
    ['<div contenteditable="">x</div>', true],
    ['<div role="textbox">x</div>', true],
    ['<div role="searchbox">x</div>', true],
    ['<input type="checkbox">', false],
    ['<input type="radio">', false],
    ['<input type="range">', false],
    ['<input type="file">', false],
    ['<input type="button">', false],
    ["<button>ok</button>", false],
    ["<div>nada</div>", false],
  ])("%s -> %s", (html, expected) => {
    expect(isTextEditingTarget(make(html))).toBe(expected);
  });

  it("un hijo de un contenteditable cuenta como campo de texto", () => {
    const host = make('<div contenteditable="true"><span id="hijo">x</span></div>');
    expect(isTextEditingTarget(host.querySelector("#hijo"))).toBe(true);
  });

  it("null y objetivos que no son elementos no son campos de texto", () => {
    expect(isTextEditingTarget(null)).toBe(false);
    expect(isTextEditingTarget(window)).toBe(false);
  });
});

describe("Ctrl/Cmd+Z a nivel de documento", () => {
  it("deshace con Ctrl+Z y rehace con Ctrl+Shift+Z y Ctrl+Y", async () => {
    const doc = await docWithSteps(2);
    const detach = attach(doc);
    expect(key(document.body, { key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(cursor(doc)).toBe(1);
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(0);
    key(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
    expect(cursor(doc)).toBe(1);
    key(document.body, { key: "y", ctrlKey: true });
    expect(cursor(doc)).toBe(2);
    detach();
  });

  it("Cmd+Z funciona igual (Mac)", async () => {
    const doc = await docWithSteps(1);
    attach(doc);
    key(document.body, { key: "z", metaKey: true });
    expect(cursor(doc)).toBe(0);
  });

  it("NO actua con el foco en un campo de texto (el navegador deshace el texto)", async () => {
    const doc = await docWithSteps(2);
    attach(doc);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const event = key(input, { key: "z", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(cursor(doc)).toBe(2);
    input.remove();
  });

  it.each(["textarea", "contenteditable", "searchbox"])("NO actua en %s", async (kind) => {
    const doc = await docWithSteps(2);
    attach(doc);
    const element = document.createElement(kind === "textarea" ? "textarea" : "div");
    if (kind === "contenteditable") element.setAttribute("contenteditable", "true");
    if (kind === "searchbox") element.setAttribute("role", "searchbox");
    document.body.appendChild(element);
    key(element, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(2);
    element.remove();
  });

  it("SI actua con el foco en una casilla o un boton (no escriben texto)", async () => {
    const doc = await docWithSteps(2);
    attach(doc);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);
    key(checkbox, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
    const button = document.createElement("button");
    document.body.appendChild(button);
    key(button, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(0);
    checkbox.remove();
    button.remove();
  });

  it("NO actua mientras un modo con deshacer propio esta activo, y vuelve a actuar al salir del modo", async () => {
    const doc = await docWithSteps(2);
    attach(doc);
    const release = doc.registerMode("edit", { hasOwnUndo: true });
    const blocked = key(document.body, { key: "z", ctrlKey: true });
    expect(blocked.defaultPrevented).toBe(false);
    expect(cursor(doc)).toBe(2);
    release();
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
  });

  it("un modo SIN deshacer propio deja pasar el global", async () => {
    const doc = await docWithSteps(2);
    attach(doc);
    doc.registerMode("annotate", { hasOwnUndo: false });
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
  });

  it("no cancela el evento si no hay nada que deshacer o rehacer", async () => {
    const doc = await docWithSteps(0);
    attach(doc);
    expect(key(document.body, { key: "z", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(document.body, { key: "y", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("respeta un evento que otro ya cancelo", async () => {
    const doc = await docWithSteps(1);
    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true });
    event.preventDefault();
    expect(handleProUndoKey(doc, event)).toBe(false);
    expect(cursor(doc)).toBe(1);
  });

  it("sin documento abierto no hace nada", () => {
    const doc = fakeDoc();
    attach(doc);
    expect(key(document.body, { key: "z", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("attach devuelve el desenganche: tras llamarlo ya no actua", async () => {
    const doc = await docWithSteps(2);
    const detach = attach(doc);
    detach();
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(2);
  });

  it("Ctrl+Alt+Z no es el atajo", async () => {
    const doc = await docWithSteps(1);
    attach(doc);
    key(document.body, { key: "z", ctrlKey: true, altKey: true });
    expect(cursor(doc)).toBe(1);
  });
});

function ModeProbe({ id, hasOwnUndo, active = true }: { id: ProModeId; hasOwnUndo: boolean; active?: boolean }) {
  useProMode(id, { hasOwnUndo }, active);
  return null;
}

describe("ProWorkingDocProvider y useProMode", () => {
  it("engancha los atajos al montar y los quita al desmontar", async () => {
    const doc = await docWithSteps(2);
    const { unmount } = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <p>hijo</p>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
    unmount();
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
  });

  it("shortcuts={false} los apaga", async () => {
    const doc = await docWithSteps(2);
    render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc} shortcuts={false}>
          <p>hijo</p>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(2);
  });

  it("useProMode registra el modo mientras esta montado y bloquea el global", async () => {
    const doc = await docWithSteps(2);
    const { rerender } = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <ModeProbe id="edit" hasOwnUndo />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    expect(doc.getState().activeModes).toEqual(["edit"]);
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(2);
    rerender(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <p>sin modo</p>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    expect(doc.getState().activeModes).toEqual([]);
    key(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
  });

  it("useProMode con active=false no registra nada", async () => {
    const doc = await docWithSteps(1);
    render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <ModeProbe id="sign" hasOwnUndo active={false} />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    expect(doc.getState().activeModes).toEqual([]);
  });
});

describe("eventos reales de teclado sobre el DOM de React", () => {
  it("fireEvent.keyDown sobre un input dentro del proveedor no deshace", async () => {
    const doc = await docWithSteps(2);
    const { getByLabelText } = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>
          <input aria-label="nombre" />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    fireEvent.keyDown(getByLabelText("nombre"), { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(2);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(cursor(doc)).toBe(1);
  });
});

describe("modalSheetOpen (Wave 8 · backlog b)", () => {
  it("una hoja abierta cuenta; una que anima su salida (data-sheet-closing) NO; sin hojas, no", () => {
    const root = document.createElement("div");
    expect(modalSheetOpen(root)).toBe(false);
    root.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(modalSheetOpen(root)).toBe(true);
    root.firstElementChild!.setAttribute("data-sheet-closing", "");
    expect(modalSheetOpen(root)).toBe(false);
  });
});
