"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Search } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { searchCommands, type ProCommand } from "@/app/pdf-pro/shell/proCommands";

/** Resultados que se muestran como mucho. */
const MAX_RESULTS = 60;
/** PageUp/PageDown dentro de la lista. */
const PAGE_STEP = 8;

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  commands: readonly ProCommand[];
  /** Comandos que dependen de lo escrito (p. ej. «Ir a la pagina 12»): van los primeros. */
  dynamicCommands?: (query: string) => ProCommand[];
  /** Anuncia por la region viva unica el numero de resultados. */
  announce?: (text: string) => void;
};

/**
 * Paleta de comandos (Cmd/Ctrl+K): dialogo modal con un campo de busqueda y una lista de resultados con el
 * patron «combobox + listbox» (`aria-activedescendant`: el foco se queda en el campo y las flechas mueven la
 * opcion activa). Busqueda difusa sin acentos. Esc cierra; Intro ejecuta; el foco vuelve a donde estaba salvo
 * que el comando lo haya llevado a otro sitio.
 */
export function CommandPalette({ open, onClose, commands, dynamicCommands, announce }: CommandPaletteProps) {
  const { t, language } = useI18n();
  const s = getProStrings(language).palette;
  /*
   * La hoja que se cierra sigue pintada hasta acabar su animacion de salida y su contenido conserva el
   * ultimo estado: este indicador (compartido por referencia) le avisa de que ya no debe anunciar nada.
   */
  const closingRef = useRef(false);
  useEffect(() => {
    if (open) closingRef.current = false;
  }, [open]);
  const handleClose = () => {
    closingRef.current = true;
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={handleClose}
      title={s.title}
      closeLabel={t.common.close}
      // El comando pudo llevar el foco a otra parte (una pagina, un panel): entonces no se le quita.
      restoreFocusOnClose={() => {
        // La hoja devuelve el foco al EMPEZAR a salir (con su panel aun en el DOM): ahi el foco esta en el campo, en el
        // propio panel (`run` se lo lleva) o en <body>; solo fuera de la hoja lo movio un comando.
        const active = document.activeElement;
        return !active || active === document.body || active.closest('[data-pro-palette], [role="dialog"]') !== null;
      }}
    >
      <PaletteBody
        commands={commands}
        dynamicCommands={dynamicCommands}
        announce={announce}
        onClose={handleClose}
        closingRef={closingRef}
      />
    </Sheet>
  );
}

function PaletteBody({
  commands,
  dynamicCommands,
  announce,
  onClose,
  closingRef,
}: Pick<CommandPaletteProps, "commands" | "dynamicCommands" | "announce" | "onClose"> & {
  closingRef: RefObject<boolean>;
}) {
  const { language } = useI18n();
  const strings = getProStrings(language);
  const s = strings.palette;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const extra = dynamicCommands ? dynamicCommands(query) : [];
    const found = searchCommands(commands, query, MAX_RESULTS);
    const ids = new Set(extra.map((command) => command.id));
    return [...extra, ...found.filter((command) => !ids.has(command.id))];
  }, [commands, dynamicCommands, query]);
  const active = Math.min(activeIndex, Math.max(0, results.length - 1));

  /* El campo toma el foco DESPUES de que la hoja se lo lleve a su panel. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /* Numero de resultados por la region viva unica (con una pausa: no por cada letra). */
  useEffect(() => {
    if (query.trim() === "" || !announce) return;
    const timer = window.setTimeout(() => {
      if (!closingRef.current) announce(s.resultsCount(results.length));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [query, results.length, announce, s, closingRef]);

  /* La opcion activa siempre a la vista. */
  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`);
    if (option && typeof option.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const run = (command: ProCommand | undefined) => {
    if (!command || command.disabled) return;
    // El campo deja de tener el foco YA (la hoja tarda en irse): con el foco en un campo de texto, atajos como
    // Ctrl+Z no actuarian sobre el documento justo despues de ejecutar un comando.
    inputRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    onClose();
    // Tras cerrar: el comando ve ya el estado sin la hoja.
    window.setTimeout(() => command.run(), 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(count === 0 ? 0 : (active + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(count === 0 ? 0 : (active - 1 + count) % count);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      setActiveIndex(Math.min(count - 1, active + PAGE_STEP));
    } else if (event.key === "PageUp") {
      event.preventDefault();
      setActiveIndex(Math.max(0, active - PAGE_STEP));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[active]);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      // El mismo atajo que la abre, la cierra.
      event.preventDefault();
      onClose();
    }
  };

  const groupLabel = (command: ProCommand) => s.groups[command.group ?? "other"];
  return (
    <div data-pro-palette="" className="flex flex-col gap-2">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={s.label}
          aria-activedescendant={results.length > 0 ? `${listId}-opt-${active}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={s.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          className="h-11 w-full rounded-ios-sm border border-hairline bg-white/5 pr-3 pl-9 text-body text-foreground pointer-coarse:text-base placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={s.resultsLabel}
        hidden={results.length === 0}
        className="max-h-[min(50dvh,24rem)] min-h-12 overflow-y-auto overscroll-contain"
      >
        {results.map((command, index) => {
          const isActive = index === active;
          return (
            <li
              key={command.id}
              id={`${listId}-opt-${index}`}
              role="option"
              aria-selected={isActive}
              aria-disabled={command.disabled || undefined}
              data-option-index={index}
              data-command-id={command.id}
              onMouseMove={() => {
                if (!isActive) setActiveIndex(index);
              }}
              onClick={() => run(command)}
              className={cn(
                "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-ios-sm px-3 py-2 text-subheadline",
                isActive ? "bg-signal/20 text-foreground forced-colors:border forced-colors:border-[Highlight]" : "text-foreground",
                command.disabled && "cursor-default opacity-50",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              {command.shortcut ? (
                <kbd className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 font-sans text-caption text-muted-foreground">
                  {command.shortcut}
                </kbd>
              ) : (
                <span className="shrink-0 text-caption text-muted-foreground">{groupLabel(command)}</span>
              )}
            </li>
          );
        })}
      </ul>
      {results.length === 0 ? (
        <p className="px-3 py-2 text-footnote text-muted-foreground" data-palette-empty="">
          {s.empty}
        </p>
      ) : null}
      <p className="px-1 text-caption text-muted-foreground">{s.hint}</p>
    </div>
  );
}
