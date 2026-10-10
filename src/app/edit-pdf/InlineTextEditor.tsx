"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { matchUndoRedoShortcut } from "@/app/edit-pdf/useEditSession";
import {
  readEditableText,
  type TextFrame,
} from "@/app/edit-pdf/editCanvasMath";
import { cssFontStack, effectiveFontKey, ensureCatalogFontFaces } from "@/lib/pdf/editFonts";
import { DEFAULT_LINE_HEIGHT } from "@/lib/pdf/editTextExport";
import { previewBaselineShift } from "@/app/edit-pdf/previewMetrics";
import type { CatalogFontKey, TextAlign } from "@/lib/pdf/editTypes";

/*
 * Editor inline de un bloque de texto (W5-U4a): un `contenteditable` de texto
 * plano alineado EXACTAMENTE con el rectangulo del bloque, con la fuente CSS
 * equivalente a la que usara el exportador, el tamano escalado por el zoom, el
 * color, la alineacion y el interlineado. El texto se reajusta al ancho del
 * bloque mientras se escribe (como `wrapText` al exportar) y crece hacia abajo.
 *
 * No es controlado por React (un contenteditable controlado pierde el cursor):
 * el DOM es la fuente mientras se teclea y solo se reescribe cuando el texto de
 * fuera cambia por otra via (deshacer/rehacer). Composicion (IME): mientras dura
 * no se emite nada; al terminar se emite el texto final. Pegar: solo texto
 * plano. Ctrl/Cmd+Z y Ctrl+Shift+Z / Ctrl+Y actuan sobre el historial de la
 * sesion, no sobre el del navegador.
 */

export type TextCssInput = {
  fontKey: CatalogFontKey;
  bold: boolean;
  italic: boolean;
  /** Puntos PDF. */
  fontSize: number;
  color: string;
  align: TextAlign;
  lineHeight?: number;
};

/** Estilo CSS del texto de una edicion a la escala de la hoja (px CSS por punto). */
export function textCssStyle(input: TextCssInput, scale: number): CSSProperties {
  const font = cssFontStack(effectiveFontKey(input.fontKey), input.bold, input.italic);
  return {
    fontFamily: font.fontFamily,
    fontWeight: font.fontWeight,
    fontStyle: font.fontStyle,
    fontSize: `${input.fontSize * scale}px`,
    lineHeight: input.lineHeight ?? DEFAULT_LINE_HEIGHT,
    color: input.color,
    textAlign: input.align,
    margin: 0,
    padding: 0,
    boxSizing: "border-box",
    // Como el exportador: una palabra mas ancha que la caja se queda entera y
    // sobresale (solo se partiria si no cupiera en la pagina); no se parte.
    overflowWrap: "normal",
    wordBreak: "normal",
    // Como pdf-lib: sin kerning ni redondeo de avances, para que el ajuste de linea coincida.
    fontKerning: "none",
    textRendering: "geometricPrecision",
  };
}

/**
 * Posicion y giro del rectangulo del texto. `shiftY` (px) sube el texto en su
 * propio marco para igualar la linea base del exportador (`previewMetrics`).
 */
export function frameStyle(frame: TextFrame, shiftY = 0): CSSProperties {
  const rotate = frame.angle === 0 ? "" : `rotate(${frame.angle}deg)`;
  const shift = Math.abs(shiftY) < 0.05 ? "" : `translateY(${-shiftY}px)`;
  return {
    position: "absolute",
    left: frame.left,
    top: frame.top,
    width: frame.width,
    minHeight: frame.height,
    transform: `${rotate} ${shift}`.trim() || undefined,
    transformOrigin: "0 0",
  };
}

/** Estilo completo (marco + tipografia) de un cuadro de texto a la escala de la hoja. */
export function textBoxStyle(frame: TextFrame, css: TextCssInput, scale: number): CSSProperties {
  const shift = previewBaselineShift(
    { ...css, lineHeight: css.lineHeight ?? DEFAULT_LINE_HEIGHT },
    scale,
  );
  return { ...frameStyle(frame, shift), ...textCssStyle(css, scale) };
}

export type InlineExitReason = "escape" | "shift-enter" | "blur";

export type InlineTextEditorProps = {
  frame: TextFrame;
  /** Texto de fuera (sesion); el DOM se reescribe solo si difiere. */
  text: string;
  css: TextCssInput;
  scale: number;
  label: string;
  hint: string;
  /** Caracter tecleado que abrio la edicion: se inserta al final al entrar. */
  seed?: string;
  onTextChange: (text: string) => void;
  onExit: (reason: InlineExitReason, relatedTarget: Element | null) => void;
  onHistory: (action: "undo" | "redo") => void;
};

/** Ultimo nodo de texto del editor, o `null` si no tiene ninguno. */
function lastTextNode(element: HTMLElement): Text | null {
  let found: Text | null = null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) found = node as Text;
  return found;
}

/**
 * El editor siempre tiene un nodo de texto (aunque este vacio): con el cursor DENTRO de
 * un nodo de texto el navegador consume Inicio, Fin, Re Pag, Av Pag y las flechas; con el
 * cursor en el elemento vacio no las consume y la pagina entera se desplaza.
 */
function ensureTextNode(element: HTMLElement): Text {
  const existing = lastTextNode(element);
  if (existing) return existing;
  const node = document.createTextNode("");
  element.appendChild(node);
  return node;
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const node = ensureTextNode(element);
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

type NavigationKey = "Home" | "End" | "PageUp" | "PageDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
const NAVIGATION_KEYS: readonly string[] = [
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
];

type ModifiableSelection = Selection & {
  modify?: (alter: "move" | "extend", direction: "forward" | "backward", granularity: string) => void;
};

/**
 * Mueve el cursor a mano para las teclas de navegacion y devuelve `true`: el editor
 * SIEMPRE las controla (se llama a `preventDefault`). Si se dejara la accion por defecto
 * y el cursor no puede moverse (ya al final al pulsar Fin, primera linea al pulsar Flecha
 * arriba, o sin nodo de texto), el navegador desplaza la PAGINA entera cientos de px y la
 * barra flotante se oculta. Re Pag y Av Pag van al inicio y al fin del texto: el editor
 * es una caja pequena, no hay paginas que recorrer.
 */
function moveCaret(element: HTMLElement, event: ReactKeyboardEvent<HTMLDivElement>): boolean {
  const key = event.key as NavigationKey;
  const selection = window.getSelection() as ModifiableSelection | null;
  if (!selection) return false;
  const inside =
    selection.rangeCount > 0 &&
    selection.anchorNode?.nodeType === 3 &&
    element.contains(selection.anchorNode);
  if (!inside) {
    // Cursor en el elemento o fuera: se vuelve a poner DENTRO de un nodo de texto antes de moverlo.
    placeCaretAtEnd(element);
  }
  const extend = event.shiftKey;
  const alter = extend ? "extend" : "move";
  const ctrl = event.ctrlKey;
  const meta = event.metaKey;
  const collapsed = selection.isCollapsed;

  const modify = (forward: boolean, granularity: string) => {
    if (selection.modify) {
      selection.modify(alter, forward ? "forward" : "backward", granularity);
      return;
    }
    // Sin Selection.modify: inicio / fin de todo el texto.
    const node = ensureTextNode(element);
    const range = document.createRange();
    range.setStart(node, forward ? node.data.length : 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  switch (key) {
    case "Home":
      modify(false, ctrl ? "documentboundary" : "lineboundary");
      return true;
    case "End":
      modify(true, ctrl ? "documentboundary" : "lineboundary");
      return true;
    case "PageUp":
      modify(false, "documentboundary");
      return true;
    case "PageDown":
      modify(true, "documentboundary");
      return true;
    case "ArrowLeft":
    case "ArrowRight": {
      const forward = key === "ArrowRight";
      if (!extend && !collapsed) {
        // Con una seleccion, la flecha la colapsa en su extremo (como el navegador).
        if (forward) selection.collapseToEnd();
        else selection.collapseToStart();
        return true;
      }
      modify(forward, meta ? "lineboundary" : ctrl ? "word" : "character");
      return true;
    }
    case "ArrowUp":
      modify(false, meta ? "documentboundary" : "line");
      return true;
    case "ArrowDown":
      modify(true, meta ? "documentboundary" : "line");
      return true;
    default:
      return false;
  }
}

/**
 * Inserta texto plano en el cursor. Se hace a mano (nodo de texto en el rango
 * actual) y no con `execCommand("insertText")`: ese crea bloques <div> con los
 * saltos de linea, y aqui el texto es plano con "\n". El historial es el de la
 * sesion, asi que no se pierde nada del deshacer nativo.
 */
function insertPlainText(element: HTMLElement, text: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) {
    placeCaretAtEnd(element);
  }
  const range = window.getSelection()?.getRangeAt(0);
  if (!range) return;
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

export function InlineTextEditor({
  frame,
  text,
  css,
  scale,
  label,
  hint,
  seed,
  onTextChange,
  onExit,
  onHistory,
}: InlineTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const hintId = useId();
  const emitted = useRef(text);

  useEffect(() => {
    ensureCatalogFontFaces();
  }, []);

  /* El DOM se reescribe solo cuando el texto de fuera ya no es el que hay (deshacer, rehacer). */
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || composingRef.current) return;
    if (readEditableText(element) !== text) {
      element.textContent = text;
      if (document.activeElement === element) placeCaretAtEnd(element);
    }
    emitted.current = text;
  }, [text]);

  /* Al entrar: foco, cursor al final y, si la edicion la abrio una tecla, esa tecla. */
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    placeCaretAtEnd(element);
    if (seed) insertPlainText(element, seed);
    // Solo al montar: `seed` y el foco inicial no deben repetirse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* El undo/redo del menu del navegador (o del movil) tambien va al historial de la sesion. */
  const historyRef = useRef(onHistory);
  useEffect(() => {
    historyRef.current = onHistory;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
      event.preventDefault();
      historyRef.current(event.inputType === "historyUndo" ? "undo" : "redo");
    };
    element.addEventListener("beforeinput", onBeforeInput);
    return () => element.removeEventListener("beforeinput", onBeforeInput);
  }, []);

  const emit = () => {
    const element = ref.current;
    if (!element) return;
    const value = readEditableText(element);
    if (value === emitted.current) return;
    emitted.current = value;
    onTextChange(value);
  };

  const onInput = (event: ReactFormEvent<HTMLDivElement>) => {
    if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
    emit();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    const history = matchUndoRedoShortcut(event.nativeEvent);
    if (history) {
      event.preventDefault();
      onHistory(history);
      return;
    }
    if (NAVIGATION_KEYS.includes(event.key) && ref.current && !event.altKey) {
      // Inicio, Fin, Re Pag, Av Pag y flechas NUNCA llegan a la pagina (la desplazarian, aun con el cursor en el texto).
      if (moveCaret(ref.current, event)) event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onExit("escape", null);
    } else if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      onExit("shift-enter", null);
    }
  };

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (pasted && ref.current) insertPlainText(ref.current, pasted);
  };

  return (
    <>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-describedby={hintId}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        autoCapitalize="off"
        data-inline-editor=""
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          emit();
        }}
        onBlur={(event) => {
          if (composingRef.current) return;
          onExit("blur", event.relatedTarget instanceof Element ? event.relatedTarget : null);
        }}
        className="pointer-events-auto z-[6] cursor-text whitespace-pre-wrap"
        style={{
          ...textBoxStyle(frame, css, scale),
          outline: "2px solid var(--color-signal)",
          outlineOffset: 2,
        }}
      />
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </>
  );
}
