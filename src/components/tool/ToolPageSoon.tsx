"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses } from "@/components/ui/Button";
import { ToolCard } from "@/components/tool/ToolCard";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  getRelatedTools,
  getTool,
  type ToolSlug,
} from "@/lib/tools-registry";

export type ToolPageSoonProps = {
  slug: ToolSlug;
};

/**
 * Pagina honesta para herramientas que aun no funcionan en local: dice
 * por que, ofrece el camino de vuelta y alternativas que si funcionan.
 */
export function ToolPageSoon({ slug }: ToolPageSoonProps) {
  const t = useT();
  const tool = getTool(slug);
  const Icon = tool.icon;
  const copy = t.tools[slug];
  const alternatives = getRelatedTools(slug, 3).filter(
    (candidate) => candidate.status === "live",
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 md:px-6 md:pt-10">
      <div className="surface-card flex flex-col items-center rounded-ios-lg px-6 py-14 text-center md:py-20">
        <span
          className={cn(
            "flex size-14 items-center justify-center rounded-ios opacity-70",
            ACCENT_BG_SOFT[tool.accent],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-7", ACCENT_TEXT[tool.accent])}
          />
        </span>

        <Badge variant="soon" className="mt-5">
          <Clock aria-hidden="true" className="size-3" />
          {t.soon.badge}
        </Badge>

        <h1 className="mt-4 text-title-1 text-foreground">{copy.name}</h1>
        <p className="mt-2 max-w-xl text-callout text-muted-foreground">
          {copy.description}
        </p>

        <div className="mt-8 max-w-xl rounded-ios border border-hairline bg-white/5 p-5 text-left">
          <h2 className="text-headline text-foreground">{t.soon.title}</h2>
          <p className="mt-1.5 text-subheadline text-muted-foreground">
            {t.soon.body}
          </p>
        </div>

        <Link
          href="/"
          className={cn(buttonClasses("secondary", "md"), "mt-8")}
        >
          {t.soon.backHome}
        </Link>
      </div>

      {alternatives.length > 0 ? (
        <section className="mt-10" aria-labelledby="alternatives-title">
          <h2 id="alternatives-title" className="ui-label mb-3 text-muted-foreground">
            {t.soon.alternativesTitle}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {alternatives.map((candidate) => (
              <li key={candidate.slug}>
                <ToolCard tool={candidate} compact />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
