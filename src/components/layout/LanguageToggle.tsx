"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { LANGUAGES, useI18n, type Language } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";

/* Codigos ISO: datos, no texto de interfaz, por eso van en mayusculas. */
const LABELS: Record<Language, string> = { es: "ES", en: "EN" };

/*
 * Selector de idioma como un segmentado en miniatura: pista hundida y
 * pulgar que se desliza con spring (layoutId) al cambiar. Los botones
 * miden 44 px de alto para el toque aunque la pista visible sea de 32.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { language, setLanguage, t } = useI18n();
  /* El toggle vive a la vez en Sidebar y Header (uno oculto por CSS):
     cada instancia necesita su propio layoutId o el pulgar saltaria
     entre ambas. */
  const thumbId = `language-thumb-${useId()}`;

  return (
    <div
      role="group"
      aria-label={t.common.language}
      className={cn("inline-flex h-11 items-center", className)}
    >
      <div className="relative isolate flex h-11 items-center rounded-full">
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-8 -translate-y-1/2 rounded-full bg-white/8" />
        {LANGUAGES.map((code) => {
          const active = code === language;
          return (
            <button
              key={code}
              type="button"
              aria-pressed={active}
              onClick={() => setLanguage(code)}
              className={cn(
                "relative flex h-11 min-w-11 items-center justify-center rounded-full px-1 text-caption font-semibold select-none",
                "transition-[color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                "active:scale-[0.96] active:duration-[80ms]",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  aria-hidden="true"
                  layoutId={thumbId}
                  transition={springs.snappy}
                  className="absolute inset-x-0.5 top-1/2 h-7 -translate-y-1/2 rounded-full bg-elevated shadow-elevation-1"
                />
              ) : null}
              <span className="relative">{LABELS[code]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
