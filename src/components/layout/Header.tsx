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
  GROUP_ORDER,
  getFeaturedTools,
  getToolsByCategory,
  getToolsByGroup,
  getToolsBySuite,
  toolHref,
  type Tool,
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
      data-site-header=""
      data-scrolled={scrolled ? "true" : "false"}
      className="material-thick scroll-edge-bottom safe-top sticky top-0 z-40 lg:hidden"
      /* El material trae borde en los cuatro lados; una barra pegada al
         viewport no debe dibujar ninguno: el hairline lo pone el borde de
         scroll cuando toca. Inline porque `border-0` pierde en la cascada
         frente al shorthand del material. */
      style={{ borderWidth: 0 }}
    >
      <div className="@container mx-auto flex h-14 max-w-[1200px] items-center gap-4 pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] md:h-16 md:pl-[max(1.5rem,env(safe-area-inset-left,0px))] md:pr-[max(1.5rem,env(safe-area-inset-right,0px))]">
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
                "flex h-9 items-center gap-1 rounded-full px-3 text-subheadline font-medium whitespace-nowrap select-none pointer-coarse:h-11",
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
                {/* Tres suites: OptimusPDF (seis categorias), OptimusSCAN y OptimusTOOLS (sus grupos). Mismo orden que la barra lateral. */}
                <h3 className="ui-label px-3 pt-1 pb-1 text-caption text-foreground">
                  {t.suites.pdf.label}
                </h3>
                <div className="grid grid-cols-2 gap-x-2 gap-y-3">
                  {CATEGORY_ORDER.map((category) => (
                    <ToolMenuSection
                      key={category}
                      id={`${menuId}-${category}`}
                      title={t.categories[category].label}
                      tools={getToolsByCategory(category)}
                      onPick={() => setOpen(false)}
                    />
                  ))}
                </div>
                <h3 className="ui-label mt-4 px-3 pt-1 pb-1 text-caption text-foreground">
                  {t.suites.scan.label}
                </h3>
                <ToolMenuList tools={getToolsBySuite("scan")} onPick={() => setOpen(false)} />
                <h3 className="ui-label mt-4 px-3 pt-1 pb-1 text-caption text-foreground">
                  {t.suites.tools.label}
                </h3>
                <div className="grid grid-cols-2 gap-x-2 gap-y-3">
                  {GROUP_ORDER.map((group) => (
                    <ToolMenuSection
                      key={group}
                      id={`${menuId}-${group}`}
                      title={t.groups[group].label}
                      tools={getToolsByGroup(group)}
                      onPick={() => setOpen(false)}
                    />
                  ))}
                </div>
                <div className="mt-2 border-t border-hairline px-3 pt-2 pb-1">
                  <Link
                    href="/"
                    onClick={() => setOpen(false)}
                    className="inline-flex h-9 items-center text-footnote font-semibold text-signal-text pointer-coarse:h-11 hover:text-glow"
                  >
                    {t.nav.allTools}
                  </Link>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Enlaces secundarios: solo si caben. Con la fuente del sistema al 150 % en un iPad de 834 px sumaban 118 px de desborde
            horizontal; el umbral esta en rem (consulta de contenedor), asi que se adapta a cualquier tamano de fuente. */}
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <Link
            href="/documents"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors pointer-coarse:h-11 hover:text-foreground md:@min-[42rem]:flex"
          >
            {t.nav.documents}
          </Link>
          <Link
            href="/pricing"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors pointer-coarse:h-11 hover:text-foreground md:@min-[42rem]:flex"
          >
            {t.nav.pricing}
          </Link>
          <Link
            href="/about"
            className="hidden h-9 items-center rounded-full px-3 text-subheadline text-muted-foreground transition-colors pointer-coarse:h-11 hover:text-foreground md:@min-[42rem]:flex"
          >
            {t.nav.about}
          </Link>
          <LanguageToggle className="md:ml-2" />
        </div>
      </div>
    </header>
  );
}

/** Seccion del menu (categoria de PDF o grupo de OptimusTOOLS): titulo de nivel 4 y la lista de sus herramientas. */
function ToolMenuSection({
  id,
  title,
  tools,
  onPick,
}: {
  id: string;
  title: string;
  tools: Tool[];
  onPick: () => void;
}) {
  return (
    <section aria-labelledby={id}>
      <h4 id={id} className="ui-label px-3 pt-1 pb-1 text-caption text-muted-foreground">
        {title}
      </h4>
      <ToolMenuList tools={tools} onPick={onPick} />
    </section>
  );
}

/** Enlaces de herramienta del menu. Segun su `status`: live = enlace normal; soon = el mismo enlace con la insignia «Próximamente». */
function ToolMenuList({ tools, onPick }: { tools: Tool[]; onPick: () => void }) {
  const t = useT();
  return (
    <ul>
      {tools.map((tool) => {
        const Icon = tool.icon;
        return (
          <li key={tool.slug}>
            <Link
              href={toolHref(tool.slug)}
              onClick={onPick}
              className="flex h-10 items-center gap-2.5 rounded-ios-sm px-3 transition-colors duration-[var(--duration-fast)] pointer-coarse:h-11 hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
            >
              <Icon aria-hidden="true" className={cn("size-4 shrink-0", ACCENT_TEXT[tool.accent])} />
              <span className="min-w-0 truncate text-subheadline font-medium text-foreground">
                {t.tools[tool.slug].name}
              </span>
              {tool.status === "soon" ? (
                <Badge variant="soon" className="ml-auto shrink-0">
                  {t.nav.soonShort}
                </Badge>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
