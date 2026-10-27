"use client";

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsLeftRight, ChevronsUpDown, Minus, Plus } from "lucide-react";
import type { CropFraction } from "@/app/sign-pdf/inkImportModel";
import { cn } from "@/lib/cn";
import { fill, type ExtractStrings } from "@/app/extract-assets/model";
import { applyNudge, NUDGE_ACTIONS, NUDGE_LABEL_KEY, type NudgeAction } from "@/app/extract-assets/regionModel";
import { regionPercent } from "@/app/extract-assets/RegionSelector";

/**
 * «Ajustar sin arrastrar» (F7 · U7.4, H13): botones de 44 px para mover el rectangulo y cambiar su ancho y alto con UN toque cada
 * uno: la alternativa de un solo puntero al arrastre (WCAG 2.5.7) que no depende de acertar con un asa pequena.
 */

const ICON: Record<NudgeAction, React.ReactNode> = {
  left: <ArrowLeft aria-hidden="true" className="size-5" />,
  right: <ArrowRight aria-hidden="true" className="size-5" />,
  up: <ArrowUp aria-hidden="true" className="size-5" />,
  down: <ArrowDown aria-hidden="true" className="size-5" />,
  wider: (
    <span aria-hidden="true" className="flex items-center gap-0.5">
      <ChevronsLeftRight className="size-5" />
      <Plus className="size-3.5" />
    </span>
  ),
  narrower: (
    <span aria-hidden="true" className="flex items-center gap-0.5">
      <ChevronsLeftRight className="size-5" />
      <Minus className="size-3.5" />
    </span>
  ),
  taller: (
    <span aria-hidden="true" className="flex items-center gap-0.5">
      <ChevronsUpDown className="size-5" />
      <Plus className="size-3.5" />
    </span>
  ),
  shorter: (
    <span aria-hidden="true" className="flex items-center gap-0.5">
      <ChevronsUpDown className="size-5" />
      <Minus className="size-3.5" />
    </span>
  ),
};

export type RegionNudgeProps = {
  rect: CropFraction;
  onChange: (rect: CropFraction) => void;
  strings: ExtractStrings;
  onAnnounce: (text: string) => void;
};

export function RegionNudge({ rect, onChange, strings, onAnnounce }: RegionNudgeProps) {
  return (
    <div role="group" aria-label={strings.regionNudgeTitle} data-region-nudge>
      <p className="ui-label mb-2 text-muted-foreground">{strings.regionNudgeTitle}</p>
      <div className="grid grid-cols-4 gap-2">
        {NUDGE_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            aria-label={strings[NUDGE_LABEL_KEY[action]]}
            title={strings[NUDGE_LABEL_KEY[action]]}
            data-region-nudge-action={action}
            onClick={() => {
              const next = applyNudge(rect, action);
              onChange(next);
              onAnnounce(fill(strings.regionValue, regionPercent(next)));
            }}
            className={cn(
              "flex h-11 min-w-11 items-center justify-center rounded-ios-sm border border-hairline-strong bg-white/5 text-foreground transition-colors",
              "hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            )}
          >
            {ICON[action]}
          </button>
        ))}
      </div>
    </div>
  );
}
