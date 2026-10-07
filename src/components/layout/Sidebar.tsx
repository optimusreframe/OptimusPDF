"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  Clock,
  House,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_TEXT,
  CATEGORY_ICON,
  CATEGORY_ORDER,
  TOOLS,
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

/**
 * Sidebar persistente de escritorio (>=1024px), estilo Finder/Mail/Ajustes
 * de macOS: categorias, buscador y accesos rapidos siempre visibles, sin
 * necesidad de abrir nada. Colapsa a un riel de solo iconos. Por debajo de
 * 1024px no se renderiza contenido util: `Header` (<1024px) y
 * `MobileTabBar` (<768px) cubren esos anchos.
 */
export function Sidebar() {
  const t = useT();
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    getCollapsedSnapshot,
    getCollapsedServerSnapshot,
  );
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);

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
    writeCollapsed(!collapsed);
  }

  const trimmed = query.trim().toLowerCase();
  const results =
    trimmed.length > 0
      ? TOOLS.filter((tool) =>
          t.tools[tool.slug].name.toLowerCase().includes(trimmed),
        ).slice(0, 6)
      : [];

  const isHome = pathname === "/";
  const isRecent = pathname.startsWith("/recent");
  const isSettings = pathname.startsWith("/settings");

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-white/10 bg-surface/60 backdrop-blur-2xl lg:flex",
        collapsed ? "w-[4.5rem]" : "w-64",
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center gap-2 px-4",
          collapsed && "justify-center px-0",
        )}
      >
        {collapsed ? null : <Logo />}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground",
            !collapsed && "ml-auto",
          )}
        >
          {collapsed ? (
            <ChevronsRight aria-hidden="true" className="size-4" />
          ) : (
            <ChevronsLeft aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>

      {collapsed ? null : (
        <div ref={searchRef} className="relative px-3 pb-3">
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
              className="h-10 w-full rounded-ios-sm border border-white/10 bg-white/5 pr-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-signal/50 focus:outline-none"
            />
          </div>

          {trimmed.length > 0 ? (
            <div className="absolute inset-x-3 top-full z-50 mt-2 animate-rise-in overflow-hidden rounded-ios border border-white/10 bg-elevated/95 p-1.5 backdrop-blur-2xl">
              {results.length > 0 ? (
                results.map((tool) => {
                  const Icon = tool.icon;
                  return (
                    <Link
                      key={tool.slug}
                      href={toolHref(tool.slug)}
                      onClick={() => setQuery("")}
                      className="flex items-center gap-2.5 rounded-ios-sm px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-white/8"
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn("size-4 shrink-0", ACCENT_TEXT[tool.accent])}
                      />
                      <span className="truncate">{t.tools[tool.slug].name}</span>
                    </Link>
                  );
                })
              ) : (
                <p className="px-2.5 py-2 text-sm text-muted-foreground">
                  {t.nav.searchEmpty}
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}

      <nav
        aria-label={t.nav.primaryNav}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3"
      >
        <div className="space-y-0.5">
          <SidebarLink
            href="/"
            icon={House}
            label={t.nav.home}
            active={isHome}
            collapsed={collapsed}
          />
        </div>

        <div className="space-y-0.5">
          {collapsed ? null : (
            <p className="hud-label px-2.5 pb-1 text-[10px] text-muted-foreground">
              {t.nav.categoriesLabel}
            </p>
          )}
          {CATEGORY_ORDER.map((category) => (
            <SidebarLink
              key={category}
              href={`/#${category}`}
              icon={CATEGORY_ICON[category]}
              label={t.categories[category].label}
              collapsed={collapsed}
            />
          ))}
        </div>

        <div className="space-y-0.5 border-t border-white/10 pt-3">
          <SidebarLink
            href="/recent"
            icon={Clock}
            label={t.nav.recent}
            active={isRecent}
            collapsed={collapsed}
          />
          <SidebarLink
            href="/settings"
            icon={Settings}
            label={t.nav.settings}
            active={isSettings}
            collapsed={collapsed}
          />
        </div>

        {collapsed ? null : (
          <div className="space-y-0.5 border-t border-white/10 pt-3">
            <Link
              href="/pricing"
              className="block rounded-ios-sm px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
            >
              {t.nav.pricing}
            </Link>
            <Link
              href="/about"
              className="block rounded-ios-sm px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
            >
              {t.nav.about}
            </Link>
          </div>
        )}
      </nav>

      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-t border-white/10 p-3",
          collapsed && "flex-col",
        )}
      >
        {collapsed ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-success"
          />
        ) : (
          <Badge variant="live" dot className="min-w-0">
            <span className="truncate">{t.common.localAndZeroUploads}</span>
          </Badge>
        )}
        {collapsed ? null : <LanguageToggle className="ml-auto shrink-0" />}
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
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-ios-sm px-2.5 py-2 text-sm transition-colors duration-200",
        collapsed && "justify-center px-0",
        active
          ? "bg-white/10 text-foreground"
          : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {collapsed ? null : <span className="truncate">{label}</span>}
    </Link>
  );
}
