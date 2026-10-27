"use client";

import { cn } from "@/lib/cn";
import type { ScanMode } from "@/lib/scan/types";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";

export const SCAN_MODES: ScanMode[] = ["document", "id-card", "receipt", "book", "whiteboard", "photo"];

export type ModeChipsProps = {
  s: ScanToPdfStrings;
  mode: ScanMode;
  onChange: (mode: ScanMode) => void;
  /** `dark` sobre la camara; `surface` en las pantallas normales. */
  tone?: "dark" | "surface";
};

/**
 * Selector de modo: una fila desplazable de chips de 44 px (Documento, Identificacion, Recibo, Libro, Pizarra, Foto). Es un
 * grupo de botones con `aria-pressed`; la fila se desplaza con un dedo (`touch-action: pan-x`) y cada chip es alcanzable con Tab.
 */
export function ModeChips({ s, mode, onChange, tone = "surface" }: ModeChipsProps) {
  return (
    <div role="group" aria-label={s.modeLabel} data-mode-chips="" className="-mx-3 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ touchAction: "pan-x" }}>
      <div className="flex w-max gap-2">
        {SCAN_MODES.map((value) => {
          const active = value === mode;
          return (
            <button
              key={value}
              type="button"
              data-mode={value}
              aria-pressed={active}
              onClick={() => onChange(value)}
              className={cn(
                "inline-flex h-11 shrink-0 items-center rounded-full border px-4 text-subheadline font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                tone === "dark"
                  ? active
                    ? "on-media border-signal bg-signal text-[var(--color-on-signal)]"
                    : "on-media border-white/25 bg-white/10 text-white"
                  : active
                    ? "border-signal bg-signal text-[var(--color-on-signal)]"
                    : "border-hairline bg-white/5 text-foreground hover:bg-white/10",
              )}
            >
              {s.modes[value].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
