"use client";

import { ProgressBar } from "@/components/ui/ProgressBar";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/lib/i18n";

export type ProcessingOverlayProps = {
  /** Progreso 0..100. */
  progress: number;
  message: string;
  onCancel?: () => void;
};

export function ProcessingOverlay({
  progress,
  message,
  onCancel,
}: ProcessingOverlayProps) {
  const t = useT();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 px-4 backdrop-blur-md">
      <div className="glass rounded-ios-lg w-full max-w-md animate-rise-in p-7 text-center">
        <div className="flex justify-center">
          <Spinner className="size-7" />
        </div>
        <h2 className="mt-4 text-lg font-bold text-foreground">
          {t.tool.processingTitle}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{message}</p>

        <ProgressBar value={progress} className="mt-6" />

        <p className="hud-label mt-5 text-[10px] text-muted-foreground">
          {t.tool.processingHint}
        </p>

        {onCancel ? (
          <Button variant="ghost" size="sm" className="mt-4" onClick={onCancel}>
            {t.common.cancel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
