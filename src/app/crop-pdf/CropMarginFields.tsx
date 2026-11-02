"use client";

import { NumberField } from "@/components/tool/OptionControls";
import { CROP_MAX_MARGIN_PERCENT, marginsOf, withMargin, type CropSide } from "@/app/crop-pdf/cropMargins";
import type { CropStrings } from "@/app/crop-pdf/strings";
import type { NormalizedRect } from "@/lib/pdf/core";

export type CropMarginFieldsProps = {
  rect: NormalizedRect;
  onRectChange: (rect: NormalizedRect) => void;
  strings: CropStrings;
};

/**
 * Alternativa SIN ARRASTRAR al rectangulo de la vista previa (WCAG 2.5.7, dragging-alternative): cuatro campos numericos, uno por
 * lado, con el mismo efecto que los tiradores. Sirven con teclado, con un solo toque y con tecnologias de apoyo.
 */
export function CropMarginFields({ rect, onRectChange, strings }: CropMarginFieldsProps) {
  const margins = marginsOf(rect);
  const fields: Array<{ side: CropSide; label: string }> = [
    { side: "top", label: strings.marginTop },
    { side: "bottom", label: strings.marginBottom },
    { side: "left", label: strings.marginLeft },
    { side: "right", label: strings.marginRight },
  ];
  return (
    <fieldset className="space-y-3" data-crop-margins="">
      <legend className="ui-label text-muted-foreground">{strings.marginsLabel}</legend>
      <p className="text-xs leading-relaxed text-muted-foreground">{strings.marginsHint}</p>
      <div className="grid grid-cols-2 gap-3">
        {fields.map(({ side, label }) => (
          <NumberField
            key={side}
            label={label}
            value={margins[side]}
            min={0}
            max={CROP_MAX_MARGIN_PERCENT}
            onChange={(value) => onRectChange(withMargin(rect, side, value))}
          />
        ))}
      </div>
    </fieldset>
  );
}
