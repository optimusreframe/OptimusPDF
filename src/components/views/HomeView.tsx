"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ToolCatalogGrid } from "@/components/tool/ToolCatalogGrid";
import { useRecentEntries } from "@/hooks/useRecentEntries";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  TOOL_SLUGS,
  getTool,
  toolHref,
  type ToolSlug,
} from "@/lib/tools-registry";

function isKnownSlug(slug: string): slug is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(slug);
}

/**
 * Pantalla de inicio de la app: sin hero ni copy de marketing, va directo al
 * catalogo. La franja de estado (privacidad) y "Recientes" son las unicas
 * secciones antes del catalogo, y "Recientes" desaparece si no hay entradas.
 */
export function HomeView() {
  const t = useT();
  const entries = useRecentEntries();
  const recent = entries.slice(0, 4).filter((entry) => isKnownSlug(entry.slug));

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-6 pb-16 md:px-6 md:pt-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Badge variant="live" dot>
          {t.common.localAndZeroUploads}
        </Badge>
        <Link
          href="/privacy"
          className="hud-label text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t.footer.privacy}
        </Link>
      </div>

      {recent.length > 0 ? (
        <section className="mb-12">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="hud-label text-[11px] text-foreground">
              {t.home.recentTitle}
            </h2>
            <Link
              href="/recent"
              className="hud-label text-[10px] text-signal hover:text-glow"
            >
              {t.home.recentSeeAll}
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {recent.map((entry) => {
              const tool = getTool(entry.slug);
              const Icon = tool.icon;
              return (
                <Link
                  key={entry.id}
                  href={toolHref(entry.slug)}
                  className="glass rounded-ios flex w-44 shrink-0 flex-col gap-2.5 p-3.5 transition-all duration-200 ease-spring hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/10"
                >
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-ios-sm",
                      ACCENT_BG_SOFT[tool.accent],
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn("size-4", ACCENT_TEXT[tool.accent])}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                      <FileText
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{entry.fileName}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {t.tools[entry.slug].name}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <ToolCatalogGrid />
    </div>
  );
}
