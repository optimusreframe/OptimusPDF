"use client";

import { useEffect, useRef } from "react";
import {
  CalendarDays,
  CaseUpper,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  MoveHorizontal,
  MoveVertical,
  PenLine,
  Signature,
  SquareCheck,
  Type,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { EditModeStrings } from "@/app/sign-pdf/editMode/editModeStrings";
import { ChoiceRow, PillButton, SectionTitle, SwitchRow, scrollWithin } from "@/app/sign-pdf/editMode/editUi";
import type { FitMode } from "@/app/sign-pdf/editMode/viewMath";

/*
 * Paneles de lista del modo «Editar campos» (W3-B1): Elementos (todo lo del documento, sin gestos), Paginas (miniaturas con
 * puntos de campos) y Ayuda (gestos, atajos y preferencias). Son solo presentacion; el lienzo les da los datos y las acciones.
 */

export type ElementIcon = "signature" | "initials" | "text" | "checkbox" | "date" | "textInitials";

export type ElementRow = {
  key: string;
  id: string;
  kind: "slot" | "text";
  pageIndex: number;
  name: string;
  /** Una linea de detalle (el valor escrito, el firmante...). */
  detail: string;
  /** `null` = no tiene estado de relleno (un hueco de firma se firma en el paso siguiente). */
  done: boolean | null;
  color: string;
  icon: ElementIcon;
  selected: boolean;
};

const ICONS: Record<ElementIcon, typeof Type> = {
  signature: PenLine,
  initials: Signature,
  text: Type,
  checkbox: SquareCheck,
  date: CalendarDays,
  textInitials: CaseUpper,
};

/* ------------------------------------------------------------------ *
 * Elementos
 * ------------------------------------------------------------------ */

export function ElementsPanel({
  rows,
  pageIndex,
  edit,
  onSelect,
}: {
  rows: readonly ElementRow[];
  pageIndex: number;
  edit: EditModeStrings;
  onSelect: (row: ElementRow) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const selectedKey = rows.find((row) => row.selected)?.key ?? null;
  useEffect(() => {
    // El elemento seleccionado a la vista cuando se abre la lista.
    scrollWithin(selectedRef.current);
  }, [selectedKey]);

  if (rows.length === 0) {
    return <p className="py-4 text-footnote leading-relaxed text-muted-foreground">{edit.elementsEmpty}</p>;
  }
  const pages = Array.from(new Set(rows.map((row) => row.pageIndex))).sort((a, b) => a - b);
  return (
    <div className="space-y-4" data-edit-elements="">
      <h3 className="sr-only">{edit.elementsTitle}</h3>
      {pages.map((page) => {
        const inPage = rows.filter((row) => row.pageIndex === page);
        return (
          <section key={page} aria-label={edit.elementsPage(page + 1, inPage.length)}>
            <SectionTitle className={cn(page === pageIndex && "text-foreground")}>
              {edit.elementsPage(page + 1, inPage.length)}
            </SectionTitle>
            <ul className="space-y-1.5">
              {inPage.map((row) => {
                const Icon = ICONS[row.icon];
                return (
                  <li key={row.key}>
                    <button
                      ref={row.selected ? selectedRef : undefined}
                      type="button"
                      aria-current={row.selected ? "true" : undefined}
                      aria-label={edit.elementOpen(row.name, row.pageIndex + 1)}
                      onClick={() => onSelect(row)}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-ios-sm px-3 py-1.5 text-left",
                        row.selected
                          ? "bg-signal/20 shadow-[inset_0_0_0_1.5px_var(--color-signal)]"
                          : "bg-white/6 hover:bg-white/12",
                        "transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.99] motion-reduce:active:scale-100",
                        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-full"
                        /* Color del firmante o del campo: dato del documento, no un token del tema. */
                        style={{ backgroundColor: `${row.color}33`, color: row.color }}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-footnote font-semibold text-foreground">{row.name}</span>
                        {row.detail ? (
                          <span className="block truncate text-caption text-muted-foreground">{row.detail}</span>
                        ) : null}
                      </span>
                      {row.done === null ? null : (
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 text-caption font-medium",
                            row.done ? "text-success-text" : "text-muted-foreground",
                          )}
                        >
                          {row.done ? (
                            <Check aria-hidden="true" className="size-3.5" />
                          ) : (
                            <Circle aria-hidden="true" className="size-3.5" />
                          )}
                          {row.done ? edit.elementDone : edit.elementPending}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Paginas
 * ------------------------------------------------------------------ */

export function PagesPanel({
  thumbs,
  pageCount,
  pageIndex,
  counts,
  strip,
  strings,
  edit,
  onGo,
  onStepWithFields,
  docs,
  onSelectDoc,
}: {
  thumbs: readonly string[];
  pageCount: number;
  pageIndex: number;
  /** Elementos por pagina. */
  counts: readonly number[];
  /** Tira horizontal (panel de abajo); si no, rejilla vertical (panel lateral). */
  strip: boolean;
  strings: SignStrings;
  edit: EditModeStrings;
  onGo: (index: number) => void;
  onStepWithFields: (direction: 1 | -1) => void;
  /** Varios documentos: el selector de documento va arriba. */
  docs?: readonly { id: string; name: string; active: boolean }[];
  onSelectDoc?: (docId: string) => void;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    scrollWithin(currentRef.current, "center");
  }, [pageIndex]);
  const total = Math.max(pageCount, thumbs.length);
  const docPicker =
    docs && docs.length > 1 && onSelectDoc ? (
      <section>
        <SectionTitle>{edit.documentLabel}</SectionTitle>
        <ChoiceRow<string>
          label={edit.documentLabel}
          value={docs.find((doc) => doc.active)?.id ?? docs[0].id}
          choices={docs.map((doc) => ({ value: doc.id, label: doc.name }))}
          onChange={onSelectDoc}
        />
      </section>
    ) : null;
  if (total <= 1) {
    return (
      <div className="space-y-3" data-edit-pages="">
        {docPicker}
        <p className="py-2 text-footnote leading-relaxed text-muted-foreground">{edit.pagesEmpty}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-edit-pages="">
      <h3 className="sr-only">{edit.pagesTitle}</h3>
      {docPicker}
      <div className="flex flex-wrap gap-2">
        <PillButton onClick={() => onStepWithFields(-1)}>
          <ChevronsLeft aria-hidden="true" className="size-4" />
          {edit.prevWithFields}
        </PillButton>
        <PillButton onClick={() => onStepWithFields(1)}>
          {edit.nextWithFields}
          <ChevronsRight aria-hidden="true" className="size-4" />
        </PillButton>
      </div>
      <ul
        data-edit-scroll={strip ? "" : undefined}
        className={cn(
          strip
            ? "flex snap-x gap-2 overflow-x-auto overscroll-x-contain pb-2"
            : "grid grid-cols-2 gap-2",
        )}
      >
        {Array.from({ length: total }, (_, index) => {
          const count = counts[index] ?? 0;
          const current = index === pageIndex;
          const thumb = thumbs[index];
          return (
            <li key={index} className={cn(strip && "shrink-0 snap-center")}>
              <button
                ref={current ? currentRef : undefined}
                type="button"
                aria-label={edit.pageThumb(index + 1, count)}
                aria-current={current ? "page" : undefined}
                onClick={() => onGo(index)}
                className={cn(
                  "relative block overflow-hidden rounded-ios-sm border-2 p-0.5",
                  current ? "border-signal" : "border-white/10 hover:border-white/25",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                )}
              >
                {thumb ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={thumb}
                    alt=""
                    draggable={false}
                    className={cn("block rounded-[8px] bg-white", strip ? "h-28 w-auto" : "w-full")}
                  />
                ) : (
                  <span className={cn("block rounded-[8px] bg-white/10", strip ? "h-28 w-20" : "aspect-[3/4] w-full")} />
                )}
                <span className="absolute inset-x-1 bottom-1 flex items-center justify-between gap-1 rounded-full bg-background/90 px-1.5 py-0.5 text-caption-2 leading-tight font-semibold text-foreground tabular-nums">
                  <span>{index + 1}</span>
                  {count > 0 ? (
                    <span className="flex items-center gap-0.5" aria-hidden="true">
                      {Array.from({ length: Math.min(count, 4) }, (_, dot) => (
                        <span key={dot} className="size-1.5 rounded-full bg-signal" />
                      ))}
                      {count > 4 ? <span>+{count - 4}</span> : null}
                    </span>
                  ) : null}
                </span>
                {current ? <span className="sr-only">{edit.pageCurrent}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-caption text-muted-foreground">{strings.pageOf(pageIndex + 1, total)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ayuda
 * ------------------------------------------------------------------ */

export function HelpPanel({
  edit,
  fitMode,
  onFit,
  openOnEnter,
  onOpenOnEnter,
}: {
  edit: EditModeStrings;
  fitMode: FitMode;
  onFit: (mode: FitMode) => void;
  openOnEnter: boolean | null;
  onOpenOnEnter: (on: boolean) => void;
}) {
  return (
    <div className="space-y-5" data-edit-help="">
      <h3 className="sr-only">{edit.helpTitle}</h3>
      <section>
        <SectionTitle>{edit.helpPrefsTitle}</SectionTitle>
        <div className="space-y-3">
          <ChoiceRow<FitMode>
            label={edit.helpFitLabel}
            value={fitMode}
            onChange={onFit}
            choices={[
              { value: "height", label: edit.fitToHeight, icon: <MoveVertical aria-hidden="true" className="size-4" /> },
              { value: "width", label: edit.fitToWidth, icon: <MoveHorizontal aria-hidden="true" className="size-4" /> },
            ]}
          />
          {openOnEnter !== null ? (
            <SwitchRow
              label={edit.helpOpenAlways}
              hint={edit.helpOpenAlwaysHint}
              checked={openOnEnter}
              onChange={onOpenOnEnter}
            />
          ) : null}
        </div>
      </section>
      <section>
        <SectionTitle>{edit.helpGesturesTitle}</SectionTitle>
        <ul className="list-disc space-y-2 pl-5 text-footnote leading-relaxed text-foreground marker:text-muted-foreground">
          {edit.helpGestures.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section>
        <SectionTitle>{edit.helpShortcutsTitle}</SectionTitle>
        <dl className="space-y-2">
          {edit.helpShortcuts.map(([keys, action]) => (
            <div key={keys} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="shrink-0 font-mono text-caption font-semibold text-signal-text sm:w-44">{keys}</dt>
              <dd className="min-w-0 text-footnote leading-relaxed text-foreground">{action}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
