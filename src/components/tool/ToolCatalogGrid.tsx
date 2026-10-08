"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { SearchX } from "lucide-react";
import { ToolCard } from "@/components/tool/ToolCard";
import { ToolIconTile } from "@/components/tool/ToolIconTile";
import { Button } from "@/components/ui/Button";
import {
  requestSection,
  setActiveSection,
  useActiveSection,
} from "@/components/layout/activeSection";
import { getDocumentHeight, useScrollEdge } from "@/components/layout/useScrollEdge";
import { useT, type Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";
import {
  CATEGORY_ORDER,
  TOOLS,
  getToolsByCategory,
  type Tool,
  type ToolCategory,
} from "@/lib/tools-registry";

/** Normaliza para comparar: minusculas, sin diacriticos ni espacios sobrantes. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Filtro del catalogo. Cada palabra de la consulta tiene que aparecer en
 * el nombre, la descripcion o la etiqueta de categoria (sin acentos ni
 * mayusculas). Orden: primero las que empiezan por la consulta en el
 * nombre, luego las que la contienen en el nombre, luego el resto;
 * dentro de cada grupo se conserva el orden del catalogo. Consulta vacia
 * -> catalogo completo.
 */
export function filterTools(query: string, t: Dictionary): Tool[] {
  const folded = foldText(query);
  if (!folded) return TOOLS;
  const words = folded.split(/\s+/).filter(Boolean);
  const scored: { tool: Tool; rank: number }[] = [];
  for (const tool of TOOLS) {
    const name = foldText(t.tools[tool.slug].name);
    const haystack = `${name} ${foldText(t.tools[tool.slug].description)} ${foldText(
      t.categories[tool.category].label,
    )}`;
    if (!words.every((word) => haystack.includes(word))) continue;
    const rank = name.startsWith(folded) ? 0 : name.includes(folded) ? 1 : 2;
    scored.push({ tool, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank).map((entry) => entry.tool);
}

export type ToolCatalogGridProps = {
  /** Texto del buscador de Home. Vacio = catalogo completo por categorias. */
  query?: string;
  /** Limpia el buscador desde el estado vacio de resultados. */
  onClearQuery?: () => void;
  /** Id del contenedor de resultados (lo referencia `aria-controls` del buscador). */
  id?: string;
};

/*
 * Altura por encima de la que una seccion cuenta como "a la vista": las
 * barras fijas (cabecera 56/64 px + chips 48 px) mas el alto de la propia
 * cabecera de seccion, para que cambie en cuanto el titulo asoma bajo las
 * barras y no una linea despues.
 */
const SPY_OFFSET = 160;

/**
 * Catalogo completo agrupado por categoria: grid denso de iconos en movil,
 * tarjetas en tablet/escritorio. Con `query` pasa a una lista plana de
 * resultados en el mismo contenedor (el buscador no se mueve). Publica la
 * categoria visible (scroll-spy) para el Sidebar y la barra de chips.
 */
export function ToolCatalogGrid({ query = "", onClearQuery, id }: ToolCatalogGridProps) {
  const t = useT();
  const searching = foldText(query).length > 0;
  const results = searching ? filterTools(query, t) : TOOLS;
  const sectionsRef = useRef<Map<ToolCategory, HTMLElement>>(new Map());

  /*
   * Scroll-spy por posicion (no IntersectionObserver: un salto por ancla
   * cruza varias secciones en un solo frame y el observer no ve el cruce).
   * Las posiciones de las secciones se cachean en coordenadas de documento
   * y solo se recalculan cuando cambia el layout (ResizeObserver/resize):
   * por frame de scroll solo se leen scrollY/innerHeight/scrollHeight.
   */
  useEffect(() => {
    if (searching) {
      setActiveSection(null);
      return;
    }
    let frame = 0;
    let tops: { category: ToolCategory; top: number }[] = [];
    const measure = () => {
      tops = [];
      for (const category of CATEGORY_ORDER) {
        const element = sectionsRef.current.get(category);
        if (!element) continue;
        tops.push({
          category,
          top: element.getBoundingClientRect().top + window.scrollY,
        });
      }
    };
    const update = () => {
      frame = 0;
      const line = window.scrollY + SPY_OFFSET;
      let active: ToolCategory | null = null;
      for (const entry of tops) if (entry.top <= line) active = entry.category;
      // Al final de la pagina la ultima seccion puede no alcanzar el
      // umbral: si no queda mas scroll, manda la ultima.
      const atBottom =
        window.scrollY + window.innerHeight >= getDocumentHeight() - 2;
      if (atBottom && window.scrollY > 0) active = CATEGORY_ORDER[CATEGORY_ORDER.length - 1];
      setActiveSection(active);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    const remeasure = () => {
      // Tras un cambio de tamaño el alto cacheado de useScrollEdge ya se
      // ha actualizado (mismo ResizeObserver sobre body, registrado antes).
      measure();
      schedule();
    };
    measure();
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", remeasure);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null;
    observer?.observe(document.body);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      setActiveSection(null);
    };
  }, [searching]);

  if (searching) {
    const count = results.length;
    return (
      <div id={id} aria-live="polite" aria-atomic="false">
        <h2 className="ui-label mb-4 text-muted-foreground">
          {count}{" "}
          {count === 1 ? t.home.resultOne : t.home.resultMany}
          {" · "}
          <span className="text-foreground">«{query.trim()}»</span>
        </h2>
        {count > 0 ? (
          <>
            <ul className="grid grid-cols-4 gap-x-2 gap-y-5 sm:hidden">
              {results.map((tool) => (
                <li key={tool.slug}>
                  <ToolIconTile tool={tool} />
                </li>
              ))}
            </ul>
            <ul className="hidden gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3">
              {results.map((tool) => (
                <li key={tool.slug}>
                  <ToolCard tool={tool} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="surface-card flex flex-col items-center rounded-ios px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-white/8 text-muted-foreground">
              <SearchX aria-hidden="true" className="size-5" />
            </span>
            <p className="mt-4 text-headline text-foreground">
              {t.home.searchEmptyTitle}
            </p>
            <p className="mt-1 max-w-sm text-subheadline text-muted-foreground">
              {t.home.searchEmptyHint}
            </p>
            {onClearQuery ? (
              <Button
                variant="secondary"
                size="md"
                className="mt-5"
                onClick={onClearQuery}
              >
                {t.home.clearSearch}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <div id={id}>
      <CategoryChips />
      <div className="space-y-14">
        {CATEGORY_ORDER.map((category) => (
          <section
            key={category}
            id={category}
            aria-labelledby={`${category}-title`}
            ref={(element) => {
              if (element) sectionsRef.current.set(category, element);
              else sectionsRef.current.delete(category);
            }}
            className="scroll-mt-32 md:scroll-mt-[8.5rem] lg:scroll-mt-6"
          >
            <div className="mb-4 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
              <h2
                id={`${category}-title`}
                className="text-title-3 text-foreground"
              >
                {t.categories[category].label}
              </h2>
              <p className="text-subheadline text-muted-foreground">
                {t.categories[category].description}
              </p>
            </div>
            <ul className="grid grid-cols-4 gap-x-2 gap-y-5 sm:hidden">
              {getToolsByCategory(category).map((tool) => (
                <li key={tool.slug}>
                  <ToolIconTile tool={tool} />
                </li>
              ))}
            </ul>
            <ul className="hidden gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3">
              {getToolsByCategory(category).map((tool) => (
                <li key={tool.slug}>
                  <ToolCard tool={tool} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Barra de categorias (anclas) por debajo de 1024px, donde no hay
 * Sidebar: se pega bajo la cabecera y resalta la seccion visible con un
 * pulgar que se desliza con spring. Cada ancla mide 44 px de alto
 * aunque el chip visible sea de 32.
 */
function CategoryChips() {
  const t = useT();
  const active = useActiveSection();
  const scrolled = useScrollEdge("top");
  const listRef = useRef<HTMLUListElement>(null);

  // El chip activo se mantiene a la vista dentro del carrusel.
  useEffect(() => {
    if (!active || !listRef.current) return;
    const chip = listRef.current.querySelector<HTMLElement>(
      `[data-category="${active}"]`,
    );
    // jsdom no implementa scrollIntoView: en tests simplemente no desplaza.
    if (typeof chip?.scrollIntoView === "function") {
      chip.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  return (
    <nav
      aria-label={t.nav.categoriesLabel}
      data-scrolled={scrolled ? "true" : "false"}
      className={cn(
        "material-thick scroll-edge-bottom sticky z-30 -mx-4 mb-6 md:-mx-6 lg:hidden",
        "top-[calc(3.5rem+env(safe-area-inset-top,0px))] md:top-16",
      )}
      style={{ borderWidth: 0 }}
    >
      <ul
        ref={listRef}
        className="scrollbar-none flex items-center gap-1 overflow-x-auto px-4 py-0.5 md:px-6"
      >
        {CATEGORY_ORDER.map((category) => {
          const isActive = active === category;
          return (
            <li key={category} className="shrink-0">
              <Link
                href={`/#${category}`}
                onClick={() => requestSection(category)}
                data-category={category}
                aria-current={isActive ? "location" : undefined}
                className="group flex h-11 items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal"
              >
                <span
                  className={cn(
                    "relative isolate flex h-8 items-center rounded-full px-3.5 text-footnote font-semibold whitespace-nowrap",
                    "transition-[color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                    "group-active:scale-[0.96] group-active:duration-[80ms]",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {isActive ? (
                    <motion.span
                      aria-hidden="true"
                      layoutId="category-chip-pill"
                      transition={springs.snappy}
                      className="absolute inset-0 -z-10 rounded-full bg-white/10"
                    />
                  ) : null}
                  {t.categories[category].label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
