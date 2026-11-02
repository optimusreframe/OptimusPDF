"use client";

import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

const FIELD_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 pl-3 pr-11 text-sm pointer-coarse:text-base text-foreground " +
  "placeholder:text-muted-foreground/70 transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

export type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Etiquetas accesibles del boton de mostrar/ocultar. */
  showLabel: string;
  hideLabel: string;
  autoComplete?: "new-password" | "current-password";
  invalid?: boolean;
  hint?: string;
  hintTone?: "muted" | "error";
};

/**
 * Campo de contrasena con conmutador de visibilidad. Se comparte entre
 * Proteger y Desbloquear para que ambas se comporten igual.
 */
export function PasswordField({
  label,
  value,
  onChange,
  showLabel,
  hideLabel,
  autoComplete = "new-password",
  invalid = false,
  hint,
  hintTone = "muted",
}: PasswordFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="w-full">
      <label
        htmlFor={id}
        className="ui-label mb-2 block text-muted-foreground"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={cn(FIELD_CLASS, invalid && "border-destructive/60")}
        />
        <button
          type="button"
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          onClick={() => setVisible((previous) => !previous)}
          className={cn(
            "absolute inset-y-0 right-0 flex w-11 items-center justify-center",
            "text-muted-foreground transition-colors hover:text-foreground",
          )}
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
      {hint ? (
        <p
          id={hintId}
          className={cn(
            "mt-2 text-xs leading-relaxed",
            hintTone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
