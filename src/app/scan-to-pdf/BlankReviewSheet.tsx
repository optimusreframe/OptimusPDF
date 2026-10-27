"use client";

import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { useBlobUrl } from "@/app/scan-to-pdf/useBlobUrl";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";
import type { ScanPage } from "@/lib/scan/types";

export type BlankReviewSheetProps = {
  open: boolean;
  onClose: () => void;
  s: ScanToPdfStrings;
  closeLabel: string;
  /** Paginas posicionadas con su numero (1..n) para mostrarlas. */
  blanks: Array<{ page: ScanPage; number: number }>;
  sparse: Array<{ page: ScanPage; number: number }>;
  /** Las hojas que la persona dejo marcadas. */
  onConfirm: (ids: string[]) => void;
};

/**
 * «Quitar hojas en blanco» NUNCA borra a ciegas: esta hoja muestra miniaturas de lo que se quitaria. Las «en blanco» vienen
 * marcadas; las «casi vacias» (muy poco contenido: una firma, un numero) van en una lista aparte, SIN marcar. Solo se quitan las
 * marcadas y despues se puede deshacer.
 */
export function BlankReviewSheet({ open, onClose, s, closeLabel, blanks, sparse, onConfirm }: BlankReviewSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={s.blanksReview.title} closeLabel={closeLabel} inertBackground initialFocus="[data-blanks-confirm]">
      <BlankReviewBody s={s} blanks={blanks} sparse={sparse} onCancel={onClose} onConfirm={onConfirm} />
    </Sheet>
  );
}

function Thumb({ page, number, checked, onToggle, s }: { page: ScanPage; number: number; checked: boolean; onToggle: () => void; s: ScanToPdfStrings }) {
  const url = useBlobUrl(page.thumb ?? page.original);
  return (
    <label
      data-blank-item={page.id}
      className={cn(
        "relative flex min-h-[44px] cursor-pointer flex-col overflow-hidden rounded-ios-sm border bg-surface",
        checked ? "border-signal ring-2 ring-signal" : "border-hairline",
      )}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label={s.blanksReview.pageLabel(number)} className="peer sr-only" />
      <span className="aspect-[3/4] w-full bg-white/5">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full object-contain" />
        ) : null}
      </span>
      <span className="on-media absolute top-1 left-1 rounded-full bg-black/70 px-2 py-0.5 text-caption font-semibold text-white tabular-nums">{number}</span>
      <span
        aria-hidden="true"
        className={cn(
          "on-media absolute top-1 right-1 flex size-6 items-center justify-center rounded-full border-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal",
          checked ? "border-signal bg-signal text-[var(--color-on-signal)]" : "border-white bg-black/40",
        )}
      >
        {checked ? <Check className="size-4" strokeWidth={3} /> : null}
      </span>
    </label>
  );
}

function BlankReviewBody({ s, blanks, sparse, onCancel, onConfirm }: { s: ScanToPdfStrings; blanks: BlankReviewSheetProps["blanks"]; sparse: BlankReviewSheetProps["sparse"]; onCancel: () => void; onConfirm: (ids: string[]) => void }) {
  // Las «en blanco» marcadas; las «casi vacias», SIN marcar.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(blanks.map((entry) => entry.page.id)));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const count = selected.size;
  const copy = s.blanksReview;
  return (
    <div className="flex flex-col gap-4 pb-2" data-blanks-sheet="">
      <p className="text-subheadline text-muted-foreground">{copy.intro}</p>
      {blanks.length > 0 ? (
        <section aria-label={copy.blankList(blanks.length)} data-blanks-list="blank">
          <h3 className="text-footnote font-semibold text-foreground">{copy.blankList(blanks.length)}</h3>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {blanks.map(({ page, number }) => (
              <Thumb key={page.id} page={page} number={number} s={s} checked={selected.has(page.id)} onToggle={() => toggle(page.id)} />
            ))}
          </div>
        </section>
      ) : null}
      {sparse.length > 0 ? (
        <section aria-label={copy.sparseList(sparse.length)} data-blanks-list="sparse">
          <h3 className="text-footnote font-semibold text-foreground">{copy.sparseList(sparse.length)}</h3>
          <p className="mt-0.5 text-footnote text-muted-foreground">{copy.sparseHint}</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {sparse.map(({ page, number }) => (
              <Thumb key={page.id} page={page} number={number} s={s} checked={selected.has(page.id)} onToggle={() => toggle(page.id)} />
            ))}
          </div>
        </section>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button size="md" fullWidth wrap data-blanks-confirm="" disabled={count === 0} onClick={() => onConfirm(Array.from(selected))}>
          <Trash2 aria-hidden="true" className="size-4" />
          {copy.confirm(count)}
        </Button>
        <Button variant="secondary" size="md" fullWidth data-blanks-cancel="" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>
    </div>
  );
}
