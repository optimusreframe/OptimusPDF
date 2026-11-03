"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import type { LibraryTemplateStrings } from "@/app/sign-pdf/libraryTemplateStrings";
import { displayLevel, type LibraryTemplateRow } from "@/app/sign-pdf/templateCandidates";
import { isSafeLevel, matchingPageCount, type PageScope } from "@/app/sign-pdf/templateManual";
import { readRememberedCount } from "@/app/sign-pdf/templatePrefs";
import { chooseCount, variantSupport } from "@/app/sign-pdf/templateSession";

/*
 * El paso «Usar esta plantilla» (W3-A2) cuando hay algo que decidir: el PDF no es identico a la plantilla (cuantas paginas y como),
 * la plantilla sirve para 1 y 2 firmantes, el documento ya tiene campos que se reemplazarian, o se aplica a todos los documentos.
 * Con «Coincide» y un documento limpio no se pasa por aqui: «Usar esta plantilla» aplica directamente.
 */

export type PlanTarget = { row: LibraryTemplateRow; all: boolean };

/** ¿Hace falta este paso o basta aplicar directamente? */
export function needsPlan(row: LibraryTemplateRow, all: boolean, existingFields: number): boolean {
  if (all || existingFields > 0) return true;
  return row.level === "similar" || row.level === "none";
}

export type PlanChoice = { scope: PageScope; count: 1 | 2 };

type PlanSheetProps = {
  target: PlanTarget | null;
  t: LibraryTemplateStrings;
  docCount: number;
  existingFields: number;
  signerCount: number;
  busy: boolean;
  onConfirm: (target: PlanTarget, choice: PlanChoice) => void;
  onClose: () => void;
};

function PlanBody({ target, t, docCount, existingFields, signerCount, busy, onConfirm, onClose }: Omit<PlanSheetProps, "target"> & { target: PlanTarget }) {
  const { row, all } = target;
  const support = variantSupport(row.template);
  const showCount = support.one && support.two;
  const safe = isSafeLevel(row.match?.level ?? "none");
  // Con un parecido dudoso hay que decidir las paginas; sin comparacion o con «Coincide» no hay nada que elegir.
  const pageChoice = row.match !== null && !safe;
  const matching = matchingPageCount(row.match);
  const total = row.match?.pageMatches.length ?? 0;
  const [scope, setScope] = useState<PageScope>(row.level === "similar" && matching > 0 ? "matching" : "all");
  const [count, setCount] = useState<1 | 2>(() => chooseCount({ signers: signerCount, remembered: readRememberedCount(), support }));
  const kind = displayLevel(row.level);
  return (
    <div className="space-y-4 pb-2" data-template-plan="">
      <p className="text-subheadline text-foreground">{t.planLevel(row.level, row.percent)}</p>
      {pageChoice ? <Note>{scope === "all" ? t.planNotIdentical : t.planNotIdenticalMatching}</Note> : kind === "unknown" ? <Note>{t.planNoOrigin}</Note> : null}
      {pageChoice ? (
        <div className="space-y-2">
          <SegmentedControl<PageScope>
            label={t.scopeLabel}
            value={scope}
            onChange={setScope}
            wrap
            options={[
              { value: "all", label: t.scopeAll },
              { value: "matching", label: t.scopeMatching(matching, total) },
            ]}
          />
          <p className="text-footnote leading-relaxed text-muted-foreground">{scope === "all" ? t.scopeAllHint : t.scopeMatchingHint}</p>
        </div>
      ) : null}
      {showCount ? (
        <SegmentedControl<"1" | "2">
          label={t.signersLabel}
          value={String(count) as "1" | "2"}
          onChange={(value) => setCount(value === "2" ? 2 : 1)}
          options={[
            { value: "1", label: t.signersOne },
            { value: "2", label: t.signersTwo },
          ]}
        />
      ) : null}
      {existingFields > 0 ? <Note>{t.existingWork(existingFields)}</Note> : null}
      {all && docCount > 1 ? <Note>{t.allWarning(docCount)}</Note> : null}
      <div className="flex flex-col gap-2">
        <Button size="md" fullWidth wrap disabled={busy} onClick={() => onConfirm(target, { scope: pageChoice ? scope : "matching", count })}>
          {busy ? t.planBusy : all ? t.planConfirmAll : t.planConfirm}
        </Button>
        <Button variant="secondary" size="md" fullWidth disabled={busy} onClick={onClose}>
          {t.planCancel}
        </Button>
      </div>
    </div>
  );
}

/** Aviso dentro del paso: icono + texto (el estado nunca va solo en color). */
function Note({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-2 rounded-ios-sm border border-white/14 bg-elevated px-3 py-2 text-footnote leading-relaxed text-foreground" role="note">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-signal-text" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

export function TemplatePlanSheet(props: PlanSheetProps) {
  const { target, t, onClose } = props;
  // La hoja que sale conserva el contenido con que se abrio.
  const [shown, setShown] = useState<PlanTarget | null>(target);
  if (target && target !== shown) setShown(target);
  const content = target ?? shown;
  if (!content) return null;
  return (
    <Sheet open={target !== null} onClose={onClose} title={t.planTitle(content.row.template.name)} closeLabel={t.planClose}>
      <PlanBody key={`${content.row.template.id}:${content.all ? "all" : "one"}`} {...props} target={content} />
    </Sheet>
  );
}
