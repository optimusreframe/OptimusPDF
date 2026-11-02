"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Clock, FolderOpen, House, Menu, Settings, type LucideIcon } from "lucide-react";
import { useMenuTrigger } from "@/components/layout/mobileMenu";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";

type Tab = {
  href: string;
  icon: LucideIcon;
  labelKey: "home" | "documents" | "recent" | "settings";
};

const TABS: Tab[] = [
  { href: "/", icon: House, labelKey: "home" },
  { href: "/documents", icon: FolderOpen, labelKey: "documents" },
  { href: "/recent", icon: Clock, labelKey: "recent" },
  { href: "/settings", icon: Settings, labelKey: "settings" },
];

/*
 * Fila de una pestaña. Con CINCO pestañas cada una mide 64-75 px en 320-375 px y «Mis documentos» ya no cabe en una linea:
 * la etiqueta pasa a dos lineas (y, como maximo, dos: una palabra suelta que ni sola cabe, con una fuente muy ancha, se corta
 * con puntos suspensivos) en vez de sacar la barra de la pantalla. El icono va anclado arriba (no centrado) para que no cambie
 * de altura entre pestañas de una y de dos lineas. Por debajo de 360 px la etiqueta baja a 10 px (el tamaño de las barras de iOS)
 * para que «documentos» quepa entera en las pestañas de 64 px de un iPhone SE.
 */
const TAB_CLASSES = cn(
  "group flex h-full w-full min-w-0 flex-col items-center justify-start gap-1 pt-1.5 select-none",
  "transition-colors duration-[var(--duration-fast)]",
  "focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal",
);

function TabFace({ icon: Icon, label, active }: { icon: LucideIcon; label: string; active: boolean }) {
  return (
    <>
      <span className="relative isolate flex h-8 w-full max-w-16 items-center justify-center">
        {active ? (
          <motion.span
            aria-hidden="true"
            layoutId="tabbar-active-pill"
            transition={springs.snappy}
            className="absolute inset-0 -z-10 rounded-full bg-signal/15 forced-colors:border-2 forced-colors:border-[Highlight]"
          />
        ) : null}
        <Icon
          aria-hidden="true"
          className="size-6 transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-active:scale-90 group-active:duration-[80ms]"
          strokeWidth={active ? 2.25 : 1.75}
        />
      </span>
      <span className="line-clamp-2 w-full text-center text-caption-2 leading-[1.1] font-medium max-[22.5rem]:text-[0.625rem] [overflow-wrap:anywhere]">{label}</span>
    </>
  );
}

/**
 * Tab bar de iOS por debajo de 768px: material grueso con el contenido
 * pasando por debajo, safe-area inferior, y un unico indicador (pastilla
 * tras el icono) que se desliza con spring entre pestañas. El borde
 * superior es el efecto de borde de scroll, no un divisor fijo.
 *
 * Cinco pestañas (el maximo de iOS): las cuatro de acceso diario y «Menu», que no es una
 * pagina sino un boton que abre la hoja con la misma estructura que la barra lateral
 * (`MobileMenuSheet`): suites, categorias, herramientas, Ajustes, Precios, Licencias, idioma y tema.
 */
export function MobileTabBar() {
  const t = useT();
  const pathname = usePathname();
  const scrolled = useScrollEdge("bottom");
  const menu = useMenuTrigger();

  return (
    <nav
      aria-label={t.nav.primaryNav}
      data-scrolled={scrolled ? "true" : "false"}
      data-chrome="tabbar"
      className="material-thick scroll-edge-top fixed inset-x-0 bottom-0 z-40 md:hidden"
      style={{
        borderWidth: 0,
        // SC-03: con el telefono en apaisado el borde de la barra queda bajo la muesca; el fondo llega al borde y los
        // iconos se quedan dentro de la zona segura.
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      <ul className="flex h-[4.5rem] items-stretch">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="min-w-0 flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(TAB_CLASSES, active ? "text-signal-text" : "text-muted-foreground")}
              >
                <TabFace icon={tab.icon} label={t.nav[tab.labelKey]} active={active} />
              </Link>
            </li>
          );
        })}
        <li className="min-w-0 flex-1">
          {/* No es una pagina: abre la hoja. Cuando esta abierta, el velo y `inert` dejan la barra detras; la pastilla no se mueve. */}
          <button
            type="button"
            {...menu}
            className={cn(TAB_CLASSES, menu["aria-expanded"] ? "text-signal-text" : "text-muted-foreground")}
          >
            <TabFace icon={Menu} label={t.nav.menu} active={false} />
          </button>
        </li>
      </ul>
    </nav>
  );
}
