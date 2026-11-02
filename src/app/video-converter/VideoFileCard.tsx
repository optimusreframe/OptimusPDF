"use client";

import type { Ref } from "react";
import { FileVideo, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/pdf/core";
import { codecLabel } from "@/lib/media/video/formats";
import { formatDimensions, formatDuration, formatFps } from "@/lib/media/video/display";
import type { VideoInfo } from "@/lib/media/video/types";
import { fillTemplate, type VideoConverterStrings } from "@/app/video-converter/strings";

/**
 * Tarjeta del archivo elegido: nombre y, cuando ya se leyo su cabecera, duracion, resolucion, ritmo, codecs y peso. Mientras
 * se lee muestra un indicador con texto. Es la region a la que va el foco al elegir un archivo (`tabIndex=-1`).
 */
export function VideoFileCard({
  file,
  info,
  probing,
  strings,
  locale,
  onRemove,
  regionRef,
}: {
  file: File;
  info: VideoInfo | null;
  probing: boolean;
  strings: VideoConverterStrings;
  locale: string;
  onRemove: () => void;
  regionRef?: Ref<HTMLElement>;
}) {
  const fps = info ? formatFps(info.fps) : null;
  const rows: Array<[string, string]> = info
    ? [
        [strings.duration, formatDuration(info.duration)],
        [
          strings.dimensions,
          [
            formatDimensions(info.width, info.height),
            fps ? fillTemplate(strings.fpsUnit, { fps }) : null,
            info.rotation ? fillTemplate(strings.rotated, { degrees: info.rotation }) : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ],
        [strings.container, info.container],
        [strings.videoTrack, codecLabel(info.videoCodec)],
        [
          strings.audioTrack,
          info.audio ? [codecLabel(info.audio.codec), info.audio.channels === 1 ? "mono" : info.audio.channels === 2 ? "stereo" : `${info.audio.channels} ch`].join(" · ") : strings.noAudio,
        ],
        [strings.weight, formatFileSize(info.fileSize, locale)],
      ]
    : [[strings.weight, formatFileSize(file.size, locale)]];
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label={strings.cardTitle}
      data-video-card=""
      className={cn("surface-card rounded-ios p-4 outline-none md:p-5")}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-ios-sm bg-white/8">
          <FileVideo aria-hidden="true" className="size-5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-headline text-foreground" data-video-name="">
            {file.name}
          </p>
          {probing ? (
            <p role="status" className="mt-1 flex items-center gap-2 text-subheadline text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
              {strings.probing}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" aria-label={strings.removeFile} title={strings.removeFile} onClick={onRemove} className="shrink-0">
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-4 gap-y-2 sm:grid-cols-2 sm:gap-x-6" data-video-info="">
        {rows.map(([term, value]) => (
          <div key={term} className="min-w-0">
            <dt className="ui-label text-muted-foreground">{term}</dt>
            <dd className="break-words text-subheadline text-foreground tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
