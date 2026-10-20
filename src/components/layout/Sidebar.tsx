"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronsLeft,
  ChevronsRight,
  Clock,
  FolderOpen,
  House,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { requestSection, useActiveSection } from "@/components/layout/activeSection";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs, withCrossFadeOpacity } from "@/lib/motion";
import { useViewportTier } from "@/lib/touch/viewportTier";
import {
  ACCENT_TEXT,
  CATEGORY_ICON,
  CATEGORY_ORDER,
  TOOLS,
  getFeaturedTools,
  toolHref,
} from "@/lib/tools-registry";

const SIDEBAR_STORAGE_KEY = "optimuspdf.sidebarCollapsed";

/*
 * Mismo patron de store externo que `src/lib/i18n.tsx`: el snapshot del
 * servidor es siempre expandido y el cliente se sincroniza con
 * localStorage, sin setState dentro de un efecto.
 */
let cachedCollapsed: boolean | null = null;
const collapseListeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getCollapsedSnapshot(): boolean {
  cachedCollapsed ??= readCollapsed();
  return cachedCollapsed;
}

function getCollapsedServerSnapshot(): boolean {
  return false;
}

function subscribeCollapsed(listener: () => void): () => void {
  collapseListeners.add(listener);
  return () => {
    collapseListeners.delete(listener);
  };
}

function writeCollapsed(next: boolean): void {
  cachedCollapsed = next;
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Se mantiene en memoria aunque no se pueda persistir.
  }
  for (const listener of collapseListeners) listener();
}

/** Normaliza para buscar: minusculas y sin diacriticos. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Sidebar persistente de escritorio (>=1024px), al estilo de las barras
 * laterales de macOS: superficie solida (no hay contenido que pase por
 * debajo, asi que el blur seria coste sin efecto), categorias como anclas
 * de la Home con la seccion visible resaltada (scroll-spy), accesos
 * rapidos y buscador. Un unico indicador activo se desliza entre
 * entradas con spring (`layoutId`). Colapsa a un riel de iconos. Por
 * debajo de 1024px lo cubren `Header` (<1024px) y `MobileTabBar` (<768px).
 */
export function Sidebar() {
  const t = useT();
  const pathname = usePathname();
  const storedCollapsed = useSyncExternalStore(
    subscribeCollapsed,
    getCollapsedSnapshot,
    getCollapsedServerSnapshot,
  );
  /*
   * GE-04 · en un iPad HORIZONTAL (1194 px, dedo) la barra lateral de 17 rem se comia el 23 % del ancho justo donde se
   * firma o se edita (la hoja de Firmar quedaba en ~460 px de 1194). Dentro de Firmar y PDF Pro, con puntero grueso y
   * menos de 1280 px, arranca plegada al riel de iconos (4.5 rem); la persona puede desplegarla (solo esa pantalla:
   * no se guarda) y su preferencia guardada manda en el resto de la aplicacion.
   */
  const viewport = useViewportTier();
  const documentRoute = pathname.startsWith("/sign-pdf") || pathname.startsWith("/pdf-pro");
  const autoCompact = documentRoute && viewport.compact;
  const [override, setOverride] = useState<{ path: string; value: boolean } | null>(null);
  const overridden = override && override.path === pathname ? override.value : null;
  const collapsed = autoCompact ? (overridden ?? true) : storedCollapsed;
  const activeSection = useActiveSection();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();

  useEffect(() => {
    if (!query) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setQuery("");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuery("");
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [query]);

  function toggleCollapsed() {
    if (autoCompact) setOverride({ path: pathname, value: !collapsed });
    else writeCollapsed(!storedCollapsed);
  }

  const trimmed = fold(query.trim());
  const results =
    trimmed.length > 0
      ? TOOLS.filter((tool) =>
          fold(t.tools[tool.slug].name).includes(trimmed),
        ).slice(0, 6)
      : [];

  const isHome = pathname === "/";
  const isRecent = pathname.startsWith("/recent");
  const isDocuments = pathname.startsWith("/documents");
  const isSettings = pathname.startsWith("/settings");
  const featuredActive = getFeaturedTools().find((tool) => pathname.startsWith(toolHref(tool.slug)));
  /* Una sola entrada activa: en Home manda la seccion visible; si aun no
     hay ninguna (arriba del todo), "Inicio". */
  const activeKey = isHome
    ? (activeSection ?? "home")
    : featuredActive
      ? featuredActive.slug
      : isDocuments
        ? "documents"
        : isRecent
          ? "recent"
          : isSettings
            ? "settings"
            : null;

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-hairline bg-surface lg:flex",
        "transition-[width] duration-[var(--duration-base)] ease-[var(--ease-spring)]",
        collapsed ? "w-[4.5rem]" : "w-[17rem]",
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center px-4",
          collapsed && "justify-center px-0",
        )}
      >
        {collapsed ? null : <Logo />}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
          aria-expanded={!collapsed}
          className={cn(
            "group flex size-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal",
            !collapsed && "ml-auto",
          )}
        >
          <span className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/8 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
            {collapsed ? (
              <ChevronsRight aria-hidden="true" className="size-4" />
            ) : (
              <ChevronsLeft aria-hidden="true" className="size-4" />
            )}
          </span>
        </button>
      </div>

      {collapsed ? null : (
        <div ref={searchRef} className="relative px-3 pb-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.nav.searchPlaceholder}
              aria-label={t.nav.searchPlaceholder}
              aria-controls={trimmed.length > 0 ? resultsId : undefined}
              autoComplete="off"
              className="h-10 w-full rounded-ios-sm border border-hairline pointer-coarse:h-11 bg-white/5 pr-3 pl-9 text-subheadline text-foreground placeholder:text-muted-foreground focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            />
          </div>

          <AnimatePresence>
            {trimmed.length > 0 ? (
              <motion.div
                key="results"
                id={resultsId}
                role="region"
                aria-live="polite"
                initial={{ opacity: 0, scale: 0.97, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: -2 }}
                transition={withCrossFadeOpacity(springs.snappy)}
                style={{ transformOrigin: "top center" }}
                className="absolute inset-x-3 top-full z-50 mt-1 overflow-hidden rounded-ios border border-hairline bg-elevated p-1.5 shadow-elevation-3"
              >
                {results.length > 0 ? (
                  <ul>
                    {results.map((tool) => {
                      const Icon = tool.icon;
                      return (
                        <li key={tool.slug}>
                          <Link
                            href={toolHref(tool.slug)}
                            onClick={() => setQuery("")}
                            className="flex h-10 items-center gap-2.5 rounded-ios-sm px-2.5 text-subheadline pointer-coarse:h-11 text-foreground transition-colors hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
                          >
                            <Icon
                              aria-hidden="true"
                              className={cn("size-4 shrink-0", ACCENT_TEXT[tool.accent])}
                            />
                            <span className="truncate">{t.tools[tool.slug].name}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="px-2.5 py-2 text-subheadline text-muted-foreground">
                    {t.nav.searchEmpty}
                  </p>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      )}

      <nav
        aria-label={t.nav.primaryNav}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3"
      >
        <ul className="space-y-0.5">
          {getFeaturedTools().map((tool) => (
            <SidebarLink
              key={tool.slug}
              href={toolHref(tool.slug)}
              icon={tool.icon}
              label={t.tools[tool.slug].name}
              active={activeKey === tool.slug}
              collapsed={collapsed}
              iconClassName={ACCENT_TEXT[tool.accent]}
            />
          ))}
          <SidebarLink
            href="/"
            icon={House}
            label={t.nav.home}
            active={activeKey === "home"}
            collapsed={collapsed}
          />
        </ul>

        <ul className="mt-5 space-y-0.5">
          {collapsed ? null : (
            <li
              aria-hidden="true"
              className="ui-label px-2.5 pb-1.5 text-caption text-muted-foreground"
            >
              {t.nav.categoriesLabel}
            </li>
          )}
          {CATEGORY_ORDER.map((category) => (
            <SidebarLink
              key={category}
              href={`/#${category}`}
              icon={CATEGORY_ICON[category]}
              label={t.categories[category].label}
              active={activeKey === category}
              collapsed={collapsed}
              onClick={() => requestSection(category)}
            />
          ))}
        </ul>

        <ul className="mt-4 space-y-0.5 border-t border-hairline pt-3">
          <SidebarLink
            href="/documents"
            icon={FolderOpen}
            label={t.nav.documents}
            active={activeKey === "documents"}
            collapsed={collapsed}
          />
          <SidebarLink
            href="/recent"
            icon={Clock}
            label={t.nav.recent}
            active={activeKey === "recent"}
            collapsed={collapsed}
          />
          <SidebarLink
            href="/settings"
            icon={Settings}
            label={t.nav.settings}
            active={activeKey === "settings"}
            collapsed={collapsed}
          />
        </ul>

        {collapsed ? null : (
          <ul className="mt-4 space-y-0.5 border-t border-hairline pt-3">
            <li>
              <Link
                href="/pricing"
                className="flex h-9 items-center rounded-ios-sm px-2.5 text-footnote pointer-coarse:h-11 text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
              >
                {t.nav.pricing}
              </Link>
            </li>
            <li>
              <Link
                href="/about"
                className="flex h-9 items-center rounded-ios-sm px-2.5 text-footnote pointer-coarse:h-11 text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
              >
                {t.nav.about}
              </Link>
            </li>
          </ul>
        )}
      </nav>

      <div
        className={cn(
          "flex shrink-0 flex-col gap-2 border-t border-hairline p-3",
          collapsed && "items-center",
        )}
      >
        {collapsed ? (
          <span
            title={t.common.localAndZeroUploads}
            aria-label={t.common.localAndZeroUploads}
            role="img"
            className="my-2 block size-2 shrink-0 rounded-full bg-success"
          />
        ) : (
          <>
            <Badge variant="live" dot className="self-start max-w-full">
              {t.common.localAndZeroUploads}
            </Badge>
            <LanguageToggle className="-ml-0.5" />
          </>
        )}
      </div>
    </aside>
  );
}

function SidebarLink({
  href,
  icon: Icon,
  label,
  active = false,
  collapsed,
  onClick,
  iconClassName,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick?: () => void;
  /** Color propio del icono en reposo (la entrada destacada lleva el acento de PDF Pro). */
  iconClassName?: string;
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onClick}
        title={collapsed ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative isolate flex h-10 items-center gap-2.5 rounded-ios-sm px-2.5 text-subheadline font-medium pointer-coarse:h-11",
          "transition-[color,background-color] duration-[var(--duration-fast)]",
          "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
          collapsed && "justify-center px-0",
          active
            ? "text-foreground"
            : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
        )}
      >
        {active ? (
          <motion.span
            aria-hidden="true"
            layoutId="sidebar-active-pill"
            transition={springs.snappy}
            className="absolute inset-0 -z-10 rounded-ios-sm bg-white/10 forced-colors:border-2 forced-colors:border-[Highlight]"
          />
        ) : null}
        <Icon
          aria-hidden="true"
          className={cn("size-[18px] shrink-0", active ? "text-signal" : iconClassName)}
        />
        {collapsed ? null : <span className="truncate">{label}</span>}
      </Link>
    </li>
  );
}
