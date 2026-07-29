"use client";

import { Badge } from "@/components/ui/Badge";
import { ToolCard } from "@/components/tool/ToolCard";
import { ToolIconTile } from "@/components/tool/ToolIconTile";
import { useT } from "@/lib/i18n";
import { CATEGORY_ORDER, TOOLS, getToolsByCategory } from "@/lib/tools-registry";

export function ToolsView() {
  const t = useT();
  const live = TOOLS.filter((tool) => tool.status === "live").length;
  const soon = TOOLS.length - live;

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header className="mb-10">
        <h1 className="text-4xl font-black tracking-[-0.025em] text-foreground md:text-5xl">
          {t.toolsPage.title}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
          {t.toolsPage.subtitle}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Badge variant="live" dot>
            {live} {t.toolsPage.liveCount}
          </Badge>
          <Badge variant="soon">
            {soon} {t.toolsPage.soonCount}
          </Badge>
        </div>
      </header>

      <div className="space-y-14">
        {CATEGORY_ORDER.map((category) => (
          <section key={category}>
            <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/10 pb-3">
              <h2 className="hud-label text-[11px] text-foreground">
                {t.categories[category].label}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t.categories[category].description}
              </p>
            </div>
            <div className="grid grid-cols-4 gap-x-2 gap-y-5 sm:hidden">
              {getToolsByCategory(category).map((tool) => (
                <ToolIconTile key={tool.slug} tool={tool} />
              ))}
            </div>
            <div className="hidden gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3">
              {getToolsByCategory(category).map((tool) => (
                <ToolCard key={tool.slug} tool={tool} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
