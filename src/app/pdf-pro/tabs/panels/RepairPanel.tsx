"use client";

import { useMemo } from "react";
import { CheckCircle2, FileWarning } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { assessDamage } from "@/lib/pdf/repair";
import { REPAIR_STRINGS } from "@/app/repair-pdf/strings";
import { Row } from "@/app/repair-pdf/RepairReportView";
import type { DocPanelProps } from "@/app/pdf-pro/tabs/docToolTypes";
import { getProStrings } from "@/app/pdf-pro/proStrings";

/** Panel de «Reparar»: diagnostico del snapshot actual (sin tocar nada) antes de decidir si aplicar. */
export function RepairPanel({ ctx }: DocPanelProps<undefined>) {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.repair;
  const repair = REPAIR_STRINGS[language];
  const damage = useMemo(() => assessDamage(ctx.bytes), [ctx.bytes]);

  return (
    <section aria-label={s.analysisTitle} className="space-y-3">
      <h3 className="text-subheadline font-semibold text-foreground">{s.analysisTitle}</h3>
      {damage.length === 0 ? (
        <Row icon={CheckCircle2} tone="good">
          {s.healthy}
        </Row>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{repair.damageIntro}</p>
          <ul className="space-y-2">
            {damage.map((signal) => (
              <li key={signal}>
                <Row icon={FileWarning} tone="warn">
                  {repair.damage[signal]}
                </Row>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
