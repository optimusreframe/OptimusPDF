"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, MoreHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type MoreMenuItem = {
  id: string;
  label: string;
  /** Texto del atajo (informativo). */
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Elemento de menu con estado (`menuitemcheckbox`). */
  checked?: boolean;
  /** Solo se pinta en pantallas estrechas (p. ej. «Cerrar documento», que en escritorio es un boton aparte). */
  narrowOnly?: boolean;
  separatorBefore?: boolean;
};

export type MoreMenuProps = {
  label: string;
  items: readonly MoreMenuItem[];
  /** Icono del boton (por defecto los tres puntos). */
  icon?: LucideIcon;
  /** Identificador del menu (`data-menu`): las pruebas y los atajos lo localizan con el. */
  menuId?: string;
  /** Oculta el menu entero (no solo su contenido) por debajo de este punto de corte. */
  hiddenBelow?: "sm";
  /** Cada vez que sube, el menu se abre (atajos de teclado, p. ej. Ctrl+Mayus+S). */
  openSignal?: number;
};

/**
 * Menu «Mas» (patron WAI-ARIA de boton de menu): el boton abre una lista `menu` con foco en la primera opcion;
 * flechas, Inicio y Fin se mueven; Esc cierra y devuelve el foco al boton; un clic fuera o Tab lo cierran.
 * Las opciones desactivadas siguen siendo enfocables (`aria-disabled`) y no hacen nada.
 */
export function MoreMenu({ label, items, icon: Icon = MoreHorizontal, menuId: dataMenu, hiddenBelow, openSignal = 0 }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  // Abrir por peticion externa (atajo): la senal se compara con la ultima vista durante el pintado (estado derivado).
  const [seenSignal, setSeenSignal] = useState(openSignal);
  if (openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    setOpen(true);
  }
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /** Opciones que el teclado recorre: las `narrowOnly` estan ocultas (`sm:hidden`) en pantallas anchas y no se enfocan. */
  const itemElements = () => {
    const wide = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches;
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []).filter(
      (element) => !(wide && element.closest(".sm\\:hidden")),
    );
  };

  /* Al abrir, el foco va a la primera opcion. */
  useEffect(() => {
    if (!open) return;
    itemElements()[0]?.focus();
  }, [open]);

  /* Clic o toque fuera: cierra. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const elements = itemElements();
    const at = elements.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => elements[(index + elements.length) % elements.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(at - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(elements.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        // El menu no atrapa el foco: Tab lo cierra y sigue su camino.
        setOpen(false);
        break;
      default:
    }
  };

  return (
    <div ref={rootRef} data-menu={dataMenu} className={cn("relative", hiddenBelow === "sm" && "max-sm:hidden")}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]"
      >
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-foreground transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-active:scale-90",
            open && "bg-white/10",
            "forced-colors:border forced-colors:border-[ButtonText]",
          )}
        >
          <Icon aria-hidden="true" className="size-[18px]" />
        </span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute top-full right-0 z-50 mt-1 w-64 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-ios border border-hairline bg-elevated p-1.5 shadow-elevation-3 forced-colors:border-[CanvasText]"
        >
          {items.map((item) => {
            const role = item.checked === undefined ? "menuitem" : "menuitemcheckbox";
            return (
              <div key={item.id} role="none" className={cn(item.narrowOnly && "sm:hidden")}>
                {item.separatorBefore ? <div role="separator" className="my-1 h-px bg-[var(--color-hairline)]" /> : null}
                <button
                  type="button"
                  role={role}
                  tabIndex={-1}
                  aria-checked={item.checked}
                  aria-disabled={item.disabled || undefined}
                  data-menu-item={item.id}
                  onClick={() => {
                    if (item.disabled) return;
                    // El foco vuelve al boton ANTES de actuar: la opcion desaparece con el menu y, sin esto, una hoja
                    // que se abra aqui recordaria <body> como el sitio al que volver al cerrarse.
                    close(true);
                    item.onSelect();
                  }}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 rounded-ios-sm px-3 py-1.5 text-left text-subheadline leading-snug text-foreground",
                    "hover:bg-white/8 focus-visible:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
                    item.disabled && "opacity-40",
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {item.checked ? <Check aria-hidden="true" className="size-4" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.shortcut ? (
                    <kbd className="shrink-0 font-sans text-caption text-muted-foreground">{item.shortcut}</kbd>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
