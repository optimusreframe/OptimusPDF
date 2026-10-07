"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ToolCatalogGrid } from "@/components/tool/ToolCatalogGrid";
import { useRecentEntries } from "@/hooks/useRecentEntries";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { rankByUsage } from "@/lib/recent";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  TOOL_SLUGS,
  TOOLS,
  getTool,
  toolHref,
  type ToolSlug,
} from "@/lib/tools-registry";

function isKnownSlug(slug: string): slug is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(slug);
}

/**
 * Pantalla de inicio de la app y unico punto de entrada al catalogo: sin
 * hero ni copy de marketing, va directo a el. `/tools` existia como una
 * copia de esta misma pantalla (mismo `ToolCatalogGrid`) -- se elimino
 * (ver `next.config.ts` para el redirect) en vez de mantener dos rutas
 * que nunca podian divergir. Los badges de disponibilidad que antes
 * vivian solo ahi se sumaron aqui.
 *
 * La franja de estado (privacidad), disponibilidad y "Mas usadas" son
 * las unicas secciones antes del catalogo, y "Mas usadas" desaparece si
 * no hay entradas. Rankeado por frecuencia real de uso (`rankByUsage`),
 * no solo la ultima herramienta tocada -- con el catalogo completo ya
 * visible mas abajo, esta franja es el unico lugar de la app que
 * refleja el uso real del usuario en vez de la lista fija de categorias.
 */
export function HomeView() {
  const t = useT();
  const entries = useRecentEntries();
  const known = entries.filter((entry) => isKnownSlug(entry.slug));
  const mostUsed = rankByUsage(known, 4);
  const live = TOOLS.filter((tool) => tool.status === "live").length;
  const soon = TOOLS.length - live;

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-6 pb-16 md:px-6 md:pt-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="live" dot>
            {t.common.localAndZeroUploads}
          </Badge>
          <Badge variant="live" dot>
            {live} {t.home.liveCount}
          </Badge>
          <Badge variant="soon">
            {soon} {t.home.soonCount}
          </Badge>
        </div>
        <Link
          href="/privacy"
          className="hud-label text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t.footer.privacy}
        </Link>
      </div>

      {mostUsed.length > 0 ? (
        <section className="mb-12">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="hud-label text-[11px] text-foreground">
              {t.home.mostUsedTitle}
            </h2>
            <Link
              href="/recent"
              className="hud-label text-[10px] text-signal hover:text-glow"
            >
              {t.home.mostUsedSeeAll}
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {mostUsed.map((ranked) => {
              const tool = getTool(ranked.slug);
              const Icon = tool.icon;
              return (
                <Link
                  key={ranked.slug}
                  href={toolHref(ranked.slug)}
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
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {t.tools[ranked.slug].name}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                      <FileText
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />
                      <span className="truncate">{ranked.latest.fileName}</span>
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
