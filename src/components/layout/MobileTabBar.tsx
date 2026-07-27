"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, House, LayoutGrid, Settings, type LucideIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

type Tab = {
  href: string;
  icon: LucideIcon;
  labelKey: "home" | "tools" | "recent" | "settings";
};

const TABS: Tab[] = [
  { href: "/", icon: House, labelKey: "home" },
  { href: "/tools", icon: LayoutGrid, labelKey: "tools" },
  { href: "/recent", icon: Clock, labelKey: "recent" },
  { href: "/settings", icon: Settings, labelKey: "settings" },
];

/** Tab bar iOS 26: liquid glass, safe-area inferior, solo bajo 768px. */
export function MobileTabBar() {
  const t = useT();
  const pathname = usePathname();

  return (
    <nav
      aria-label={t.nav.tools}
      className="glass-bar fixed inset-x-0 bottom-0 z-40 border-t border-white/10 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
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
                  "flex h-full flex-col items-center justify-center gap-1 transition-colors duration-200",
                  active ? "text-signal" : "text-muted-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-5" />
                <span className="hud-label text-[9px]">
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
