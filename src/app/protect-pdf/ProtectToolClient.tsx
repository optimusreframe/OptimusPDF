"use client";

import { useCallback } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { ProtectOptionsPanel } from "@/app/protect-pdf/ProtectOptionsPanel";
import { protectCanRun } from "@/app/protect-pdf/protectRules";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_PROTECT_OPTIONS,
  ProtectValidationError,
  protectPdf,
  validateProtectOptions,
  type ProtectOptions,
} from "@/lib/pdf/protect";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("protect-pdf");

export function ProtectToolClient() {
  const { language } = useI18n();
  const s = PROTECT_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: ProtectOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      // `canRun` ya impide llegar aqui con opciones invalidas (el motivo se lee junto a
      // «Procesar»); esto es la red de seguridad si alguien lanza el procesado por otra via.
      const invalid = validateProtectOptions(options);
      if (invalid) throw new ProtectValidationError(invalid);

      const file = files[0];
      const blob = await protectPdf(file, options, onProgress);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<ProtectOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PROTECT_OPTIONS}
      process={process}
      // Un PDF ya cifrado abre la hoja de contrasena (como en las demas herramientas): se trabaja con una
      // copia descifrada y se vuelve a proteger con la contrasena NUEVA (no sale «sin cifrar»).
      inputPolicy={{
        passwordCopy: { sheetBody: s.encryptedCopySheetBody, notice: s.encryptedCopyNotice },
      }}
      canRun={(_files, options) => protectCanRun(options, s)}
      renderMain={() => (
        <section className="glass rounded-ios p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-accent-security"
            />
            <div className="min-w-0">
              <h3 className="text-headline text-foreground">
                {s.infoTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.infoBody}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {s.permissionsNote}
              </p>
            </div>
          </div>

          <div className="rounded-ios mt-4 flex items-start gap-3 border border-white/10 bg-white/5 p-4">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p className="text-xs leading-relaxed text-foreground">
              {s.noRecovery}
            </p>
          </div>
        </section>
      )}
      renderOptions={({ files, options, setOptions }) => (
        <ProtectOptionsPanel
          options={options}
          setOptions={setOptions}
          strings={s}
          fileSize={files[0]?.size}
        />
      )}
    />
  );
}
