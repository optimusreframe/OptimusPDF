"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useT } from "@/lib/i18n";
import { useTheme, type ThemeChoice } from "@/lib/theme";

/**
 * Selector Claro / Oscuro / Sistema para el pie de la barra lateral. Es el mismo almacen (`useTheme`) y el mismo control
 * que «Apariencia» de Ajustes, asi que ambos siempre coinciden y la eleccion persiste igual. `wrap` deja que los tres
 * segmentos pasen a otra fila si no caben (fuente ancha) en vez de recortarse.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useT();
  const { theme, setTheme } = useTheme();

  return (
    <SegmentedControl<ThemeChoice>
      className={className}
      size="sm"
      wrap
      hideLabel
      label={t.nav.themeLabel}
      value={theme}
      onChange={setTheme}
      options={[
        { value: "light", label: t.common.light },
        { value: "dark", label: t.common.dark },
        { value: "system", label: t.common.system },
      ]}
    />
  );
}
