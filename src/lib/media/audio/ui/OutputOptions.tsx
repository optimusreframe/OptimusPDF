"use client";

import { useId } from "react";
import { Check } from "lucide-react";
import { ChoiceGroup } from "@/components/tool/OptionControls";
import { cn } from "@/lib/cn";
import type { OutputSupport } from "@/lib/media/audio/capabilities";
import { fillTemplate, type SharedAudioStrings } from "@/lib/media/audio/ui/strings";
import {
  BITRATES_KBPS,
  DEFAULT_BITRATE_KBPS,
  MP3_SAMPLE_RATES_HZ,
  OUTPUT_FORMATS,
  SAMPLE_RATES_HZ,
  type EncodeOptions,
  type OutputFormat,
} from "@/lib/media/audio/types";

/**
 * Opciones de salida compartidas por Audio Converter, Extraer audio y la exportacion de Audio Studio: formato,
 * calidad, frecuencia y canales. Los formatos que este navegador no puede crear se muestran DESACTIVADOS y con el
 * motivo escrito (nunca se esconden): `aria-disabled` en vez de `disabled` para que sigan siendo alcanzables con el
 * teclado y su motivo se lea (`aria-describedby`). MP3 (LAME en WebAssembly) se ofrece donde hay WebAssembly con SIMD y
 * Worker; al elegirlo se enseña el credito a LAME con el enlace a `/licenses` que su licencia pide.
 */

const FORMATS: readonly OutputFormat[] = OUTPUT_FORMATS;

const SELECT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

export type OutputOptionsProps = {
  value: EncodeOptions;
  onChange: (patch: Partial<EncodeOptions>) => void;
  support: OutputSupport | null;
  strings: SharedAudioStrings;
  /** Prefijo de ids cuando hay varios paneles de opciones en la pagina. */
  idPrefix?: string;
};

export function OutputOptions({ value, onChange, support, strings, idPrefix }: OutputOptionsProps) {
  const base = useId();
  const prefix = idPrefix ?? base;
  const lossy = value.format !== "wav";
  const opus = value.format === "opus";
  const mp3 = value.format === "mp3";
  const rates = mp3 ? MP3_SAMPLE_RATES_HZ : SAMPLE_RATES_HZ;

  const availability = (format: OutputFormat) => (support ? support[format] : format === "wav" ? ({ available: true } as const) : null);

  return (
    <div className="space-y-5">
      <div>
        <span className="ui-label mb-2 block text-muted-foreground" id={`${prefix}-format`}>
          {strings.formatLabel}
        </span>
        <div role="radiogroup" aria-labelledby={`${prefix}-format`} className="grid grid-cols-1 gap-1.5">
          {FORMATS.map((format) => {
            const state = availability(format);
            const available = state?.available === true;
            const active = available && value.format === format;
            const reasonId = `${prefix}-reason-${format}`;
            return (
              <button
                key={format}
                type="button"
                role="radio"
                aria-checked={active}
                aria-disabled={!available}
                aria-describedby={!available ? reasonId : undefined}
                data-format={format}
                onClick={() => {
                  if (!available) return;
                  // Al pasar a MP3, una frecuencia que MP3 no ofrece (p. ej. 22,05 kHz) vuelve a «la del original».
                  const keepRate = format !== "mp3" || value.sampleRate === "original" || MP3_SAMPLE_RATES_HZ.includes(value.sampleRate);
                  onChange({ format, bitrateKbps: format === "wav" ? 128 : DEFAULT_BITRATE_KBPS[format], ...(keepRate ? {} : { sampleRate: "original" as const }) });
                }}
                className={cn(
                  "relative flex min-h-11 flex-col rounded-ios-sm border py-2 pr-7 pl-3 text-left leading-tight transition-all duration-200 ease-spring",
                  active
                    ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-2 forced-colors:border-[Highlight]"
                    : available
                      ? "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground forced-colors:border-[ButtonText]"
                      : "cursor-not-allowed border-white/10 bg-white/[0.02] text-muted-foreground opacity-70 forced-colors:border-[GrayText] forced-colors:text-[GrayText]",
                )}
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-foreground">
                  {strings.formatNames[format]}
                  {!available && state ? (
                    <span className="rounded-full border border-hairline px-2 py-0.5 text-caption font-medium text-muted-foreground">{strings.unavailableBadge}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 text-xs">{strings.formatHints[format]}</span>
                {active ? <Check aria-hidden="true" className="absolute top-2 right-2 size-4 text-signal forced-colors:text-[Highlight]" /> : null}
              </button>
            );
          })}
        </div>
        {support === null ? (
          <p role="status" className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {strings.checkingFormats}
          </p>
        ) : (
          FORMATS.map((format) => {
            const state = support[format];
            return state.available ? null : (
              <p key={format} id={`${prefix}-reason-${format}`} className="mt-2 text-xs leading-relaxed text-muted-foreground">
                <span className="font-semibold text-foreground">{strings.formatNames[format]}: </span>
                {strings.unavailable[state.reason]}
              </p>
            );
          })
        )}
      </div>

      {lossy ? (
        <div>
          <label htmlFor={`${prefix}-bitrate`} className="ui-label mb-1.5 block text-muted-foreground">
            {strings.bitrateLabel}
          </label>
          <select
            id={`${prefix}-bitrate`}
            value={value.bitrateKbps}
            onChange={(event) => onChange({ bitrateKbps: Number(event.target.value) })}
            className={SELECT_CLASS}
          >
            {BITRATES_KBPS[value.format as Exclude<OutputFormat, "wav">].map((kbps) => (
              <option key={kbps} value={kbps}>
                {fillTemplate(strings.bitrateOption, { n: String(kbps) })}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{strings.lossyNote}</p>
          {mp3 ? <Mp3Credit note={strings.mp3Note} /> : null}
        </div>
      ) : null}

      <div>
        <label htmlFor={`${prefix}-rate`} className="ui-label mb-1.5 block text-muted-foreground">
          {strings.sampleRateLabel}
        </label>
        <select
          id={`${prefix}-rate`}
          value={opus ? "48000" : String(value.sampleRate)}
          disabled={opus}
          onChange={(event) => onChange({ sampleRate: event.target.value === "original" ? "original" : Number(event.target.value) })}
          className={cn(SELECT_CLASS, opus && "opacity-60")}
          aria-describedby={opus ? `${prefix}-rate-note` : undefined}
        >
          {opus ? (
            <option value="48000">{fillTemplate(strings.sampleRateOption, { n: "48" })}</option>
          ) : (
            <>
              <option value="original">{strings.sampleRateOriginal}</option>
              {rates.map((hz) => (
                <option key={hz} value={hz}>
                  {fillTemplate(strings.sampleRateOption, { n: String(hz / 1000) })}
                </option>
              ))}
            </>
          )}
        </select>
        {opus ? (
          <p id={`${prefix}-rate-note`} className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {strings.opusRateNote}
          </p>
        ) : null}
      </div>

      <ChoiceGroup<"original" | "1" | "2">
        label={strings.channelsLabel}
        value={String(value.channels) as "original" | "1" | "2"}
        choices={[
          { value: "original", label: strings.channelsOriginal },
          { value: "1", label: strings.channelsMono },
          { value: "2", label: strings.channelsStereo },
        ]}
        onChange={(choice) => onChange({ channels: choice === "original" ? "original" : (Number(choice) as 1 | 2) })}
      />
    </div>
  );
}

/**
 * Credito a LAME (su licencia pide reconocerlo con un enlace a su sitio) y camino a la pagina de licencias. Ambos enlaces se
 * abren en otra pestana para no tirar el trabajo en curso (archivos ya elegidos), y lo dicen para quien usa lector de pantalla.
 */
function Mp3Credit({ note }: { note: SharedAudioStrings["mp3Note"] }) {
  const link = "text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal rounded-ios-sm pointer-coarse:inline-block pointer-coarse:py-3";
  return (
    <p data-mp3-credit="" className="mt-2 text-xs leading-relaxed text-muted-foreground">
      {note.lead}{" "}
      <a href="https://lame.sourceforge.io/" target="_blank" rel="noopener noreferrer" className={link}>
        {note.lame}
        <span className="sr-only"> {note.newTab}</span>
      </a>
      . {note.body}{" "}
      <a href="/licenses#mp3" target="_blank" rel="noopener noreferrer" className={link}>
        {note.licenses}
        <span className="sr-only"> {note.newTab}</span>
      </a>
    </p>
  );
}
