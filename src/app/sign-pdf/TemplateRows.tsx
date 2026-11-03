"use client";

import { useMemo, useRef } from "react";
import { Check, FileText, LayoutTemplate, Minus, TriangleAlert, X } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useDocumentThumbnail, useNearViewport } from "@/app/documents/useDocumentThumbnail";
import { cn } from "@/lib/cn";
import type { Fingerprint } from "@/lib/docLibrary/types";
import type { LibraryTemplateStrings } from "@/app/sign-pdf/libraryTemplateStrings";
import { basisOf, displayLevel, explainMatch, type ExplainPage, type LibraryTemplateRow, type PageVerdict, type RowLevel } from "@/app/sign-pdf/templateCandidates";

/*
 * Piezas de la hoja «Plantillas» para las plantillas de «Mis documentos» (W3-A2): la fila (nombre, origen, resumen, parecido y
 * «Usar esta plantilla»), el despliegue «Por que no coincidio» (tabla por pagina) y la vista previa de la pagina 1 con los campos
 * encima. El estado (qué fila está abierta, qué se está aplicando) vive en `TemplatesSheet`.
 */

const BADGE: Record<ReturnType<typeof displayLevel>, { variant: BadgeVariant; Icon: typeof Check }> = {
  match: { variant: "success", Icon: Check },
  similar: { variant: "signal", Icon: TriangleAlert },
  none: { variant: "neutral", Icon: X },
  unknown: { variant: "neutral", Icon: Minus },
};

/** «Coincide · 100 %» / «Parece · 85 %» / «Distinto · 12 %»: estado = icono + texto (nunca solo color). */
export function LevelBadge({ level, percent, t }: { level: RowLevel; percent: number | null; t: LibraryTemplateStrings }) {
  const { variant, Icon } = BADGE[displayLevel(level)];
  return (
    <Badge variant={variant} data-template-level={displayLevel(level)}>
      <Icon aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.5} />
      {t.levelWithPercent(level, percent)}
    </Badge>
  );
}

/* ------------------------------------------------------------------ *
 * Vista previa de la pagina 1 con los campos
 * ------------------------------------------------------------------ */

const FIELD_STYLE = {
  signature: "border-signal bg-signal/30",
  initials: "border-success bg-success/30",
  // La pagina de la vista previa es siempre blanca (como el papel): los campos de texto van en oscuro sea cual sea el tema.
  text: "border-black/60 bg-black/10",
} as const;

/**
 * Miniatura de la pagina 1 del documento de origen (la misma que dibuja «Mis documentos»: `useDocumentThumbnail`, en segundo plano
 * y solo cuando esta a la vista) con los campos de la plantilla encima. Mientras no llega, o si no se pudo dibujar, queda el
 * contorno de la pagina con los campos: la posicion sigue siendo util.
 */
export function TemplatePreview({ row, t }: { row: LibraryTemplateRow; t: LibraryTemplateStrings }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const url = useDocumentThumbnail(row.document, near);
  const size = row.document?.pageSizes[0];
  const aspect = size && size.width > 0 && size.height > 0 ? size.width / size.height : 612 / 792;
  // La variante mas completa: la de 2 firmantes si tiene firmas, si no la de 1.
  const variant = row.summary.hasTwo ? row.template.variants["2"] : row.template.variants["1"];
  const signs = variant.fields.filter((field) => field.pageIndex === 0);
  const texts = variant.textFields.filter((field) => field.pageIndex === 0);
  const box = (rect: { x: number; y: number; width: number; height: number }) => ({
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${Math.max(rect.width * 100, 2)}%`,
    height: `${Math.max(rect.height * 100, 1.2)}%`,
  });
  return (
    <figure className="m-0 flex flex-col gap-2" data-template-preview="">
      <div
        ref={ref}
        role="img"
        aria-label={t.previewLabel(row.template.name)}
        className="relative w-36 max-w-full shrink-0 overflow-hidden rounded-lg border border-hairline-strong bg-white"
        style={{ aspectRatio: String(aspect) }}
      >
        {url ? (
          // Miniatura local (data URL): no es una imagen remota que `next/image` optimice.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="absolute inset-0 size-full object-fill" />
        ) : (
          <FileText aria-hidden="true" className="absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 text-black/30" />
        )}
        {signs.map((field, index) => (
          <span key={`s${index}`} aria-hidden="true" className={cn("absolute rounded-[2px] border", FIELD_STYLE[field.type])} style={box(field.rect)} />
        ))}
        {texts.map((field, index) => (
          <span key={`t${index}`} aria-hidden="true" className={cn("absolute rounded-[2px] border border-dashed", FIELD_STYLE.text)} style={box(field.rect)} />
        ))}
      </div>
      <figcaption className="text-caption text-muted-foreground">{t.previewLegend}</figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ *
 * Por que no coincidio
 * ------------------------------------------------------------------ */

const VERDICT_ICON: Record<PageVerdict, typeof Check> = {
  identical: Check,
  same: Check,
  contained: TriangleAlert,
  changed: TriangleAlert,
  scan: TriangleAlert,
  notFound: X,
  differentSize: X,
  missing: X,
};

function PageRow({ page, t }: { page: ExplainPage; t: LibraryTemplateStrings }) {
  const Icon = VERDICT_ICON[page.verdict];
  return (
    <tr className="border-t border-white/10 align-top">
      <th scope="row" className="py-2 pr-2 text-left font-normal text-foreground tabular-nums">
        <span className="block font-medium">{t.pageCell(page.templatePage, page.documentPage)}</span>
        <span className="block text-muted-foreground">{page.documentPage === null ? "—" : `${page.percent} %`}</span>
      </th>
      <td className="py-2 text-muted-foreground">
        <span className="flex items-start gap-1.5 text-foreground">
          <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.5} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t.verdict(page.verdict)}</span>
        </span>
        <span className="mt-0.5 block pl-5">
          {t.sameSize(page.sameSize)}
          {page.kind !== "none" ? ` · ${t.kind(page.kind)}` : ""}
        </span>
      </td>
    </tr>
  );
}

export function TemplateDetail({ row, fingerprint, failed, id, t }: { row: LibraryTemplateRow; fingerprint: Fingerprint | null; failed: boolean; id: string; t: LibraryTemplateStrings }) {
  const explanation = useMemo(() => (row.match && fingerprint && row.document ? explainMatch({ match: row.match, document: fingerprint, template: basisOf(row.document) }) : null), [row.match, row.document, fingerprint]);
  const none = { templatePages: 0, documentPages: 0, reviewPages: 0 };
  // Sin comparacion: sin documento de origen, PDF cargado ilegible, o la huella aun se esta calculando.
  const headline = explanation
    ? t.headline(explanation.headline, { templatePages: explanation.templatePages, documentPages: explanation.documentPages, reviewPages: explanation.pages.filter((page) => page.review).length })
    : row.document === null
      ? t.headline("noOrigin", none)
      : failed
        ? t.headline("unreadable", none)
        : t.loading;
  return (
    <div id={id} className="space-y-3 border-t border-white/10 pt-3" data-template-detail="">
      <p className="text-footnote leading-relaxed text-foreground">{headline}</p>
      {explanation ? (
        <>
          <table className="w-full table-fixed border-collapse text-left text-caption">
            <caption className="sr-only">{t.tableCaption(row.template.name)}</caption>
            <colgroup>
              <col className="w-[5.5rem]" />
              <col />
            </colgroup>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="pb-1.5 pr-2 text-left font-medium">
                  {t.colPage}
                </th>
                <th scope="col" className="pb-1.5 text-left font-medium">
                  {t.colDetail}
                </th>
              </tr>
            </thead>
            <tbody>
              {explanation.pages.map((page) => (
                <PageRow key={page.templatePage} page={page} t={t} />
              ))}
            </tbody>
          </table>
          {explanation.extraDocumentPages.length > 0 && explanation.pages.some((page) => page.documentPage !== null) ? (
            <p className="text-caption leading-relaxed text-muted-foreground">{t.extraPages(explanation.extraDocumentPages)}</p>
          ) : null}
        </>
      ) : null}
      {row.document ? <TemplatePreview row={row} t={t} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fila
 * ------------------------------------------------------------------ */

export type LibraryRowProps = {
  row: LibraryTemplateRow;
  t: LibraryTemplateStrings;
  fingerprint: Fingerprint | null;
  fingerprintFailed: boolean;
  /** Fecha ya formateada de la ultima vez que se uso, o `null`. */
  lastUsed: string | null;
  expanded: boolean;
  busy: boolean;
  /** Hay varios documentos en la ronda: se ofrece «Usar en todos los documentos». */
  multi: boolean;
  onToggle: () => void;
  onUse: () => void;
  onUseAll: () => void;
};

export function LibraryRow({ row, t, fingerprint, fingerprintFailed, lastUsed, expanded, busy, multi, onToggle, onUse, onUseAll }: LibraryRowProps) {
  const detailId = `tpl-detail-${row.template.id}`;
  const summary = row.summary;
  return (
    <li>
      <div className="surface-card rounded-ios-sm space-y-3 p-3" data-template-row={row.template.id} data-template-level={displayLevel(row.level)}>
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
            <LayoutTemplate className="size-4 text-signal-text" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-subheadline font-semibold text-foreground [overflow-wrap:anywhere]">{row.template.name}</p>
            <LevelBadge level={row.level} percent={row.percent} t={t} />
            <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
              {row.document ? t.fromDocument(row.document.name) : t.noDocument}
              {row.document ? ` · ${t.pagesOf(row.document.pageCount)}` : ""}
            </p>
            <p className="text-caption text-muted-foreground">
              {t.summary({ signers: summary.mainSigners, both: summary.hasOne && summary.hasTwo, signatures: summary.main.signatures, initials: summary.main.initials, text: summary.main.text })}
            </p>
            {lastUsed ? <p className="text-caption text-muted-foreground">{t.lastUsed(lastUsed)}</p> : null}
            {row.stale ? <p className="text-caption text-muted-foreground">{t.staleNote}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="md" wrap disabled={busy} onClick={onUse} aria-label={t.useButtonFor(row.template.name)}>
            {t.useButton}
          </Button>
          {multi ? (
            <Button variant="secondary" size="md" wrap disabled={busy} onClick={onUseAll}>
              {t.useAll}
            </Button>
          ) : null}
          <Button variant="ghost" size="md" wrap aria-expanded={expanded} aria-controls={detailId} onClick={onToggle}>
            {expanded ? t.detailHide : t.detailShow(row.level)}
          </Button>
        </div>
        {expanded ? <TemplateDetail row={row} fingerprint={fingerprint} failed={fingerprintFailed} id={detailId} t={t} /> : null}
      </div>
    </li>
  );
}
