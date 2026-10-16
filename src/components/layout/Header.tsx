"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs, withCrossFadeOpacity } from "@/lib/motion";
import {
  ACCENT_TEXT,
  CATEGORY_ORDER,
  getFeaturedTools,
  getToolsByCategory,
  toolHref,
} from "@/lib/tools-registry";

/**
 * Cabecera fija por debajo de 1024px (a partir de ahi manda el Sidebar).
 * Material grueso con el contenido pasando por debajo; el borde inferior
 * no es un divisor fijo sino el efecto de borde de scroll (aparece solo
 * cuando hay contenido desplazado). En tablet (>=768px) lleva un unico
 * menu "Herramientas" (seis botones de categoria con texto de sistema no
 * caben en 768 px) que abre un popover solido con el catalogo agrupado.
 */
export function Header() {
  const t = useT();
  const scrolled = useScrollEdge("top");
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    // Al cerrar por clic fuera, el foco vuelve al disparador solo si estaba
    // dentro del menu y el clic no lo llevo a otro control.
    const onPointerDown = (event: MouseEvent) => {
      if (navRef.current?.contains(event.target as Node)) return;
      const focusWasInside =
        menuRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (!focusWasInside) return;
      // El mousedown NO se cancela: su accion por defecto enfoca lo pulsado
      // (el buscador de Home, un enlace...) y cancelarla dejaba a la persona
      // sin poder escribir. Cuando esa accion ya se resolvio (setTimeout 0)
      // se mira donde quedo el foco: solo si cayo a <body> (zona no
      // enfocable) o sigue en el menu que se esta retirando vuelve al
      // disparador; si ya esta en otro control, se respeta.
      window.setTimeout(() => {
        const active = document.activeElement;
        const lost =
          !active ||
          active === document.body ||
          (menuRef.current?.contains(active) ?? false);
        if (lost) triggerRef.current?.focus();
      }, 0);
    };
    // Escape: cierra y devuelve siempre el foco al disparador.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <header
      data-scrolled={scrolled ? "true" : "false"}
      className="material-thick scroll-edge-bottom safe-top sticky top-0 z-40 lg:hidden"
      /* El material trae borde en los cuatro lados; una barra pegada al
         viewport no debe dibujar ninguno: el hairline lo pone el borde de
         scroll cuando toca. Inline porque `border-0` pierde en la cascada
         frente al shorthand del material. */
      style={{ borderWidth: 0 }}
    >
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-4 px-4 md:h-16 md:px-6">
        <Logo />

        <div ref={navRef} className="relative hidden flex-1 md:block">
          <nav aria-label={t.nav.categoriesLabel} className="flex items-center">
            <button
              ref={triggerRef}
              type="button"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              onClick={() => setOpen((value) => !value)}
              className={cn(
                "flex h-9 items-center gap-1 rounded-full px-3 text-subheadline font-medium whitespace-nowrap select-none",
                "transition-[color,background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                "active:scale-[0.97] active:duration-[80ms]",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                open
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.home.title}
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "size-3.5 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                  open && "rotate-180",
                )}
              />
            </button>
          </nav>

          <AnimatePresence>
            {open ? (
              <motion.div
                key="tools-menu"
                ref={menuRef}
                id={menuId}
                initial={{ opacity: 0, scale: 0.96, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: -4 }}
                transition={withCrossFadeOpacity(springs.snappy)}
                style={{ transformOrigin: "top left" }}
                className="absolute top-full left-0 z-50 mt-2 max-h-[min(70vh,40rem)] w-[640px] max-w-[calc(100vw-3rem)] overflow-y-auto overscroll-contain rounded-ios border border-hairline bg-elevated p-2 shadow-elevation-3"
              >
                <ul aria-label={t.home.featuredLabel} className="mb-3">
                  {getFeaturedTools().map((tool) => {
                    const Icon = tool.icon;
                    return (
                      <li key={tool.slug}>
                        <Link
                          href={toolHref(tool.slug)}
                          onClick={() => setOpen(false)}
                          className="flex min-h-11 items-center gap-3 rounded-ios-sm bg-accent-pro/10 px-3 py-2 transition-colors duration-[var(--duration-fast)] hover:bg-accent-pro/16 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
                        >
                          <Icon
                            aria-hidden="true"
                            className={cn("size-5 shrink-0", ACCENT_TEXT[tool.accent])}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-subheadline font-semibold text-foreground">
                              {t.tools[tool.slug].name}
                            </span>
                            <span className="block truncate text-caption text-muted-foreground">
                              {t.tools[tool.slug].description}
                            </span>
                          </span>
                          <Badge variant="signal" className="shrink-0">
                            {t.home.featuredBadge}
                          </Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                <div className="grid grid-cols-2 gap-x-2 gap-y-3">
                  {CATEGORY_ORDER.map((category) => (
                    <section key={category} aria-labelledby={`${menuId}-${category}`}>
                      <h3
                        id={`${menuId}-${category}`}
                        className="ui-label px-3 pt-1 pb-1 text-caption text-muted-foreground"
                      >
                        {t.categories[category].label}
                      </h3>
                      <ul>
                        {getToolsByCategory(category).map((tool) => {
                          const Icon = tool.icon;
                          return (
                            <li key={tool.slug}>
                              <Link
                                href={toolHref(tool.slug)}
                                onClick={() => setOpen(false)}
                                className="flex h-10 items-center gap-2.5 rounded-ios-sm px-3 transition-colors duration-[var(--duration-fast)] hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
                              >
                                <Icon
                                  aria-hidden="true"
                                  className={cn("size-4 shrink-0", ACCENT_TEXT[tool.accent])}
                                />
                                <span className="min-w-0 truncate text-subheadline font-medium text-foreground">
                                  {t.tools[tool.slug].name}
                                </span>
                                {tool.status === "soon" ? (
                                  <Badge variant="soon" className="ml-auto shrink-0">
                                    {t.common.soon}
                                  </Badge>
                                ) : null}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
                <div className="mt-2 border-t border-hairline px-3 pt-2 pb-1">
                  <Link
                    href="/"
                    onClick={() => setOpen(false)}
                    className="inline-flex h-9 items-center text-footnote font-semibold text-signal-text hover:text-glow"
                  >
                    {t.nav.allTools}
                  </Link>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <Link
            href="/documents"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors hover:text-foreground md:flex"
          >
            {t.nav.documents}
          </Link>
          <Link
            href="/pricing"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors hover:text-foreground md:flex"
          >
            {t.nav.pricing}
          </Link>
          <Link
            href="/about"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors hover:text-foreground md:flex"
          >
            {t.nav.about}
          </Link>
          <LanguageToggle className="md:ml-2" />
        </div>
      </div>
    </header>
  );
}
