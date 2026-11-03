"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Pin, Settings2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useOptionalLanguage } from "@/lib/i18n";
import { tagLabel, type TaggableType } from "@/lib/fieldTags";
import { customTagNames, useValueHistoryVersion, type RankedSuggestion } from "@/lib/valueHistory";
import { findScrollParent, scrollVerticallyBy } from "@/lib/touch/scrollRegion";
import { FieldTagPicker, TagGlyph, keepInputFocus } from "@/app/sign-pdf/FieldTagPicker";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

/**
 * Barra de sugerencias SOBRE EL TECLADO (pantallas tactiles). Sustituye a la lista que salia dentro del recuadro del campo
 * —pequeña y tapada por el teclado en iPad/iPhone—. Es una barra fija pegada al borde inferior de la VENTANA VISUAL
 * (`visualViewport`): con el teclado virtual abierto, esa ventana es la que queda por encima de el. Fondo OPACO
 * (`bg-elevated`, no un material translucido): es una barra de trabajo pegada al teclado y lo que hay detras (la pagina, la
 * barra de pestañas) no debe asomar bajo el texto de los chips.
 *
 * Contenido: a la izquierda la pastilla de ETIQUETA del campo (un toque la cambia o, si el rótulo ya sugiere una, la pone) y,
 * a continuacion, los valores guardados como chips de >= 44 px, con la parte que coincide con lo escrito resaltada, en una fila
 * que se desplaza en horizontal. Pulsacion larga sobre un valor (o el boton «Gestionar», para quien no pueda mantener
 * pulsado o use un lector de pantalla) abre sus acciones: fijar arriba y olvidar; nada se borra con una «x» minuscula.
 *
 * El toque en un chip no le quita el foco al `<input>` del campo (`keepInputFocus`): el input cierra la edicion al perder el
 * foco, y sin esto el propio toque la cerraria antes de aplicarse. Lo mismo vale para cada boton de esta barra.
 */

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP_PX = 10;
/** Diferencia (px) entre la ventana y la ventana visual a partir de la cual hay un teclado virtual abierto. */
const KEYBOARD_MIN_PX = 120;

type ViewRect = { left: number; top: number; width: number; height: number; keyboard: boolean };

function readViewport(): ViewRect {
  const viewport = window.visualViewport;
  if (!viewport) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, keyboard: false };
  return {
    left: viewport.offsetLeft,
    top: viewport.offsetTop,
    width: viewport.width,
    height: viewport.height,
    keyboard: window.innerHeight - viewport.height > KEYBOARD_MIN_PX,
  };
}

/** La ventana visual (la que deja libre el teclado virtual), al dia con cada cambio de tamano o desplazamiento. */
function useVisualViewport(): ViewRect {
  const [rect, setRect] = useState<ViewRect>(readViewport);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setRect(readViewport());
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return rect;
}

/** Texto con la parte que coincide con lo escrito en negrita. */
function Highlighted({ item }: { item: RankedSuggestion }) {
  if (item.matchAt < 0 || item.matchLength === 0) return <>{item.value}</>;
  const end = item.matchAt + item.matchLength;
  return (
    <>
      {item.value.slice(0, item.matchAt)}
      <strong className="font-bold text-signal-text">{item.value.slice(item.matchAt, end)}</strong>
      {item.value.slice(end)}
    </>
  );
}

export type SuggestionBarProps = {
  /** Tipo de campo que admite etiqueta, o `null` (iniciales...): entonces la barra solo trae valores. */
  taggable: TaggableType | null;
  tag: string | null;
  /** Etiqueta que sugiere el rótulo del campo cuando aun no tiene. */
  impliedTag: string | null;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  suggestions: readonly RankedSuggestion[];
  highlightedIndex: number;
  onPick: (value: string) => void;
  onForget: (value: string) => void;
  onPin: (value: string, pinned: boolean) => void;
  onTag: (tag: string | null) => void;
  onOther: () => void;
  /** El `<input>` que se esta escribiendo: la pagina se desplaza lo justo para que no quede bajo la barra. */
  anchorRef: RefObject<HTMLElement | null>;
};

export function SuggestionBar({
  taggable,
  tag,
  impliedTag,
  pickerOpen,
  onPickerOpenChange,
  suggestions,
  highlightedIndex,
  onPick,
  onForget,
  onPin,
  onTag,
  onOther,
  anchorRef,
}: SuggestionBarProps) {
  const strings = useTagStrings();
  const language = useOptionalLanguage();
  useValueHistoryVersion();
  const custom = customTagNames();
  const view = useVisualViewport();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const [manage, setManage] = useState(false);
  const [menu, setMenu] = useState<RankedSuggestion | null>(null);
  const [status, setStatus] = useState("");
  const pressRef = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const tagName = tag ? tagLabel(tag, language, custom) : null;
  const impliedName = impliedTag ? tagLabel(impliedTag, language, custom) : null;

  // El menu de un valor que ya no esta en la lista (se olvido) se cierra.
  const menuValue = menu?.value ?? null;
  const menuStillListed = menuValue !== null && suggestions.some((item) => item.value === menuValue);
  if (menuValue !== null && !menuStillListed) setMenu(null);

  useEffect(
    () => () => {
      if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    },
    [],
  );

  // Que el campo que se escribe no quede tapado por la barra: se desplaza la pagina lo justo.
  useLayoutEffect(() => {
    const input = anchorRef.current;
    const root = rootRef.current;
    if (!input || !root) return;
    const frame = window.requestAnimationFrame(() => {
      const barTop = root.getBoundingClientRect().top;
      const overlap = input.getBoundingClientRect().bottom + 12 - barTop;
      if (overlap > 0) scrollVerticallyBy(findScrollParent(input), overlap);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchorRef, view.top, view.height, pickerOpen, suggestions.length]);

  // Con el teclado fisico (↑/↓), el valor resaltado se desplaza a la vista dentro de la fila.
  useEffect(() => {
    if (highlightedIndex < 0) return;
    const chip = listRef.current?.children[highlightedIndex];
    if (chip instanceof HTMLElement) chip.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlightedIndex]);

  const hasSuggestions = suggestions.length > 0;
  if (!taggable && !hasSuggestions) return null;

  const clearPress = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };
  const startPress = (event: ReactPointerEvent<HTMLButtonElement>, item: RankedSuggestion) => {
    keepInputFocus(event);
    clearPress();
    const timer = window.setTimeout(() => {
      if (pressRef.current) pressRef.current.fired = true;
      setMenu(item);
    }, LONG_PRESS_MS);
    pressRef.current = { timer, x: event.clientX, y: event.clientY, fired: false };
  };
  const movePress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press || press.fired) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) clearPress();
  };
  const choose = (item: RankedSuggestion) => {
    // Despues de una pulsacion larga el "click" que suelta el dedo no elige el valor.
    if (pressRef.current?.fired) {
      clearPress();
      return;
    }
    clearPress();
    if (manage) setMenu(item);
    else onPick(item.value);
  };

  const pillTap = () => {
    if (!tag && impliedTag && !pickerOpen) onTag(impliedTag);
    else onPickerOpenChange(!pickerOpen);
  };
  const pillText = tagName ?? (impliedName ? strings.pillSuggest(impliedName) : strings.pillNoTag);
  const pillLabel = tagName ? strings.pillTagged(tagName) : pillText;
  const keyboardPad = view.keyboard ? undefined : "env(safe-area-inset-bottom, 0px)";

  const bar = (
    <div
      ref={rootRef}
      role="region"
      aria-label={strings.barLabel(tagName)}
      data-suggestion-bar=""
      // El toque en la barra no es el inicio de un arrastre del campo (los eventos de un portal suben por el arbol de React).
      onPointerDown={(event) => event.stopPropagation()}
      className="fixed top-0 left-0 z-50 border-t border-white/14 bg-elevated shadow-elevation-3"
      style={{
        width: view.width,
        transform: `translate(${view.left}px, ${view.top + view.height}px) translateY(-100%)`,
        paddingBottom: keyboardPad,
      }}
    >
      {menu ? (
        <div
          role="group"
          aria-label={strings.manageTitle(menu.value)}
          data-suggestion-menu=""
          className="absolute bottom-full left-3 mb-2 flex max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-ios bg-elevated p-2 shadow-elevation-3 ring-1 ring-white/14"
        >
          <p className="truncate px-2 pt-1 text-footnote font-semibold text-foreground">{strings.manageTitle(menu.value)}</p>
          <MenuButton
            onClick={() => {
              onPin(menu.value, !menu.pinned);
              setStatus(menu.pinned ? strings.unpinnedNotice(menu.value) : strings.pinnedNotice(menu.value));
              setMenu(null);
            }}
          >
            <Pin aria-hidden="true" className="size-4" />
            {menu.pinned ? strings.unpin : strings.pin}
          </MenuButton>
          <MenuButton
            destructive
            onClick={() => {
              onForget(menu.value);
              setStatus(strings.forgotten(menu.value));
              setMenu(null);
            }}
          >
            <Trash2 aria-hidden="true" className="size-4" />
            {strings.forgetNamed(menu.value)}
          </MenuButton>
          <MenuButton onClick={() => setMenu(null)}>
            <X aria-hidden="true" className="size-4" />
            {strings.manageClose}
          </MenuButton>
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 py-1.5">
        {taggable ? (
          <button
            type="button"
            aria-label={pillLabel}
            aria-expanded={pickerOpen}
            data-tag-pill=""
            onPointerDown={keepInputFocus}
            onMouseDown={(event) => event.preventDefault()}
            onClick={pillTap}
            className={cn(
              "inline-flex min-h-11 max-w-[45%] shrink-0 items-center gap-1.5 rounded-full border px-3 text-footnote font-semibold text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100 transition-[scale,background-color]",
              tag ? "border-signal/60 bg-signal/20" : "border-white/20 bg-white/8",
            )}
          >
            <TagGlyph />
            <span className="truncate">{pillText}</span>
          </button>
        ) : null}

        {pickerOpen && taggable ? (
          <FieldTagPicker
            type={taggable}
            current={tag}
            suggested={impliedTag}
            keepFocus
            onPick={(next) => onTag(next)}
            onNone={() => onTag(null)}
            onOther={onOther}
            className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain py-0.5 [scrollbar-width:none]"
          />
        ) : hasSuggestions ? (
          <>
            <ul
              ref={listRef}
              className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overscroll-x-contain py-0.5 [scrollbar-width:none]"
              style={{ touchAction: "pan-x" }}
            >
              {suggestions.map((item, index) => (
                <li key={item.value} className="shrink-0">
                  <button
                    type="button"
                    data-suggestion=""
                    aria-current={index === highlightedIndex ? "true" : undefined}
                    aria-describedby={hintId}
                    onPointerDown={(event) => startPress(event, item)}
                    onPointerMove={movePress}
                    onPointerUp={() => {
                      /* el "click" que sigue decide (ver `choose`) */
                    }}
                    onPointerCancel={clearPress}
                    onContextMenu={(event) => event.preventDefault()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                    style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
                    className={cn(
                      "inline-flex min-h-11 max-w-[20rem] items-center gap-1.5 rounded-full px-3.5 text-footnote font-medium text-foreground",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100 transition-[scale,background-color]",
                      index === highlightedIndex ? "bg-signal/30 shadow-[inset_0_0_0_1.5px_var(--color-signal)]" : "bg-white/10 hover:bg-white/16",
                    )}
                  >
                    {item.pinned ? (
                      <>
                        <Pin aria-hidden="true" className="size-3.5 shrink-0 text-signal-text" />
                        <span className="sr-only">{strings.suggestionPinned}</span>
                      </>
                    ) : null}
                    <span className="truncate">
                      <Highlighted item={item} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              aria-pressed={manage}
              aria-label={manage ? strings.manageOff : strings.manageOn}
              title={manage ? strings.manageOff : strings.manageOn}
              onPointerDown={keepInputFocus}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setManage((on) => !on);
                setMenu(null);
              }}
              className={cn(
                "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100 transition-[scale,background-color]",
                manage ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)]" : "hover:bg-white/10 hover:text-foreground",
              )}
            >
              <Settings2 aria-hidden="true" className="size-5" />
            </button>
          </>
        ) : (
          <span className="flex-1" />
        )}
      </div>
      <p id={hintId} className="sr-only">
        {strings.suggestionHint}
      </p>
      {/* Region de estado siempre montada: solo cambia su contenido. */}
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );

  return createPortal(bar, document.body);
}

function MenuButton({
  children,
  onClick,
  destructive = false,
}: {
  children: ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onPointerDown={keepInputFocus}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-ios-sm px-3 text-left text-footnote font-semibold",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal active:scale-[0.98] transition-[scale,background-color]",
        destructive ? "text-destructive-text hover:bg-destructive/12" : "text-foreground hover:bg-white/10",
      )}
    >
      {children}
    </button>
  );
}
