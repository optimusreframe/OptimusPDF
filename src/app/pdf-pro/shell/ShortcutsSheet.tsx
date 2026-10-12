"use client";

import { Sheet } from "@/components/ui/Sheet";
import { useI18n } from "@/lib/i18n";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { SHORTCUT_LAYOUT } from "@/app/pdf-pro/viewer/viewerStrings";

export type ShortcutsSheetProps = { open: boolean; onClose: () => void };

/** Lista de atajos de teclado de la suite y del visor (se abre desde el menu «Mas»). */
export function ShortcutsSheet({ open, onClose }: ShortcutsSheetProps) {
  const { t, language } = useI18n();
  const s = getProStrings(language).shell;
  return (
    <Sheet open={open} onClose={onClose} title={s.shortcutsTitle} closeLabel={t.common.close}>
      {/* Enfocable: la hoja se desplaza y no tiene otro control; asi se puede leer y desplazar con teclado. Los grupos
          son `role=group` (no `section` con nombre: se confundirian con la region «Documento» del visor). */}
      <div className="space-y-5" tabIndex={0} role="group" aria-label={s.shortcutsTitle}>
        {SHORTCUT_LAYOUT.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`pro-shortcuts-${group.id}`}>
            <h3 id={`pro-shortcuts-${group.id}`} className="ui-label mb-2 text-muted-foreground">
              {s.shortcutGroups[group.id]}
            </h3>
            <dl className="divide-y divide-[var(--color-hairline)]">
              {group.items.map((item) => (
                <div key={item.id} className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-subheadline text-foreground">{s.shortcutActions[item.id]}</dt>
                  <dd>
                    <kbd className="rounded-md border border-hairline px-1.5 py-0.5 font-sans text-caption text-muted-foreground">
                      {typeof item.keys === "string" ? item.keys : item.keys[language]}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
