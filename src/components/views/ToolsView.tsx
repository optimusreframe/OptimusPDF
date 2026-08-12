"use client";

import { Badge } from "@/components/ui/Badge";
import { ToolCatalogGrid } from "@/components/tool/ToolCatalogGrid";
import { useT } from "@/lib/i18n";
import { TOOLS } from "@/lib/tools-registry";

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

      <ToolCatalogGrid />
    </div>
  );
}
