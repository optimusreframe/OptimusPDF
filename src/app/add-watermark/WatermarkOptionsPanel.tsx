"use client";

import { useRef } from "react";
import { ImageUp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import {
  ChoiceGroup,
  ColorSwatches,
  NumberField,
  OptionSection,
  TextField,
  ToggleRow,
} from "@/app/add-watermark/OptionControls";
import { PositionGrid } from "@/app/add-watermark/PositionGrid";
import {
  INK_COLORS,
  WATERMARK_OPACITIES,
  WATERMARK_ROTATIONS,
  type GridAnchor,
  type PdfFontFamily,
  type WatermarkKind,
  type WatermarkLayer,
  type WatermarkOptions,
} from "@/lib/pdf/watermark";
import type { WatermarkStrings } from "@/app/add-watermark/strings";

export type WatermarkOptionsPanelProps = {
  options: WatermarkOptions;
  setOptions: (patch: Partial<WatermarkOptions>) => void;
  strings: WatermarkStrings;
};

export function WatermarkOptionsPanel({
  options,
  setOptions,
  strings,
}: WatermarkOptionsPanelProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);

  const fontChoices: Array<{ value: PdfFontFamily; label: string }> = [
    { value: "helvetica", label: strings.fontHelvetica },
    { value: "times", label: strings.fontTimes },
    { value: "courier", label: strings.fontCourier },
  ];

  return (
    <>
      <OptionSection>
        <SegmentedControl<WatermarkKind>
          label={strings.kindLabel}
          value={options.kind}
          onChange={(kind) => setOptions({ kind })}
          options={[
            { value: "text", label: strings.kindText },
            { value: "image", label: strings.kindImage },
          ]}
        />
      </OptionSection>

      {options.kind === "text" ? (
        <OptionSection>
          <TextField
            label={strings.textLabel}
            value={options.text}
            placeholder={strings.textPlaceholder}
            onChange={(text) => setOptions({ text })}
          />
          {options.text.trim().length === 0 ? (
            <p role="alert" className="text-xs text-destructive">
              {strings.textRequired}
            </p>
          ) : null}
          <ChoiceGroup<PdfFontFamily>
            label={strings.fontLabel}
            value={options.fontFamily}
            choices={fontChoices}
            columns={3}
            onChange={(fontFamily) => setOptions({ fontFamily })}
          />
          <Slider
            label={strings.sizeLabel}
            value={options.fontSize}
            min={8}
            max={160}
            step={1}
            suffix=" pt"
            onChange={(fontSize) => setOptions({ fontSize })}
          />
          <div className="grid grid-cols-2 gap-2">
            <ToggleRow
              label={strings.bold}
              checked={options.bold}
              onChange={(bold) => setOptions({ bold })}
            />
            <ToggleRow
              label={strings.italic}
              checked={options.italic}
              onChange={(italic) => setOptions({ italic })}
            />
          </div>
          <ColorSwatches
            label={strings.colorLabel}
            value={options.color}
            colors={INK_COLORS}
            onChange={(color) => setOptions({ color })}
          />
        </OptionSection>
      ) : (
        <OptionSection>
          <span className="hud-label block text-[10px] text-muted-foreground">
            {strings.imageLabel}
          </span>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,.png,.jpg,.jpeg"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              if (file) setOptions({ image: file });
              event.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            size="md"
            fullWidth
            onClick={() => imageInputRef.current?.click()}
          >
            <ImageUp aria-hidden="true" className="size-4" />
            {options.image ? strings.imageReplace : strings.imagePick}
          </Button>
          {options.image ? (
            <p className="truncate text-sm text-foreground">
              {options.image.name}
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {strings.imageHint}
              </p>
              <p role="alert" className="text-xs text-destructive">
                {strings.imageRequired}
              </p>
            </>
          )}
          <Slider
            label={strings.imageSizeLabel}
            value={Math.round(options.imageScale * 100)}
            min={5}
            max={100}
            step={5}
            suffix=" %"
            onChange={(percent) => setOptions({ imageScale: percent / 100 })}
          />
        </OptionSection>
      )}

      <OptionSection>
        <PositionGrid
          label={strings.positionLabel}
          value={options.anchor}
          anchorLabels={strings.anchorLabels}
          disabled={options.tile}
          hint={strings.positionHint}
          onChange={(anchor: GridAnchor) => setOptions({ anchor })}
        />
        <ToggleRow
          label={strings.tileLabel}
          checked={options.tile}
          hint={strings.tileHint}
          onChange={(tile) => setOptions({ tile })}
        />
      </OptionSection>

      <OptionSection>
        <ChoiceGroup<number>
          label={strings.opacityLabel}
          value={options.opacity}
          columns={2}
          choices={WATERMARK_OPACITIES.map((opacity) => ({
            value: opacity,
            label:
              opacity === 1
                ? strings.opacityFull
                : `${Math.round(opacity * 100)} %`,
          }))}
          onChange={(opacity) => setOptions({ opacity })}
        />
        <ChoiceGroup<number>
          label={strings.rotationLabel}
          value={options.rotation}
          columns={3}
          choices={WATERMARK_ROTATIONS.map((rotation) => ({
            value: rotation,
            label: `${rotation}°`,
          }))}
          onChange={(rotation) => setOptions({ rotation })}
        />
      </OptionSection>

      <OptionSection>
        <span className="hud-label block text-[10px] text-muted-foreground">
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
        <ChoiceGroup<WatermarkLayer>
          label={strings.layerLabel}
          value={options.layer}
          hint={strings.layerHint}
          choices={[
            { value: "over", label: strings.layerOver },
            { value: "under", label: strings.layerUnder },
          ]}
          onChange={(layer) => setOptions({ layer })}
        />
      </OptionSection>
    </>
  );
}
