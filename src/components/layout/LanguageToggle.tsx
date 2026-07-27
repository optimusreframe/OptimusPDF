"use client";

import { LANGUAGES, useI18n, type Language } from "@/lib/i18n";
import { cn } from "@/lib/cn";

const LABELS: Record<Language, string> = { es: "ES", en: "EN" };

export function LanguageToggle({ className }: { className?: string }) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div
      role="group"
      aria-label={t.common.language}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5",
        className,
      )}
    >
      {LANGUAGES.map((code) => {
        const active = code === language;
        return (
          <button
            key={code}
            type="button"
            aria-pressed={active}
            onClick={() => setLanguage(code)}
            className={cn(
              "hud-label rounded-full px-2.5 py-1 text-[10px] transition-all duration-200 ease-spring",
              active
                ? "bg-signal text-[var(--color-on-signal)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LABELS[code]}
          </button>
        );
      })}
    </div>
  );
}
