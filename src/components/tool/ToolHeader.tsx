import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ACCENT_BG_SOFT, ACCENT_TEXT, type Tool } from "@/lib/tools-registry";

/**
 * Cabecera de una herramienta: icono de su categoria, titulo y descripcion. La usa `ToolShell` y las herramientas con pantalla
 * propia (convertidor de video y su pagina «no disponible»).
 *
 * Responsive con letra grande (Dynamic Type): el bloque de texto tiene una base minima en `rem` (12 rem) y la cabecera puede
 * partir en lineas, asi que cuando el titulo ya no cabe junto al icono (fuente al 150 % en 320 px) baja DEBAJO del icono en vez
 * de salirse de la pantalla (antes: «Convertidor de imágenes» llegaba a 343 px en una pantalla de 320). Con la letra normal
 * la fila es la de siempre. Una palabra que aun asi no cabe se parte (`break-words`).
 */
export function ToolHeader({
  tool,
  name,
  description,
  badge,
}: {
  tool: Tool;
  name: string;
  description: string;
  /** Insignia junto al titulo (p. ej. «Pronto»). */
  badge?: ReactNode;
}) {
  const Icon = tool.icon;
  return (
    <header className="mb-8 flex flex-wrap items-start gap-x-4 gap-y-3">
      <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-ios", ACCENT_BG_SOFT[tool.accent])}>
        <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[tool.accent])} />
      </span>
      <div className="min-w-0 grow basis-[12rem]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 text-title-1 break-words text-foreground">{name}</h1>
          {badge}
        </div>
        <p className="mt-1.5 max-w-2xl text-callout break-words text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}
