"use client";

import { forwardRef, useEffect, useId, useMemo, type Ref } from "react";
import { AlertTriangle, Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { docLabel, signerLabel, type BlockContext, type DocRef } from "@/app/sign-pdf/blockModel";
import { docIdOf, type DocId, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { reviewSession, type MarkKind, type ReviewDoc, type ReviewPageMarks } from "@/app/sign-pdf/reviewModel";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { thumbKey, useSequenceMeta } from "@/app/sign-pdf/useSequenceMeta";
import type { Signer } from "@/lib/pdf/sign";

/*
 * «Revisar antes de descargar» (Firma agil · Fase 1 · U1.3): lo ultimo que se ve antes de «Firmar y descargar». Por cada
 * documento, una miniatura de CADA pagina que lleva firma, iniciales o texto (con sus huecos dibujados encima y el
 * estado de cada uno), el contador del documento («Iniciales: 8 de 8 · Firmas: 2 de 2») y, arriba, los problemas:
 * los que IMPIDEN descargar (con «Ir a corregirlo») y los avisos, que dejan continuar. Tocar una miniatura lleva a esa
 * pagina del documento.
 *
 * No es una region viva (la ceremonia ya tiene la suya) y no guarda nada: pinta lo que recibe. Los datos de las marcas
 * salen de `reviewModel.ts`; las miniaturas, de la cola perezosa de `useSequenceMeta` (un documento abierto a la vez).
 */

/** Un problema ya redactado: lo que se ensena y, si se puede corregir, a donde lleva. */
export type ReviewIssueView = {
  key: string;
  severity: "blocking" | "warning";
  text: string;
  onFix?: () => void;
};

export type ReviewBeforeDownloadProps = {
  strings: SignStrings;
  signers: readonly Signer[];
  /** Documentos de la ronda, en el orden de la cola. */
  docs: readonly DocRef[];
  docStates: Readonly<Record<DocId, DocState>>;
  blocks: readonly SignerBlock[];
  ctx: BlockContext;
  /** Archivos de la cola (para las miniaturas); sin ellos solo se ven las paginas y los contadores. */
  files?: readonly File[];
  /** Problemas de la validacion de la asignacion ya redactados. */
  issues: readonly ReviewIssueView[];
  /** Archivos que se descargaran (suma de copias). */
  fileCount: number;
  onGoToPage?: (docId: DocId, pageIndex: number) => void;
  /**
   * `full` = la pantalla entera (miniaturas, contadores y problemas); `issues` = solo los problemas, mientras aun hay
   * firmas por recoger (no se abre ningun documento para las miniaturas).
   */
  mode?: "full" | "issues";
  className?: string;
};

const KIND_ORDER: MarkKind[] = ["signature", "initials", "text"];

function kindLabel(kind: MarkKind, strings: SignStrings): string {
  const text = strings.review;
  return kind === "signature" ? text.kindSignature : kind === "initials" ? text.kindInitials : text.kindText;
}

function pageKinds(page: ReviewPageMarks, strings: SignStrings): string[] {
  const kinds = new Set(page.marks.map((mark) => mark.kind));
  return KIND_ORDER.filter((kind) => kinds.has(kind)).map((kind) => kindLabel(kind, strings));
}

export const ReviewBeforeDownload = forwardRef<HTMLHeadingElement, ReviewBeforeDownloadProps>(
  function ReviewBeforeDownload(
    { strings, signers, docs, docStates, blocks, ctx, files, issues, fileCount, onGoToPage, mode = "full", className },
    headingRef: Ref<HTMLHeadingElement>,
  ) {
    const text = strings.review;
    const titleId = useId();
    const docIds = docs.map((doc) => doc.id);
    const metaDocs = useMemo(
      () => (mode === "full" ? (files ?? []) : []).map((file) => ({ id: docIdOf(file), file })),
      [files, mode],
    );
    const meta = useSequenceMeta(metaDocs, docIds[0] ?? "", true);

    const reviews = reviewSession({
      docIds,
      docs: docStates,
      signers,
      blocks,
      ctx,
      pageCounts: meta.counts,
    });

    // Las miniaturas que hacen falta: TODAS las paginas con marcas (la cola las hace de una en una).
    const wanted = reviews.flatMap((review) => review.pages.map((page) => thumbKey(review.docId, page.pageIndex)));
    const wantedKey = wanted.join("|");
    const { setVisible } = meta;
    useEffect(() => {
      setVisible(wanted.length > 0 ? new Set(wantedKey.split("|")) : null);
      // `wanted` se deriva de `wantedKey`.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wantedKey, setVisible]);

    const nameOfDoc = (docId: DocId) => docLabel(docs.find((doc) => doc.id === docId)?.name ?? docId);
    const gapIssues: ReviewIssueView[] = reviews.flatMap((review) =>
      review.initialsGaps.map((gap) => ({
        key: `gap|${review.docId}|${gap.signerId}`,
        severity: "warning" as const,
        text: text.initialsMissing(
          nameOfDoc(review.docId),
          signerLabel(signers, gap.signerId, strings),
          gap.pages.map((page) => page + 1),
        ),
        onFix: onGoToPage ? () => onGoToPage(review.docId, gap.pages[0]) : undefined,
      })),
    );
    const all = [...issues, ...(mode === "full" ? gapIssues : [])];
    const blocking = all.filter((issue) => issue.severity === "blocking");
    const warnings = all.filter((issue) => issue.severity === "warning");

    if (mode === "issues") {
      if (all.length === 0) return null;
      return (
        <div className={cn("space-y-3", className)}>
          {blocking.length > 0 ? (
            <IssueList title={text.blockedTitle} tone="blocking" items={blocking} fixLabel={strings.assignment.fixIt} />
          ) : null}
          {warnings.length > 0 ? (
            <IssueList title={text.warningsTitle} tone="warning" items={warnings} fixLabel={strings.assignment.fixIt} />
          ) : null}
        </div>
      );
    }

    return (
      <section aria-labelledby={titleId} className={cn("space-y-4", className)}>
        <div>
          <h4
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="text-headline text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            {text.title}
          </h4>
          <p className="mt-1 text-footnote leading-relaxed text-muted-foreground">{text.intro}</p>
        </div>

        {blocking.length > 0 ? (
          <IssueList title={text.blockedTitle} tone="blocking" items={blocking} fixLabel={strings.assignment.fixIt} />
        ) : null}
        {warnings.length > 0 ? (
          <IssueList title={text.warningsTitle} tone="warning" items={warnings} fixLabel={strings.assignment.fixIt} />
        ) : null}
        {blocking.length === 0 ? (
          <p className="flex items-start gap-2 text-subheadline font-medium text-foreground">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              {text.readyTitle}. {text.readyBody(fileCount)}
            </span>
          </p>
        ) : null}

        <ul className="space-y-4">
          {reviews.map((review) => (
            <li key={review.docId} className="rounded-ios-sm space-y-3 border border-white/10 bg-white/5 p-3">
              <ReviewDocSection
                review={review}
                name={nameOfDoc(review.docId)}
                pageCount={meta.counts[review.docId]}
                thumbs={meta.thumbs}
                strings={strings}
                onGoToPage={onGoToPage}
              />
            </li>
          ))}
        </ul>
      </section>
    );
  },
);

function IssueList({
  title,
  tone,
  items,
  fixLabel,
}: {
  title: string;
  tone: "blocking" | "warning";
  items: readonly ReviewIssueView[];
  fixLabel: string;
}) {
  return (
    <div className="space-y-2">
      <h5 className="text-footnote font-semibold text-foreground">{title}</h5>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.key}
            data-issue-severity={item.severity}
            className={cn(
              "rounded-ios-sm flex flex-wrap items-center justify-between gap-2 border px-3 py-2",
              tone === "blocking"
                ? "border-destructive/30 bg-destructive/10"
                : "border-amber-500/40 bg-amber-500/10",
            )}
          >
            <span className="flex min-w-0 flex-1 items-start gap-2 text-footnote text-foreground [overflow-wrap:anywhere]">
              <AlertTriangle
                aria-hidden="true"
                className={cn("mt-0.5 size-4 shrink-0", tone === "blocking" ? "text-destructive-text" : "text-foreground")}
              />
              <span className={tone === "blocking" ? "text-destructive-text" : undefined}>{item.text}</span>
            </span>
            {item.onFix ? (
              <Button
                variant="secondary"
                size="sm"
                className="pointer-coarse:h-11 pointer-coarse:before:hidden"
                onClick={item.onFix}
              >
                {fixLabel}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Counter({ label, complete }: { label: string; complete: boolean }) {
  return (
    <li
      className={cn(
        "rounded-ios-sm inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-footnote font-medium",
        complete ? "border-signal/40 bg-signal/10 text-foreground" : "border-white/14 bg-white/5 text-foreground",
      )}
    >
      {complete ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <Circle aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span>{label}</span>
    </li>
  );
}

function ReviewDocSection({
  review,
  name,
  pageCount,
  thumbs,
  strings,
  onGoToPage,
}: {
  review: ReviewDoc;
  name: string;
  pageCount: number | undefined;
  thumbs: Record<string, string | undefined>;
  strings: SignStrings;
  onGoToPage?: (docId: DocId, pageIndex: number) => void;
}) {
  const text = strings.review;
  const counters: { key: string; label: string; complete: boolean }[] = [];
  if (review.initials.expected > 0) {
    counters.push({
      key: "initials",
      label: text.counterInitials(review.initials.done, review.initials.expected),
      complete: review.initials.done >= review.initials.expected,
    });
  }
  if (review.signatures.total > 0) {
    counters.push({
      key: "signatures",
      label: text.counterSignatures(review.signatures.done, review.signatures.total),
      complete: review.signatures.done >= review.signatures.total,
    });
  }
  if (review.text.total > 0) {
    counters.push({
      key: "text",
      label: text.counterText(review.text.done, review.text.total),
      complete: review.text.done >= review.text.total,
    });
  }

  return (
    <>
      <h5 className="text-callout font-semibold text-foreground [overflow-wrap:anywhere]">
        {pageCount !== undefined ? text.docHeading(name, review.pages.length, pageCount) : name}
      </h5>
      {counters.length > 0 ? (
        <ul aria-label={text.statusTitle} className="flex flex-wrap gap-2">
          {counters.map((counter) => (
            <Counter key={counter.key} label={counter.label} complete={counter.complete} />
          ))}
        </ul>
      ) : null}
      {review.pages.length === 0 ? (
        <p className="text-footnote text-muted-foreground">{text.noMarks}</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-3">
          {review.pages.map((page) => (
            <li key={page.pageIndex} className="min-w-0">
              <PageTile
                docId={review.docId}
                docName={name}
                page={page}
                src={thumbs[thumbKey(review.docId, page.pageIndex)]}
                strings={strings}
                onGoToPage={onGoToPage}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PageTile({
  docId,
  docName,
  page,
  src,
  strings,
  onGoToPage,
}: {
  docId: DocId;
  docName: string;
  page: ReviewPageMarks;
  src: string | undefined;
  strings: SignStrings;
  onGoToPage?: (docId: DocId, pageIndex: number) => void;
}) {
  const text = strings.review;
  const kinds = pageKinds(page, strings);
  const complete = page.marks.every((mark) => mark.done);
  const label = `${text.thumbGo(docName, page.pageIndex + 1)}. ${text.thumbLabel(docName, page.pageIndex + 1, kinds)}`;
  const body = (
    <>
      <span className="relative block aspect-[3/4] w-full overflow-hidden rounded-[0.5rem] border border-white/14 bg-white">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="absolute inset-0 size-full object-contain" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center bg-white/5 px-1 text-center text-caption text-muted-foreground">
            {text.loadingThumb}
          </span>
        )}
        {page.marks.map((mark) => (
          <span
            key={mark.id}
            aria-hidden="true"
            data-mark={mark.kind}
            data-done={mark.done ? "" : undefined}
            className={cn(
              "absolute rounded-[2px] border-2",
              mark.done ? "border-solid" : "border-dashed",
              mark.kind === "text" ? "border-neutral-700 bg-neutral-700/15" : "bg-signal/15",
            )}
            style={{
              left: `${mark.rect.x * 100}%`,
              top: `${mark.rect.y * 100}%`,
              width: `${mark.rect.width * 100}%`,
              height: `${mark.rect.height * 100}%`,
              ...(mark.kind === "text" ? {} : { borderColor: "var(--color-signal)" }),
            }}
          />
        ))}
      </span>
      <span className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-foreground">
        {complete ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <Circle aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span className="font-semibold tabular-nums">{text.pageNumber(page.pageIndex + 1)}</span>
        <span className="text-muted-foreground [overflow-wrap:anywhere]">{kinds.join(" · ")}</span>
      </span>
    </>
  );

  return onGoToPage ? (
    <button
      type="button"
      aria-label={label}
      data-review-page={`${docId}:${page.pageIndex}`}
      onClick={() => onGoToPage(docId, page.pageIndex)}
      className="rounded-ios-sm block w-full min-w-0 p-1 text-left transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] hover:bg-white/8 active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
    >
      {body}
    </button>
  ) : (
    <div role="group" aria-label={text.thumbLabel(docName, page.pageIndex + 1, kinds)} className="block w-full min-w-0 p-1">
      {body}
    </div>
  );
}
