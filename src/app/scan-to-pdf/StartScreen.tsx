"use client";

import { useState } from "react";
import { Camera, ImagePlus, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { cn } from "@/lib/cn";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool } from "@/lib/tools-registry";
import { useI18n } from "@/lib/i18n";
import { useBlobUrl } from "@/app/scan-to-pdf/useBlobUrl";
import { ModeChips } from "@/app/scan-to-pdf/ModeChips";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";
import type { SavedSummary } from "@/app/scan-to-pdf/useScanSession";
import type { ScanMode } from "@/lib/scan/types";

const TOOL = getTool("scan-to-pdf");

/** «hace 3 min», «ayer»... con Intl; las fechas absolutas no dicen nada a quien vuelve a las dos horas. */
export function relativeWhen(iso: string, language: "es" | "en", now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return "";
  const format = new Intl.RelativeTimeFormat(language === "es" ? "es" : "en", { numeric: "auto" });
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return format.format(0, "minute");
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export type StartScreenProps = {
  s: ScanToPdfStrings;
  mode: ScanMode;
  onMode: (mode: ScanMode) => void;
  saved: SavedSummary | null;
  resumeNotice: string | null;
  resuming: boolean;
  onResume: (id: string) => void;
  onDiscardSaved: (id: string) => void;
  onCamera: () => void;
  onPhotos: () => void;
  onNative: () => void;
  closeLabel: string;
};

/** Inicio: retomar lo guardado, elegir el tipo de documento y UN camino principal (activar la camara), con las fotos como alternativa. */
export function StartScreen({ s, mode, onMode, saved, resumeNotice, resuming, onResume, onDiscardSaved, onCamera, onPhotos, onNative, closeLabel }: StartScreenProps) {
  const { t, language } = useI18n();
  const Icon = TOOL.icon;
  const thumbUrl = useBlobUrl(saved?.thumb ?? null);
  const [confirm, setConfirm] = useState(false);

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pt-8 pb-10 md:px-6 md:pt-12" data-start="">
      <header className="mb-6 flex items-start gap-4">
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-ios", ACCENT_BG_SOFT[TOOL.accent])}>
          <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[TOOL.accent])} />
        </span>
        <div className="min-w-0">
          <h1 className="text-title-1 text-foreground">{t.tools["scan-to-pdf"].name}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.tools["scan-to-pdf"].description}</p>
        </div>
      </header>

      {resumeNotice ? (
        <p data-resume-notice="" className="mb-4 rounded-ios border border-hairline bg-white/5 p-3 text-subheadline text-foreground">
          {resumeNotice}
        </p>
      ) : null}

      {saved ? (
        <section aria-labelledby="scan-resume-title" data-resume-banner="" className="surface-card mb-6 flex flex-col gap-3 rounded-ios-lg p-4">
          <div className="flex items-center gap-3">
            {thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbUrl} alt="" className="h-20 w-16 shrink-0 rounded-lg border border-hairline bg-white/5 object-cover" />
            ) : (
              <span className="h-20 w-16 shrink-0 rounded-lg border border-hairline bg-white/5" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <h2 id="scan-resume-title" className="text-callout font-semibold text-foreground">
                {s.resumeTitle}
              </h2>
              {saved.name ? <p className="mt-0.5 truncate text-subheadline text-foreground">{saved.name}</p> : null}
              <p className="mt-0.5 text-footnote text-muted-foreground">{s.resumeMeta(saved.pageCount, relativeWhen(saved.updatedAt, language))}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="lg" fullWidth data-resume-action="resume" disabled={resuming} onClick={() => onResume(saved.id)}>
              {resuming ? s.resumeLoading : s.resumeAction}
            </Button>
            <Button variant="secondary" size="lg" fullWidth data-resume-action="discard" onClick={() => setConfirm(true)}>
              {s.resumeDiscard}
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="scan-start-title" className="surface-card rounded-ios-lg p-5 md:p-6">
        <h2 id="scan-start-title" data-view-heading="" tabIndex={-1} className="text-title-3 text-foreground outline-none">
          {s.startTitle}
        </h2>
        <p className="mt-1.5 text-callout leading-relaxed text-muted-foreground">{s.startBody}</p>

        <div className="mt-5">
          <ModeChips s={s} mode={mode} onChange={onMode} />
          <p data-mode-hint="" className="mt-2 text-footnote text-muted-foreground">
            {s.modes[mode].hint}
          </p>
        </div>

        <div className="mt-5 flex flex-col gap-3">
          <Button size="lg" fullWidth data-camera-action="start" onClick={onCamera}>
            <Camera aria-hidden="true" className="size-5" />
            {s.startButton}
          </Button>
          <Button variant="secondary" size="lg" fullWidth data-camera-action="upload" onClick={onPhotos}>
            <ImagePlus aria-hidden="true" className="size-5" />
            {s.pickPhotos}
          </Button>
          <p className="-mt-1 text-center text-footnote text-muted-foreground">{s.pickPhotosHint}</p>
          <Button variant="ghost" size="md" fullWidth data-camera-action="native" className="pointer-coarse:h-11" onClick={onNative}>
            <Smartphone aria-hidden="true" className="size-4" />
            {s.nativeCamera}
          </Button>
          <p className="-mt-1 text-center text-footnote text-muted-foreground">{s.nativeCameraHint}</p>
        </div>
        <p className="mt-5 text-center text-footnote text-muted-foreground">{s.privacy}</p>
      </section>

      <ConfirmSheet
        open={confirm && saved !== null}
        onClose={() => setConfirm(false)}
        onConfirm={() => saved && onDiscardSaved(saved.id)}
        title={s.resumeDiscardTitle}
        body={s.resumeDiscardBody}
        confirmLabel={s.resumeDiscardConfirm}
        cancelLabel={s.resumeKeep}
        closeLabel={closeLabel}
        inertBackground
      />
    </div>
  );
}
