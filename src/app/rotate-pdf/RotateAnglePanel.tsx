"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { FieldNote } from "@/app/organize-pdf/pageToolkit";
import type { RotateStrings } from "@/app/rotate-pdf/strings";

export type RotateAnglePanelProps = {
  angle: number;
  onChange: (angle: number) => void;
  strings: RotateStrings;
  /** Texto de ayuda bajo el selector; por defecto, «se aplica a todas las paginas». */
  hint?: string | null;
};

/** Selector de angulo (90 / 180 / 270) de Rotar, COMPARTIDO por la herramienta suelta y por PDF Pro. */
export function RotateAnglePanel({ angle, onChange, strings, hint }: RotateAnglePanelProps) {
  const note = hint === undefined ? strings.allHint : hint;
  return (
    <>
      <SegmentedControl<string>
        label={strings.angleLabel}
        value={String(angle)}
        onChange={(value) => onChange(Number(value))}
        options={[
          { value: "90", label: strings.angle90 },
          { value: "180", label: strings.angle180 },
          { value: "270", label: strings.angle270 },
        ]}
      />
      {note ? <FieldNote>{note}</FieldNote> : null}
    </>
  );
}
