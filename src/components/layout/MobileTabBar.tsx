"use client";

import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Clock, FolderOpen, House, Settings, type LucideIcon } from "lucide-react";
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

/**
 * Tab bar de iOS por debajo de 768px: material grueso con el contenido
 * pasando por debajo, safe-area inferior, y un unico indicador (pastilla
 * tras el icono) que se desliza con spring entre pestañas. El borde
 * superior es el efecto de borde de scroll, no un divisor fijo.
 */
export function MobileTabBar() {
  const t = useT();
  const pathname = usePathname();
  const scrolled = useScrollEdge("bottom");

  return (
    <nav
      aria-label={t.nav.primaryNav}
      data-scrolled={scrolled ? "true" : "false"}
      data-chrome="tabbar"
      className="material-thick scroll-edge-top fixed inset-x-0 bottom-0 z-40 md:hidden"
      style={{
        borderWidth: 0,
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <ul className="flex h-[4.5rem] items-stretch">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex h-full flex-col items-center justify-center gap-1 select-none",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal",
                  active ? "text-signal-text" : "text-muted-foreground",
                )}
              >
                <span className="relative isolate flex h-8 w-16 items-center justify-center">
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
                <span className="text-caption-2 leading-none font-medium">
                  {t.nav[tab.labelKey]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
