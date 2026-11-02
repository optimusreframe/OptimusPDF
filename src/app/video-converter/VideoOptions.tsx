"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ChoiceGroup, OptionSection, ToggleRow } from "@/components/tool/OptionControls";
import type { VideoCapabilities } from "@/lib/media/video/capabilities";
import { OUTPUT_FORMATS, type OutputFormat } from "@/lib/media/video/formats";
import { availableFps, type FpsOption } from "@/lib/media/video/fps";
import { QUALITY_PROFILES, type QualityProfile } from "@/lib/media/video/profiles";
import { availableResolutions, type ResolutionOption } from "@/lib/media/video/resolution";
import type { ConversionOptions, VideoInfo } from "@/lib/media/video/types";
import { fillTemplate, type VideoConverterStrings } from "@/app/video-converter/strings";

/** Opciones de la conversion. Solo se ofrece lo que tiene sentido para ESTE video y puede hacer ESTE navegador. */
export function VideoOptions({
  info,
  options,
  caps,
  strings,
  onChange,
}: {
  info: VideoInfo;
  options: ConversionOptions;
  caps: VideoCapabilities;
  strings: VideoConverterStrings;
  onChange: (patch: Partial<ConversionOptions>) => void;
}) {
  const formats = OUTPUT_FORMATS.filter((format) => caps.formats[format].available);
  const missing = OUTPUT_FORMATS.filter((format) => !caps.formats[format].available);
  const formatLabels: Record<OutputFormat, string> = { mp4: strings.formatMp4, webm: strings.formatWebm };
  const resolutions = availableResolutions(info.width, info.height);
  const fpsChoices = availableFps(info.fps);
  const qualityLabels: Record<QualityProfile, string> = {
    keep: strings.qualityKeep,
    high: strings.qualityHigh,
    balanced: strings.qualityBalanced,
    small: strings.qualitySmall,
  };
  const resolutionLabel = (option: ResolutionOption) => (option === "original" ? strings.resolutionOriginal : option);
  const fpsLabel = (option: FpsOption) => (option === "original" ? strings.fpsOriginal : fillTemplate(strings.fpsOption, { fps: option }));

  return (
    <>
      <OptionSection>
        <div>
          <SegmentedControl<OutputFormat>
            label={strings.formatLabel}
            value={options.format}
            onChange={(format) => onChange({ format })}
            options={formats.map((format) => ({ value: format, label: formatLabels[format] }))}
            wrap
          />
          {missing.map((format) => (
            <p key={format} data-format-unavailable={format} className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {strings.formatUnavailable[format]}
            </p>
          ))}
        </div>
      </OptionSection>

      <OptionSection>
        <div>
          <SegmentedControl<ResolutionOption>
            label={strings.resolutionLabel}
            value={options.resolution}
            onChange={(resolution) => onChange({ resolution })}
            options={resolutions.map((option) => ({ value: option, label: resolutionLabel(option) }))}
            wrap
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{strings.resolutionNote}</p>
        </div>
      </OptionSection>

      <OptionSection>
        <ChoiceGroup<QualityProfile>
          label={strings.qualityLabel}
          value={options.quality}
          onChange={(quality) => onChange({ quality })}
          choices={QUALITY_PROFILES.map((profile) => ({ value: profile, label: qualityLabels[profile] }))}
          columns={2}
          hint={strings.qualityHint[options.quality]}
        />
      </OptionSection>

      {fpsChoices.length > 1 ? (
        <OptionSection>
          <SegmentedControl<FpsOption>
            label={strings.fpsLabel}
            value={options.maxFps}
            onChange={(maxFps) => onChange({ maxFps })}
            options={fpsChoices.map((option) => ({ value: option, label: fpsLabel(option) }))}
            wrap
          />
        </OptionSection>
      ) : null}

      <OptionSection>
        {info.audio ? (
          <ToggleRow
            label={strings.removeAudio}
            checked={options.removeAudio}
            onChange={(removeAudio) => onChange({ removeAudio })}
            hint={strings.removeAudioHint}
          />
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">{strings.noAudioToRemove}</p>
        )}
      </OptionSection>
    </>
  );
}
