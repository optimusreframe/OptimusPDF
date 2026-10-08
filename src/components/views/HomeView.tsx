"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { FileText, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { onSectionRequest } from "@/components/layout/activeSection";
import { ToolCatalogGrid, filterTools } from "@/components/tool/ToolCatalogGrid";
import { useRecentEntries } from "@/hooks/useRecentEntries";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { rankByUsage } from "@/lib/recent";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  TOOL_SLUGS,
  TOOLS,
  getTool,
  toolHref,
  type ToolSlug,
} from "@/lib/tools-registry";

function isKnownSlug(slug: string): slug is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(slug);
}

/** El atajo no debe robar el foco a otro campo donde se este escribiendo. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Pantalla de inicio de la app y unico punto de entrada al catalogo: sin
 * hero ni copy de marketing, va directo a el. `/tools` existia como una
 * copia de esta misma pantalla (mismo `ToolCatalogGrid`) -- se elimino
 * (ver `next.config.ts` para el redirect) en vez de mantener dos rutas
 * que nunca podian divergir.
 *
 * Arriba: titulo, estado (privacidad y disponibilidad) y un buscador tipo
 * Spotlight que filtra el catalogo en vivo en el mismo sitio (el campo
 * nunca se mueve). Atajos: `/` o Cmd/Ctrl+K enfocan, Escape limpia (y
 * con el campo ya vacio, lo suelta), Enter abre el primer resultado.
 * "Mas usadas" (rankeado por frecuencia real con `rankByUsage`) se oculta
 * mientras se busca para que los resultados queden justo bajo el campo.
 */
export function HomeView() {
  const t = useT();
  const router = useRouter();
  const entries = useRecentEntries();
  const known = entries.filter((entry) => isKnownSlug(entry.slug));
  const mostUsed = rankByUsage(known, 4);
  const live = TOOLS.filter((tool) => tool.status === "live").length;
  const soon = TOOLS.length - live;

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const searching = query.trim().length > 0;
  /* Ancla pedida mientras se buscaba: se desplaza cuando el catalogo vuelve. */
  const pendingSectionRef = useRef<string | null>(null);
  const searchingRef = useRef(false);
  useEffect(() => {
    searchingRef.current = searching;
  }, [searching]);

  useEffect(
    () =>
      onSectionRequest((category) => {
        if (!searchingRef.current) return;
        pendingSectionRef.current = category;
        setQuery("");
      }),
    [],
  );

  useEffect(() => {
    const pending = pendingSectionRef.current;
    if (!pending || searching) return;
    pendingSectionRef.current = null;
    const target = document.getElementById(pending);
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    }
  }, [searching]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSlash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      const isCmdK =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
      if (!isSlash && !isCmdK) return;
      if (isSlash && isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-5 pb-16 md:px-6 md:pt-10">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h1 className="text-title-1 text-foreground">{t.home.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="live" dot>
            {t.common.localAndZeroUploads}
          </Badge>
          <Badge variant="neutral">
            {live} {t.home.liveCount}
          </Badge>
          {soon > 0 ? (
            <Badge variant="neutral">
              {soon} {t.home.soonCount}
            </Badge>
          ) : null}
          <Link
            href="/privacy"
            className="inline-flex h-11 items-center rounded-ios-sm px-1 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.footer.privacy}
          </Link>
        </div>
      </div>

      <form
        role="search"
        className="relative mb-8 max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          const first = filterTools(query, t)[0];
          if (searching && first) router.push(toolHref(first.slug));
        }}
      >
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (query) setQuery("");
            else event.currentTarget.blur();
          }}
          placeholder={t.home.searchPlaceholder}
          aria-label={t.home.searchPlaceholder}
          aria-controls={resultsId}
          aria-keyshortcuts="/ Meta+K Control+K"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          className={cn(
            "h-12 w-full rounded-ios-sm border border-hairline bg-white/5 pr-14 pl-12 text-body text-foreground",
            "placeholder:text-muted-foreground",
            "transition-[border-color,background-color] duration-[var(--duration-fast)]",
            "focus:border-signal/60 focus:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {searching ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label={t.home.clearSearch}
            className="group absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-white/10 text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/15 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
              <X className="size-3.5" strokeWidth={2.5} />
            </span>
          </button>
        ) : (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-3 hidden h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-md border border-hairline bg-white/5 px-1.5 text-caption font-medium text-muted-foreground pointer-fine:flex"
          >
            /
          </kbd>
        )}
      </form>

      {!searching && mostUsed.length > 0 ? (
        <section className="mb-12" aria-labelledby="most-used-title">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="most-used-title" className="text-title-3 text-foreground">
              {t.home.mostUsedTitle}
            </h2>
            <Link
              href="/recent"
              className="inline-flex h-11 items-center rounded-ios-sm px-1 text-footnote font-semibold text-signal-text hover:text-glow"
            >
              {t.home.mostUsedSeeAll}
            </Link>
          </div>
          <ul className="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:-mx-6 md:px-6">
            {mostUsed.map((ranked) => {
              const tool = getTool(ranked.slug);
              const Icon = tool.icon;
              return (
                <li key={ranked.slug} className="shrink-0">
                  <Link
                    href={toolHref(ranked.slug)}
                    className={cn(
                      "surface-card flex w-48 flex-col gap-3 rounded-ios p-3.5",
                      "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                      "hover:border-hairline-strong hover:bg-elevated",
                      "active:scale-[0.99] active:duration-[80ms]",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-9 items-center justify-center rounded-ios-sm",
                        ACCENT_BG_SOFT[tool.accent],
                      )}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn("size-4", ACCENT_TEXT[tool.accent])}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-subheadline font-semibold text-foreground">
                        {t.tools[ranked.slug].name}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-caption text-muted-foreground">
                        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="truncate">{ranked.latest.fileName}</span>
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <ToolCatalogGrid
        id={resultsId}
        query={query}
        onClearQuery={() => {
          setQuery("");
          inputRef.current?.focus();
        }}
      />
    </div>
  );
}
