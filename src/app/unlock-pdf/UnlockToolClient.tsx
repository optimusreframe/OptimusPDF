"use client";

import { useCallback, useState } from "react";
import { KeyRound, Scale } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { PasswordField } from "@/app/protect-pdf/PasswordField";
import { UNLOCK_STRINGS } from "@/app/unlock-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_UNLOCK_OPTIONS,
  UnlockError,
  unlockPdf,
  type UnlockFailure,
  type UnlockOptions,
} from "@/lib/pdf/unlock";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("unlock-pdf");

export function UnlockToolClient() {
  const { language } = useI18n();
  const s = UNLOCK_STRINGS[language];
  const [failure, setFailure] = useState<UnlockFailure | null>(null);

  const process = useCallback(
    async (
      files: File[],
      options: UnlockOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      setFailure(null);
      try {
        const blob = await unlockPdf(file, options, onProgress);
        return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
      } catch (error) {
        // El motivo exacto se muestra junto al campo; `ToolShell` recibe
        // el error tal cual para volver al area de trabajo.
        if (error instanceof UnlockError) setFailure(error.reason);
        throw error;
      }
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<UnlockOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_UNLOCK_OPTIONS}
      process={process}
      renderMain={() => (
        <section className="glass rounded-ios p-5">
          <div className="flex items-start gap-3">
            <KeyRound
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-accent-security"
            />
            <div className="min-w-0">
              <h3 className="hud-label text-[11px] text-foreground">
                {s.infoTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.infoBody}
              </p>
            </div>
          </div>

          <div className="rounded-ios mt-4 flex items-start gap-3 border border-white/10 bg-white/5 p-4">
            <Scale
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p className="text-xs leading-relaxed text-foreground">
              {s.legalNote}
            </p>
          </div>

          {failure ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {s.errors[failure]}
            </p>
          ) : null}
        </section>
      )}
      renderOptions={({ files, options, setOptions }) => (
        <>
          <PasswordField
            label={s.passwordLabel}
            value={options.password}
            onChange={(password) => {
              setFailure(null);
              setOptions({ password });
            }}
            showLabel={s.showPassword}
            hideLabel={s.hidePassword}
            autoComplete="current-password"
            invalid={failure === "wrongPassword"}
            hint={failure ? s.errors[failure] : s.passwordHint}
            hintTone={failure ? "error" : "muted"}
          />

          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <p className="text-xs leading-relaxed text-destructive">
              {s.largeFile}
            </p>
          ) : null}
        </>
      )}
    />
  );
}
