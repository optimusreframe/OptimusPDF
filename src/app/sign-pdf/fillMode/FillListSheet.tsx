"use client";

import { useState } from "react";
import { Check, Circle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { useFillStrings } from "@/app/sign-pdf/fillMode/fillStrings";
import { isEmptyStep, needsAttention, type FillStep } from "@/app/sign-pdf/fillMode/fillSteps";

/*
 * «Lista de campos» del asistente «Rellenar»: salto directo a cualquier campo de la ronda (agrupados por documento), con el
 * estado de cada uno en palabras (el icono y el color solo acompanan), el filtro «Pendientes / Todos», «Ir al siguiente vacio»
 * y el ajuste «Revisar los autorrellenados».
 */

type Filter = "pending" | "all";

export type FillListSheetProps = {
  open: boolean;
  onClose: () => void;
  steps: readonly FillStep[];
  cursorKey: string | null;
  reviewAuto: boolean;
  onReviewAutoChange: (value: boolean) => void;
  onPick: (step: FillStep) => void;
  onGotoEmpty: () => void;
  stepName: (step: FillStep) => string;
  multiDocs: boolean;
};

export function FillListSheet({ open, onClose, steps, cursorKey, reviewAuto, onReviewAutoChange, onPick, onGotoEmpty, stepName, multiDocs }: FillListSheetProps) {
  const strings = useFillStrings();
  const [filter, setFilter] = useState<Filter>("pending");
  const pending = steps.filter((step) => needsAttention(step, true));
  const shown = filter === "pending" ? pending : steps;

  // Agrupa por documento conservando el orden de la ronda.
  const groups: { docId: string; docName: string; rows: FillStep[] }[] = [];
  for (const step of shown) {
    const last = groups[groups.length - 1];
    if (last && last.docId === step.docId) last.rows.push(step);
    else groups.push({ docId: step.docId, docName: step.docName, rows: [step] });
  }

  return (
    <Sheet open={open} onClose={onClose} title={strings.listTitle} closeLabel={strings.closeList}>
      <div className="space-y-4 pb-2" data-fill-list="">
        <p className="text-subheadline text-muted-foreground">{strings.listIntro}</p>
        <SegmentedControl<Filter>
          label={strings.listTitle}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: strings.listFilterPending(pending.length) },
            { value: "all", label: strings.listFilterAll(steps.length) },
          ]}
        />
        <Checkbox label={strings.reviewAuto} hint={strings.reviewAutoHint} checked={reviewAuto} onChange={onReviewAutoChange} />
        {pending.length > 0 ? (
          <Button variant="secondary" size="md" wrap onClick={onGotoEmpty} data-fill-goto-empty="">
            {strings.gotoEmpty}
          </Button>
        ) : null}

        {groups.length === 0 ? (
          <p className="rounded-ios-sm border border-white/10 px-3 py-4 text-center text-subheadline text-muted-foreground">{strings.listEmpty}</p>
        ) : (
          groups.map((group) => (
            <section key={group.docId} aria-label={multiDocs ? group.docName : strings.listTitle} className="space-y-2">
              {multiDocs ? <h4 className="ui-label truncate text-muted-foreground">{group.docName}</h4> : null}
              <ul className="space-y-2">
                {group.rows.map((step) => {
                  const empty = isEmptyStep(step);
                  const state = step.type === "checkbox" ? (step.value !== "" ? strings.listRowChecked : strings.listRowUnchecked) : empty ? strings.listRowEmpty : step.auto ? strings.listRowAuto : strings.listRowFilled;
                  return (
                    <li key={step.key}>
                      <button
                        type="button"
                        onClick={() => onPick(step)}
                        aria-current={step.key === cursorKey ? "true" : undefined}
                        data-fill-row={step.key === cursorKey ? "current" : empty ? "empty" : "filled"}
                        className={cn(
                          "flex min-h-14 w-full items-center gap-3 rounded-ios-sm border px-3 py-2 text-left",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-[0.99] motion-reduce:active:scale-100",
                          step.key === cursorKey ? "border-signal/60 bg-signal/10" : "border-white/10 bg-white/5",
                        )}
                      >
                        {empty ? (
                          <Circle aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                        ) : step.auto ? (
                          <Sparkles aria-hidden="true" className="size-5 shrink-0 text-signal-text" />
                        ) : (
                          <Check aria-hidden="true" className="size-5 shrink-0 text-success-text" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-callout font-medium text-foreground">
                            {stepName(step)}
                            {step.required ? <span className="ml-1.5 text-caption-2 font-semibold text-destructive-text">{strings.requiredBadge}</span> : null}
                          </span>
                          <span className="block truncate text-footnote text-muted-foreground">
                            {state}
                            {step.type !== "checkbox" && !empty ? ` · ${step.value}` : ""}
                            {` · p. ${step.field.pageIndex + 1}`}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </Sheet>
  );
}
