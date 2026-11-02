"use client";

import { useId, useState } from "react";

/**
 * Campo numerico en SEGUNDOS para una posicion de la pista (guardada en fotogramas). Mientras se escribe se respeta el
 * texto tal cual; al salir del campo o pulsar Intro se interpreta (coma o punto decimal), se acota a `[0, max]` y se
 * entrega en fotogramas.
 */
export type SecondsFieldProps = {
  label: string;
  frames: number;
  sampleRate: number;
  maxFrames: number;
  disabled?: boolean;
  onCommit: (frames: number) => void;
};

const format = (frames: number, rate: number) => (Math.round((frames / rate) * 100) / 100).toFixed(2);

export function SecondsField({ label, frames, sampleRate, maxFrames, disabled = false, onCommit }: SecondsFieldProps) {
  const id = useId();
  const shown = format(frames, sampleRate);
  // Texto en edicion; `null` = no se esta escribiendo y se muestra el valor de la pista.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number.parseFloat(draft.replace(",", "."));
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onCommit(Math.min(maxFrames, Math.max(0, Math.round(parsed * sampleRate))));
  };

  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="ui-label mb-1.5 block text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={draft ?? shown}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setDraft(null);
          }
        }}
        className="h-11 w-full min-w-0 rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground tabular-nums transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal disabled:opacity-60"
      />
    </div>
  );
}
