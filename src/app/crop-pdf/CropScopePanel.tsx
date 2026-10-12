"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { CropStrings } from "@/app/crop-pdf/strings";
import type { CropOptions, CropScope } from "@/lib/pdf/crop";

export type CropScopePanelProps = {
  options: CropOptions;
  setOptions: (patch: Partial<CropOptions>) => void;
  strings: CropStrings;
};

/** «Aplicar el recorte a» (todas / solo la visible) de la herramienta suelta. */
export function CropScopePanel({ options, setOptions, strings }: CropScopePanelProps) {
  return (
    <section className="space-y-3">
      <SegmentedControl<CropScope>
        label={strings.scopeLabel}
        value={options.scope}
        options={[
          { value: "all", label: strings.scopeAll },
          { value: "current", label: strings.scopeCurrent },
        ]}
        onChange={(scope) => setOptions({ scope })}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">{strings.scopeHint}</p>
    </section>
  );
}
