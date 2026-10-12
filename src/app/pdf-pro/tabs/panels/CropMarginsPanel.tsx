"use client";

import { useEffect } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { NumberField, OptionSection, ToggleRow } from "@/components/tool/OptionControls";
import { useI18n } from "@/lib/i18n";
import { marginsToRect, rectToMargins, roundMm, uniformMargins, type CropMargins } from "@/app/pdf-pro/ops/cropMath";
import { publishCropOverlay, subscribeCropRequests } from "@/app/pdf-pro/ops/cropOverlay";
import type { ProCropOptions } from "@/app/pdf-pro/ops/docOperations";
import { MmField } from "@/app/pdf-pro/tabs/panels/MmField";
import type { DocPanelProps } from "@/app/pdf-pro/tabs/docToolTypes";
import { getProStrings } from "@/app/pdf-pro/proStrings";

const fmt = (mm: number): string => String(roundMm(mm));

/**
 * Panel de «Recortar» de PDF Pro: margenes numericos (mm), «igual en todas» o por lado, y todas las
 * paginas o un rango. Publica la seleccion en el gancho `cropOverlay` para que el visor la pinte y escucha
 * sus peticiones de arrastre (ver `ops/cropOverlay.ts`).
 */
export function CropMarginsPanel({ options, setOptions, ctx }: DocPanelProps<ProCropOptions>) {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.crop;
  const { margins, linked, scope } = options;
  const page = ctx.firstPage;

  // La seleccion que se conserva, hacia el visor.
  useEffect(() => {
    if (!page) return;
    publishCropOverlay({ rect: marginsToRect(margins, page), pageIndex: Math.max(0, (scope === "range" ? options.fromPage : 1) - 1) });
    return () => publishCropOverlay(null);
  }, [margins, options.fromPage, page, scope]);

  // Y la que arrastra la persona en el visor, de vuelta a margenes.
  useEffect(() => {
    if (!page) return;
    return subscribeCropRequests((rect) => {
      const next = rectToMargins(rect, page);
      setOptions({
        margins: { top: roundMm(next.top), right: roundMm(next.right), bottom: roundMm(next.bottom), left: roundMm(next.left) },
        linked: false,
      });
    });
  }, [page, setOptions]);

  const setSide = (side: keyof CropMargins, value: number) => setOptions({ margins: { ...margins, [side]: value } });

  return (
    <>
      <OptionSection title={s.marginsTitle}>
        <ToggleRow
          label={s.linked}
          hint={s.linkedHint}
          checked={linked}
          onChange={(next) =>
            setOptions(next ? { linked: true, margins: uniformMargins(margins.top) } : { linked: false })
          }
        />
        {linked ? (
          <MmField label={s.linked} value={margins.top} onChange={(value) => setOptions({ margins: uniformMargins(value) })} />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <MmField label={s.top} value={margins.top} onChange={(value) => setSide("top", value)} />
            <MmField label={s.bottom} value={margins.bottom} onChange={(value) => setSide("bottom", value)} />
            <MmField label={s.left} value={margins.left} onChange={(value) => setSide("left", value)} />
            <MmField label={s.right} value={margins.right} onChange={(value) => setSide("right", value)} />
          </div>
        )}
        {page ? <p className="text-xs leading-relaxed text-muted-foreground">{s.pageSize(fmt(page.width), fmt(page.height))}</p> : null}
      </OptionSection>

      <OptionSection>
        <SegmentedControl<"all" | "range">
          label={s.scopeLabel}
          value={scope}
          onChange={(next) => setOptions({ scope: next })}
          options={[
            { value: "all", label: s.scopeAll },
            { value: "range", label: s.scopeRange },
          ]}
        />
        {scope === "range" ? (
          <>
            <div className="flex items-end gap-2">
              <NumberField label={s.from} value={options.fromPage} min={1} onChange={(fromPage) => setOptions({ fromPage })} />
              <NumberField label={s.to} value={options.toPage} min={0} onChange={(toPage) => setOptions({ toPage })} />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{s.rangeHint}</p>
          </>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">{s.proportionalNote}</p>
      </OptionSection>
    </>
  );
}
