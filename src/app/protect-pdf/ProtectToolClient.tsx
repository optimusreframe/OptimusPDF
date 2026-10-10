"use client";

import { useCallback } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { Checkbox } from "@/components/ui/Checkbox";
import { PasswordField } from "@/app/protect-pdf/PasswordField";
import { StrengthMeter } from "@/app/protect-pdf/StrengthMeter";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PROTECT_OPTIONS,
  ProtectValidationError,
  passwordStrength,
  protectPdf,
  unsupportedPasswordChars,
  validateProtectOptions,
  type PasswordStrength,
  type ProtectOptions,
} from "@/lib/pdf/protect";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("protect-pdf");

export function ProtectToolClient() {
  const { language } = useI18n();
  const s = PROTECT_STRINGS[language];

  const strengthLabel = useCallback(
    (level: PasswordStrength): string =>
      level === "strong"
        ? s.strengthStrong
        : level === "medium"
          ? s.strengthMedium
          : s.strengthWeak,
    [s.strengthMedium, s.strengthStrong, s.strengthWeak],
  );

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
      canRun={(_files, options) => {
        const invalid = validateProtectOptions(options);
        if (invalid === "mismatch" && options.confirm.length === 0) {
          return { ok: false, reason: s.confirmRequired };
        }
        if (invalid === "unsupportedChars") {
          // Se senala el caracter problematico: nunca el mensaje de «ya esta protegido».
          return {
            ok: false,
            reason: s.errors.unsupportedChars.replace(
              "{chars}",
              unsupportedPasswordChars(options.password).join(" "),
            ),
          };
        }
        return invalid ? { ok: false, reason: s.errors[invalid] } : { ok: true };
      }}
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
      renderOptions={({ files, options, setOptions }) => {
        const strength = passwordStrength(options.password);
        const mismatch =
          options.confirm.length > 0 && options.confirm !== options.password;

        return (
          <>
            <PasswordField
              label={s.passwordLabel}
              value={options.password}
              onChange={(password) => setOptions({ password })}
              showLabel={s.showPassword}
              hideLabel={s.hidePassword}
              autoComplete="new-password"
              invalid={unsupportedPasswordChars(options.password).length > 0}
            />

            <StrengthMeter
              label={s.strengthLabel}
              score={strength.score}
              level={strength.level}
              levelLabel={strengthLabel(strength.level)}
              hint={s.strengthHint}
            />

            <PasswordField
              label={s.confirmLabel}
              value={options.confirm}
              onChange={(confirm) => setOptions({ confirm })}
              showLabel={s.showPassword}
              hideLabel={s.hidePassword}
              autoComplete="new-password"
              invalid={mismatch}
              hint={mismatch ? s.errors.mismatch : undefined}
              hintTone="error"
            />

            <div className="mt-2 border-t border-white/10 pt-4">
              <Checkbox
                label={s.requirePasswordLabel}
                hint={s.requirePasswordHint}
                checked={options.requirePasswordToOpen ?? true}
                onChange={(checked) => setOptions({ requirePasswordToOpen: checked })}
              />

              {(options.requirePasswordToOpen ?? true) === false ? (
                <p className="mt-2 pl-8 text-xs leading-relaxed text-accent-edit">
                  {s.openWithoutPasswordWarning}
                </p>
              ) : null}
            </div>

            <div className="mt-2 border-t border-white/10 pt-4">
              <h3 className="text-subheadline font-semibold text-foreground">
                {s.permissionsTitle}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {s.permissionsHint}
              </p>

              <div className="mt-3 flex flex-col gap-3">
                <Checkbox
                  label={s.permissionPrinting}
                  checked={options.allowPrinting ?? true}
                  onChange={(checked) => setOptions({ allowPrinting: checked })}
                />
                <Checkbox
                  label={s.permissionCopying}
                  checked={options.allowCopying ?? true}
                  onChange={(checked) => setOptions({ allowCopying: checked })}
                />
                <Checkbox
                  label={s.permissionModifying}
                  checked={options.allowModifying ?? true}
                  onChange={(checked) => setOptions({ allowModifying: checked })}
                />
                <Checkbox
                  label={s.permissionAnnotating}
                  checked={options.allowAnnotating ?? true}
                  onChange={(checked) => setOptions({ allowAnnotating: checked })}
                />
                <Checkbox
                  label={s.permissionFillingForms}
                  checked={options.allowFillingForms ?? true}
                  onChange={(checked) => setOptions({ allowFillingForms: checked })}
                />
                <Checkbox
                  label={s.permissionDocumentAssembly}
                  checked={options.allowDocumentAssembly ?? true}
                  onChange={(checked) => setOptions({ allowDocumentAssembly: checked })}
                />
              </div>

              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {s.legacyPdfDisclaimer}
              </p>
            </div>

            {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
              <p className="text-xs leading-relaxed text-destructive">
                {s.largeFile}
              </p>
            ) : null}
          </>
        );
      }}
    />
  );
}
