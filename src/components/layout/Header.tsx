"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_TEXT,
  CATEGORY_ORDER,
  getToolsByCategory,
  toolHref,
  type ToolCategory,
} from "@/lib/tools-registry";

export function Header() {
  const t = useT();
  const [openCategory, setOpenCategory] = useState<ToolCategory | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openCategory) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!navRef.current?.contains(event.target as Node)) {
        setOpenCategory(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenCategory(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openCategory]);

  return (
    <header className="glass-bar sticky top-0 z-40 border-b border-white/10">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-4 md:h-16 md:px-6">
        <Logo />

        <div ref={navRef} className="relative hidden flex-1 md:block">
          <nav className="flex items-center gap-1">
            {CATEGORY_ORDER.map((category) => {
              const open = openCategory === category;
              return (
                <button
                  key={category}
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenCategory(open ? null : category)}
                  className={cn(
                    "hud-label flex items-center gap-1 rounded-full px-3 py-1.5 text-[10px] transition-colors duration-200",
                    open
                      ? "bg-white/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.categories[category].label}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-3 transition-transform duration-200",
                      open && "rotate-180",
                    )}
                  />
                </button>
              );
            })}
          </nav>

          {openCategory ? (
            <div className="absolute top-full left-0 z-50 mt-3 w-[640px] animate-rise-in rounded-ios border border-white/10 bg-elevated/95 p-2 backdrop-blur-2xl">
              <div className="grid grid-cols-2 gap-1">
                {getToolsByCategory(openCategory).map((tool) => {
                  const Icon = tool.icon;
                  return (
                    <Link
                      key={tool.slug}
                      href={toolHref(tool.slug)}
                      onClick={() => setOpenCategory(null)}
                      className="group flex items-start gap-3 rounded-ios-sm p-3 transition-colors duration-200 hover:bg-white/8"
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn("mt-0.5 size-4 shrink-0", ACCENT_TEXT[tool.accent])}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {t.tools[tool.slug].name}
                          </span>
                          {tool.status === "soon" ? (
                            <Badge variant="soon" className="shrink-0">
                              {t.common.soon}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                          {t.tools[tool.slug].description}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
              <div className="mt-1 border-t border-white/10 px-3 pt-2 pb-1">
                <Link
                  href="/tools"
                  onClick={() => setOpenCategory(null)}
                  className="hud-label text-[10px] text-signal hover:text-glow"
                >
                  {t.nav.allTools}
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-3 md:ml-0">
          <Link
            href="/pricing"
            className="hud-label hidden text-[10px] text-muted-foreground transition-colors hover:text-foreground md:block"
          >
            {t.nav.pricing}
          </Link>
          <Link
            href="/about"
            className="hud-label hidden text-[10px] text-muted-foreground transition-colors hover:text-foreground md:block"
          >
            {t.nav.about}
          </Link>
          <LanguageToggle />
        </div>
      </div>
    </header>
  );
}
