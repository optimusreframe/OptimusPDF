"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ChoiceGroup, NumberField, OptionSection } from "@/components/tool/OptionControls";
import { useI18n } from "@/lib/i18n";
import { RotateAnglePanel } from "@/app/rotate-pdf/RotateAnglePanel";
import { getRotateStrings } from "@/app/rotate-pdf/strings";
import type { ProRotateOptions } from "@/app/pdf-pro/ops/docOperations";
import type { DocPanelProps } from "@/app/pdf-pro/tabs/docToolTypes";
import { getProStrings } from "@/app/pdf-pro/proStrings";

/** Panel de «Rotar» de PDF Pro: el selector de angulo de la herramienta suelta + todo o un rango (pares/impares). */
export function RotateRangePanel({ options, setOptions }: DocPanelProps<ProRotateOptions>) {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.rotate;
  const rotateStrings = getRotateStrings(language);

  return (
    <>
      <OptionSection>
        <SegmentedControl<"all" | "range">
          label={s.scopeLabel}
          value={options.scope}
          onChange={(scope) => setOptions({ scope })}
          options={[
            { value: "all", label: s.scopeAll },
            { value: "range", label: s.scopeRange },
          ]}
        />
        <RotateAnglePanel
          angle={options.angle}
          onChange={(angle) => setOptions({ angle })}
          strings={rotateStrings}
          hint={options.scope === "all" ? undefined : null}
        />
      </OptionSection>
      {options.scope === "range" ? (
        <OptionSection>
          <div className="flex items-end gap-2">
            <NumberField label={s.from} value={options.fromPage} min={1} onChange={(fromPage) => setOptions({ fromPage })} />
            <NumberField label={s.to} value={options.toPage} min={0} onChange={(toPage) => setOptions({ toPage })} />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{s.rangeHint}</p>
          <ChoiceGroup<"all" | "odd" | "even">
            label={s.parityLabel}
            value={options.parity}
            columns={3}
            choices={[
              { value: "all", label: s.parityAll },
              { value: "odd", label: s.parityOdd },
              { value: "even", label: s.parityEven },
            ]}
            onChange={(parity) => setOptions({ parity })}
          />
        </OptionSection>
      ) : null}
    </>
  );
}
