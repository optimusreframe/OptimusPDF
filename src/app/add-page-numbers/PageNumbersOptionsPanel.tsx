"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import {
  ChoiceGroup,
  ColorSwatches,
  NumberField,
  OptionSection,
  TextField,
} from "@/components/tool/OptionControls";
import { PositionGrid } from "@/components/tool/PositionGrid";
import type { PageNumbersStrings } from "@/app/add-page-numbers/strings";
import {
  NUMBER_TEMPLATE,
  formatPageLabel,
  type PageNumberMargin,
  type PageNumberMode,
  type PageNumbersOptions,
} from "@/lib/pdf/pageNumbers";
import { INK_COLORS, type GridAnchor, type PdfFontFamily } from "@/lib/pdf/watermark";

/** Preset de formato: vive en la UI, el motor solo recibe `template`. */
export type PageNumbersFormatPreset =
  | "number"
  | "pageN"
  | "pageNofP"
  | "custom";

export type PageNumbersToolOptions = PageNumbersOptions & {
  preset: PageNumbersFormatPreset;
};

export type PageNumbersOptionsPanelProps = {
  options: PageNumbersToolOptions;
  setOptions: (patch: Partial<PageNumbersToolOptions>) => void;
  strings: PageNumbersStrings;
  /** 0 mientras no se conoce; se usa solo para la vista del formato. */
  totalPages: number;
};

export function PageNumbersOptionsPanel({
  options,
  setOptions,
  strings,
  totalPages,
}: PageNumbersOptionsPanelProps) {
  const templateFor = (preset: PageNumbersFormatPreset): string => {
    if (preset === "pageN") return strings.templatePageN;
    if (preset === "pageNofP") return strings.templatePageNofP;
    if (preset === "custom") return options.template || NUMBER_TEMPLATE;
    return NUMBER_TEMPLATE;
  };

  const previewTotal =
    totalPages > 0 ? options.firstNumber + totalPages - 1 : options.firstNumber;
  const preview = formatPageLabel(
    options.template,
    options.firstNumber,
    previewTotal,
  );

  return (
    <>
      <OptionSection>
        <SegmentedControl<PageNumberMode>
          label={strings.modeLabel}
          value={options.mode}
          onChange={(mode) => setOptions({ mode })}
          options={[
            { value: "single", label: strings.modeSingle },
            { value: "facing", label: strings.modeFacing },
          ]}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {strings.modeHint}
        </p>
      </OptionSection>

      <OptionSection>
        <PositionGrid
          label={strings.positionLabel}
          value={options.anchor}
          anchorLabels={strings.anchorLabels}
          hint={strings.positionHint}
          onChange={(anchor: GridAnchor) => setOptions({ anchor })}
        />
        <ChoiceGroup<PageNumberMargin>
          label={strings.marginLabel}
          value={options.margin}
          columns={3}
          choices={[
            { value: "small", label: strings.marginSmall },
            { value: "recommended", label: strings.marginRecommended },
            { value: "large", label: strings.marginLarge },
          ]}
          onChange={(margin) => setOptions({ margin })}
        />
      </OptionSection>

      <OptionSection>
        <div className="flex items-end gap-2">
          <NumberField
            label={strings.firstNumberLabel}
            value={options.firstNumber}
            min={0}
            onChange={(firstNumber) => setOptions({ firstNumber })}
          />
        </div>
        <span className="ui-label block text-muted-foreground">
          {strings.pagesLabel}
        </span>
        <div className="flex items-end gap-2">
          <NumberField
            label={strings.pagesFrom}
            value={options.fromPage}
            min={1}
            onChange={(fromPage) => setOptions({ fromPage })}
          />
          <NumberField
            label={strings.pagesTo}
            value={options.toPage}
            min={0}
            onChange={(toPage) => setOptions({ toPage })}
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {strings.pagesHint}
        </p>
      </OptionSection>

      <OptionSection>
        <ChoiceGroup<PageNumbersFormatPreset>
          label={strings.formatLabel}
          value={options.preset}
          choices={[
            { value: "number", label: strings.formatOnlyNumber },
            { value: "pageN", label: strings.formatPageN },
            { value: "pageNofP", label: strings.formatPageNofP },
            { value: "custom", label: strings.formatCustom },
          ]}
          onChange={(preset) =>
            setOptions({ preset, template: templateFor(preset) })
          }
        />
        {options.preset === "custom" ? (
          <TextField
            label={strings.customLabel}
            value={options.template}
            placeholder={strings.templatePageNofP}
            hint={strings.customHint}
            onChange={(template) => setOptions({ template })}
          />
        ) : null}
        <div className="rounded-ios-sm border border-white/10 bg-white/5 px-3 py-2.5">
          <span className="block text-caption text-muted-foreground">
            {strings.previewLabel}
          </span>
          <span className="mt-1 block truncate text-sm text-foreground tabular-nums">
            {preview}
          </span>
        </div>
      </OptionSection>

      <OptionSection>
        <ChoiceGroup<PdfFontFamily>
          label={strings.fontLabel}
          value={options.fontFamily}
          columns={3}
          choices={[
            { value: "helvetica", label: strings.fontHelvetica },
            { value: "times", label: strings.fontTimes },
            { value: "courier", label: strings.fontCourier },
          ]}
          onChange={(fontFamily) => setOptions({ fontFamily })}
        />
        <Slider
          label={strings.sizeLabel}
          value={options.fontSize}
          min={6}
          max={48}
          step={1}
          suffix=" pt"
          onChange={(fontSize) => setOptions({ fontSize })}
        />
        <ColorSwatches
          label={strings.colorLabel}
          value={options.color}
          colors={INK_COLORS}
          onChange={(color) => setOptions({ color })}
        />
      </OptionSection>
    </>
  );
}
