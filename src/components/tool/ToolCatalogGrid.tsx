"use client";

import { ToolCard } from "@/components/tool/ToolCard";
import { ToolIconTile } from "@/components/tool/ToolIconTile";
import { useT } from "@/lib/i18n";
import { CATEGORY_ORDER, getToolsByCategory } from "@/lib/tools-registry";

/**
 * Catalogo completo agrupado por categoria: grid denso de iconos en movil,
 * tarjetas glass en tablet/escritorio. Compartido entre Home y Herramientas
 * para que nunca diverjan.
 */
export function ToolCatalogGrid() {
  const t = useT();

  return (
    <div className="space-y-14">
      {CATEGORY_ORDER.map((category) => (
        <section key={category} id={category} className="scroll-mt-20">
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
  );
}
