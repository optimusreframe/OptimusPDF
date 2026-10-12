"use client";

import Link from "next/link";
import { useId } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { ACCENT_BG_SOFT, ACCENT_TEXT, toolHref, type Tool } from "@/lib/tools-registry";

/**
 * Tarjeta DESTACADA grande de Home (Wave 7): la herramienta marcada `featured` (PDF Pro) va
 * antes del catalogo, con su descripcion y la lista de lo que cubre. Toda la tarjeta es un unico
 * enlace (un solo foco), con el nombre y la descripcion como nombre/descripcion accesibles.
 * Sobre superficie solida; el tinte del acento se dibuja con un degradado tenue, sin blur.
 */
export function FeaturedToolCard({ tool, className }: { tool: Tool; className?: string }) {
  const { t, language } = useI18n();
  const pro = getProStrings(language);
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];
  const titleId = useId();
  const descriptionId = useId();
  const topics = [
    pro.suite.tabs.pages,
    pro.suite.tabs.edit,
    pro.suite.tabs.sign,
    pro.suite.tabs.protect,
    pro.suite.tabs.convert,
  ];

  return (
    <Link
      href={toolHref(tool.slug)}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-featured-tool={tool.slug}
      className={cn(
        "surface-card group relative flex flex-col gap-5 overflow-hidden rounded-ios-lg p-5 md:flex-row md:items-center md:gap-7 md:p-7",
        "bg-[linear-gradient(135deg,color-mix(in_oklab,var(--color-accent-pro)_16%,transparent),transparent_62%)]",
        "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
        "hover:border-hairline-strong",
        "active:scale-[0.995] active:duration-[80ms]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-16 shrink-0 items-center justify-center rounded-ios md:size-20",
          ACCENT_BG_SOFT[tool.accent],
        )}
      >
        <Icon aria-hidden="true" className={cn("size-8 md:size-10", ACCENT_TEXT[tool.accent])} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span id={titleId} className="text-title-2 text-foreground">
            {copy.name}
          </span>
          <Badge variant="signal">{t.home.featuredBadge}</Badge>
        </span>
        <span id={descriptionId} className="mt-1.5 block max-w-2xl text-callout text-muted-foreground">
          {copy.description}
        </span>
        <span aria-hidden="true" className="mt-3 flex flex-wrap gap-1.5">
          {topics.map((topic) => (
            <span
              key={topic}
              className="rounded-full border border-hairline px-2.5 py-1 text-caption text-muted-foreground"
            >
              {topic}
            </span>
          ))}
        </span>
      </span>

      <span
        aria-hidden="true"
        className="inline-flex h-11 shrink-0 items-center gap-2 self-start rounded-ios-sm bg-signal px-5 text-callout font-semibold text-[var(--color-on-signal)] shadow-elevation-1 transition-colors group-hover:bg-glow md:self-center forced-colors:border-2 forced-colors:border-[Highlight]"
      >
        {t.home.featuredCta}
        <ArrowRight className="size-4" />
      </span>
    </Link>
  );
}
