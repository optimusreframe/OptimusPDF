"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { EXTRACT_LIMITS } from "@/lib/pdf/extractAssets/types";
import { fill, type ExtractStrings } from "@/app/extract-assets/model";
import { INPUT_CLASS } from "@/app/extract-assets/ui";

export type RangeNoticeProps = {
  strings: ExtractStrings;
  pageCount: number;
  /** Rango analizado ahora (1-based, inclusivo). */
  initial: { from: number; to: number };
  onApply: (range: { from: number; to: number }) => void;
};

/** Documento de mas paginas que el tope (300): se avisa y se deja elegir otro rango (hasta 300 paginas seguidas). */
export function RangeNotice({ strings, pageCount, initial, onApply }: RangeNoticeProps) {
  const id = useId();
  const [from, setFrom] = useState(String(initial.from));
  const [to, setTo] = useState(String(initial.to));
  const fromValue = Number.parseInt(from, 10);
  const toValue = Number.parseInt(to, 10);
  const valid =
    Number.isInteger(fromValue) &&
    Number.isInteger(toValue) &&
    fromValue >= 1 &&
    toValue >= fromValue &&
    toValue <= pageCount &&
    toValue - fromValue + 1 <= EXTRACT_LIMITS.maxPages;
  const touched = from !== String(initial.from) || to !== String(initial.to);

  return (
    <form
      className="surface-card space-y-3 rounded-ios p-4"
      data-extract-range
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onApply({ from: fromValue, to: toValue });
      }}
    >
      <h3 className="ui-label text-muted-foreground">{strings.rangeTitle}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${id}-from`} className="mb-1 block text-footnote text-muted-foreground">
            {strings.rangeFrom}
          </label>
          <input id={`${id}-from`} type="number" inputMode="numeric" min={1} max={pageCount} value={from} onChange={(event) => setFrom(event.target.value)} className={cn(INPUT_CLASS, "w-28 tabular-nums")} />
        </div>
        <div>
          <label htmlFor={`${id}-to`} className="mb-1 block text-footnote text-muted-foreground">
            {strings.rangeTo}
          </label>
          <input id={`${id}-to`} type="number" inputMode="numeric" min={1} max={pageCount} value={to} onChange={(event) => setTo(event.target.value)} className={cn(INPUT_CLASS, "w-28 tabular-nums")} />
        </div>
        <Button type="submit" variant="secondary" disabled={!valid}>
          {strings.rangeApply}
        </Button>
      </div>
      {touched && !valid ? (
        <p className="text-footnote text-destructive-text">{fill(strings.rangeInvalid, { total: pageCount, max: EXTRACT_LIMITS.maxPages })}</p>
      ) : null}
    </form>
  );
}
