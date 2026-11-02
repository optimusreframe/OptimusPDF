"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";

/** Clases de la fila de un enlace de la barra lateral; las comparten el enlace y la parte enlace de una seccion. */
export function sidebarRowClasses({
  active,
  collapsed,
  nested = false,
  containsActive = false,
}: {
  active: boolean;
  collapsed: boolean;
  nested?: boolean;
  /** La seccion contiene la pagina actual (sin ser ella): se lee un poco mas fuerte que el resto. */
  containsActive?: boolean;
}): string {
  return cn(
    "relative isolate flex min-w-0 flex-1 items-center gap-2.5 rounded-ios-sm px-2.5 font-medium",
    // Las herramientas anidadas pueden llevar un nombre largo («Convertidor de imágenes») junto a la insignia «Pronto»: el
    // nombre pasa a dos lineas en vez de cortarse (tres convertidores truncados serian indistinguibles).
    nested ? "min-h-9 py-1 text-footnote pointer-coarse:min-h-11" : "h-10 text-subheadline pointer-coarse:h-11",
    "transition-[color,background-color] duration-[var(--duration-fast)]",
    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
    collapsed && "justify-center px-0",
    active
      ? "text-foreground"
      : cn(
          "hover:bg-white/6 hover:text-foreground",
          containsActive ? "text-foreground" : "text-muted-foreground",
        ),
  );
}

/** Pastilla que se desliza entre entradas con spring: solo existe en la entrada activa (un unico `layoutId`). */
export function ActivePill() {
  return (
    <motion.span
      aria-hidden="true"
      layoutId="sidebar-active-pill"
      transition={springs.snappy}
      className="absolute inset-0 -z-10 rounded-ios-sm bg-white/10 forced-colors:border-2 forced-colors:border-[Highlight]"
    />
  );
}

export type SidebarLinkProps = {
  href: string;
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick?: () => void;
  /** Color propio del icono en reposo (la entrada destacada lleva el acento de PDF Pro). */
  iconClassName?: string;
  /** Entrada de segundo nivel (herramienta dentro de una seccion): mas baja y con el icono mas pequeño. */
  nested?: boolean;
  /** Herramienta aun no disponible: sigue siendo un enlace (lleva a su pagina provisional) pero con la insignia «Pronto». */
  soon?: boolean;
  /** `page` (por defecto) para una pagina, `location` para un ancla dentro de Inicio. */
  current?: "page" | "location";
};

/**
 * Entrada de la barra lateral. Plegada (riel de iconos) solo queda el icono y el nombre pasa a `title`; las entradas
 * `soon` mantienen su insignia como texto (no solo color) y se anuncian con ella.
 */
export function SidebarLink({
  href,
  icon: Icon,
  label,
  active = false,
  collapsed,
  onClick,
  iconClassName,
  nested = false,
  soon = false,
  current = "page",
}: SidebarLinkProps) {
  const t = useT();
  return (
    <li className="flex">
      <Link
        href={href}
        onClick={onClick}
        title={collapsed ? label : undefined}
        aria-current={active ? current : undefined}
        className={sidebarRowClasses({ active, collapsed, nested })}
      >
        {active ? <ActivePill /> : null}
        {Icon ? (
          <Icon
            aria-hidden="true"
            className={cn(
              nested ? "size-4" : "size-[18px]",
              "shrink-0",
              active ? "text-signal" : iconClassName,
            )}
          />
        ) : null}
        {collapsed ? null : <span className={nested ? "line-clamp-2 min-w-0 leading-tight" : "truncate"}>{label}</span>}
        {soon && !collapsed ? (
          <Badge variant="soon" className="ml-auto shrink-0">
            {t.nav.soonShort}
          </Badge>
        ) : null}
        {soon && collapsed ? <span className="sr-only">{t.nav.soonShort}</span> : null}
      </Link>
    </li>
  );
}

/**
 * Entrada que todavia no existe. Con `badge` (las plataformas del Downloader) es una entrada deshabilitada: ni enlace ni
 * foco, solo texto con `aria-disabled` y la insignia «Pronto». Sin `badge` («Próximamente…») es solo una nota de texto.
 * Nunca apunta a una pagina que no existe.
 */
export function DisabledEntry({ label, badge = false }: { label: string; badge?: boolean }) {
  const t = useT();
  return (
    <li className="flex">
      <span
        {...(badge ? { role: "link", "aria-disabled": "true" as const } : {})}
        className="flex h-9 min-w-0 flex-1 cursor-not-allowed items-center gap-2.5 rounded-ios-sm px-2.5 text-footnote font-medium text-muted-foreground select-none"
      >
        <span className="truncate">{label}</span>
        {badge ? (
          <Badge variant="soon" className="ml-auto shrink-0">
            {t.nav.soonShort}
          </Badge>
        ) : null}
      </span>
    </li>
  );
}
