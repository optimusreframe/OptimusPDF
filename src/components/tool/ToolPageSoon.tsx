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

/** Pagina honesta para herramientas que aun no funcionan en local. */
export function ToolPageSoon({ slug }: ToolPageSoonProps) {
  const t = useT();
  const tool = getTool(slug);
  const Icon = tool.icon;
  const copy = t.tools[slug];
  const alternatives = getRelatedTools(slug, 3).filter(
    (candidate) => candidate.status === "live",
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-16 md:px-6 md:pt-12">
      <div className="glass rounded-ios-lg flex flex-col items-center px-6 py-14 text-center md:py-20">
        <span
          className={cn(
            "flex size-14 items-center justify-center rounded-ios",
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

        <h1 className="mt-4 text-3xl font-black tracking-[-0.025em] text-foreground md:text-4xl">
          {copy.name}
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {copy.description}
        </p>

        <div className="rounded-ios mt-8 max-w-xl border border-white/10 bg-white/5 p-5">
          <h2 className="hud-label text-[10px] text-foreground">
            {t.soon.title}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
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
        <section className="mt-10">
          <h2 className="hud-label mb-4 text-[11px] text-muted-foreground">
            {t.soon.alternativesTitle}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {alternatives.map((candidate) => (
              <ToolCard key={candidate.slug} tool={candidate} compact />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
