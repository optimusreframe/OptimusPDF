"use client";

import { useCallback } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { PasswordField } from "@/app/protect-pdf/PasswordField";
import { StrengthMeter } from "@/app/protect-pdf/StrengthMeter";
import type { ProtectStrings } from "@/app/protect-pdf/strings";
import { MAX_SAFE_FILE_SIZE } from "@/lib/pdf/core";
import {
  passwordStrength,
  unsupportedPasswordChars,
  type PasswordStrength,
  type ProtectOptions,
} from "@/lib/pdf/protect";

export type ProtectOptionsPanelProps = {
  options: ProtectOptions;
  setOptions: (patch: Partial<ProtectOptions>) => void;
  strings: ProtectStrings;
  /** Peso del archivo, para avisar de que uno enorme puede agotar la memoria. */
  fileSize?: number;
};

/**
 * Contrasena, confirmacion, medidor, «pedir contrasena al abrir» y permisos de Proteger PDF, COMPARTIDO
 * por la herramienta suelta y por PDF Pro («Guardar con contraseña…»): mismas validaciones y mismo motor.
 */
export function ProtectOptionsPanel({ options, setOptions, strings: s, fileSize }: ProtectOptionsPanelProps) {
  const strengthLabel = useCallback(
    (level: PasswordStrength): string =>
      level === "strong" ? s.strengthStrong : level === "medium" ? s.strengthMedium : s.strengthWeak,
    [s.strengthMedium, s.strengthStrong, s.strengthWeak],
  );
  const strength = passwordStrength(options.password);
  const mismatch = options.confirm.length > 0 && options.confirm !== options.password;

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
          <p className="mt-2 pl-8 text-xs leading-relaxed text-accent-edit">{s.openWithoutPasswordWarning}</p>
        ) : null}
      </div>

      <div className="mt-2 border-t border-white/10 pt-4">
        <h3 className="text-subheadline font-semibold text-foreground">{s.permissionsTitle}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.permissionsHint}</p>

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

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{s.legacyPdfDisclaimer}</p>
      </div>

      {fileSize !== undefined && fileSize > MAX_SAFE_FILE_SIZE ? (
        <p className="text-xs leading-relaxed text-destructive">{s.largeFile}</p>
      ) : null}
    </>
  );
}
