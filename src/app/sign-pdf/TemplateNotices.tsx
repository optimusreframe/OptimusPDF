"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { hasLoss, undoWork, variantSupport, type PendingField } from "@/app/sign-pdf/templateSession";
import type { SignSession } from "@/app/sign-pdf/signSession";
import type { DocNotice, LibraryOffer, PendingChange, TemplateController } from "@/app/sign-pdf/useTemplateController";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { Signer } from "@/lib/pdf/sign";
import type { DocId } from "@/app/sign-pdf/docSet";
import { useOptionalLanguage } from "@/lib/i18n";
import { libraryTemplateStrings } from "@/app/sign-pdf/libraryTemplateStrings";

/*
 * Los avisos de la aplicacion automatica (Fase 2 · U2.4), encima del flujo de Firmar:
 *   - «Plantilla «X» aplicada · Deshacer» (con el cambio de 1 a 2 firmantes y las paginas a revisar);
 *   - «Parece la plantilla X (85 %) · Usar / No»;
 *   - «Detectamos N campos automaticamente · Revisar / Deshacer» y el panel «Sugerencias (M)»;
 *   - la oferta «¿Guardar como plantilla para la proxima vez?» (en la pantalla final, `SaveTemplateOffer`);
 *   - (W3-A2) «Hay N plantillas en Mis documentos · Elegir» cuando al cargar un PDF no se aplico ninguna, y la lista de paginas que
 *     una plantilla elegida a mano coloco por posicion sin que la comparacion las avale (`FlaggedPanel`).
 * Nada de lo que la persona aporto se pierde en silencio: cambiar el nº de firmantes cuando se quitarian firmas, un nombre
 * escrito o valores pide confirmacion (`ChangeConfirm`), y «Deshacer» solo se ofrece mientras no haya trabajo suyo que
 * pudiera arrastrar (el aviso queda informativo).
 * Una sola region viva (siempre montada) para los anuncios; las tarjetas no son regiones vivas.
 */

export type TemplateNoticesProps = {
  controller: TemplateController;
  strings: SignStrings;
  signers: readonly Signer[];
  /** Sesion vigente: decide si «Deshacer» sigue ofreciendose (sin ella, siempre). */
  session?: Pick<SignSession, "signers" | "blocks" | "docs">;
  /** Con varios documentos cada aviso nombra su documento. */
  multi: boolean;
  onReview: (docId: DocId) => void;
  onGoToPage: (docId: DocId, pageIndex: number) => void;
  onGoSign: (docId: DocId) => void;
  /** Abre la hoja «Plantillas» sobre ese documento. Sin ella no se pintan los avisos «Hay N plantillas…» (no tendrian a donde llevar). */
  onChooseTemplate?: (docId: DocId) => void;
};

function kindLabel(item: PendingField, t: SignStrings["template"]["notices"], signers: readonly Signer[]): string {
  const who = item.kind === "sign" && item.signerIndex !== undefined ? (signers[item.signerIndex]?.name ?? "") : "";
  return item.kind === "sign" ? t.signKind(item.type, who) : t.textKind(item.type, item.label);
}

function reasonLabel(item: PendingField, t: SignStrings["template"]["notices"]): string {
  if (item.origin === "automap") return item.reason;
  return t.reviewReason(item.reason);
}

function PendingPanel({ notice, controller, strings, signers, onGoToPage }: { notice: DocNotice; controller: TemplateController; strings: SignStrings; signers: readonly Signer[]; onGoToPage: (page: number) => void }) {
  const t = strings.template.notices;
  const [open, setOpen] = useState(false);
  if (notice.pending.length === 0) return null;
  const fromTemplate = notice.pending.some((item) => item.origin === "template");
  const reviewPages = notice.record?.reviewPages ?? [];
  const title = fromTemplate ? t.reviewPagesTitle(reviewPages, notice.pending.length) : t.suggestionsTitle(notice.pending.length);
  const listId = `${notice.docId}-pending`;
  return (
    <div className="mt-3 border-t border-white/10 pt-3" data-template-pending="">
      <Button variant="secondary" size="md" wrap aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        {title}
      </Button>
      {open ? (
        <div id={listId} className="mt-3 space-y-2">
          {fromTemplate && reviewPages.length > 0 ? <p className="text-footnote leading-relaxed text-muted-foreground">{t.reviewPagesBody}</p> : null}
          <ul className="space-y-2">
            {notice.pending.map((item) => {
              const label = kindLabel(item, t, signers);
              const page = item.pageIndex === null ? (item.templatePage ?? 0) + 1 : item.pageIndex + 1;
              return (
                <li key={item.key} className="flex flex-col gap-2 rounded-ios-sm border border-white/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 flex-1 text-footnote text-foreground [overflow-wrap:anywhere]">
                    {t.pendingRow(page, label)}
                    <span className="block text-muted-foreground">{reasonLabel(item, t)}</span>
                  </span>
                  {item.pageIndex === null ? (
                    <span className="text-footnote text-muted-foreground">{t.noPageHere}</span>
                  ) : (
                    <span className="flex flex-wrap gap-2">
                      <Button variant="ghost" size="md" onClick={() => onGoToPage(item.pageIndex ?? 0)} aria-label={t.goToPageFor(page, label)}>
                        {t.goToPage(page)}
                      </Button>
                      <Button variant="secondary" size="md" onClick={() => controller.accept(notice.docId, item.key)} aria-label={t.addFor(page, label)}>
                        {t.add}
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {notice.pending.some((item) => item.pageIndex !== null && !(item.kind === "sign" && item.signerIndex === undefined)) ? (
            <Button variant="secondary" size="md" onClick={() => controller.acceptAll(notice.docId)}>
              {t.addAll}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Una plantilla elegida a mano con «todas las paginas, por posicion»: lista las paginas donde quedaron campos que la comparacion no
 * avala, para ir a mirarlas. Siempre visible (no plegado): son campos de firma puestos sin que el PDF los confirme.
 */
function FlaggedPanel({ pages, onGoToPage }: { pages: readonly number[]; onGoToPage: (page: number) => void }) {
  const t = libraryTemplateStrings(useOptionalLanguage());
  if (pages.length === 0) return null;
  return (
    <div className="mt-3 border-t border-white/10 pt-3" data-template-flagged="">
      <p className="flex items-start gap-2 text-footnote leading-relaxed text-foreground">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-signal-text" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="block font-semibold">{t.flaggedTitle(pages)}</span>
          <span className="block text-muted-foreground">{t.flaggedBody}</span>
        </span>
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {pages.map((page) => (
          <li key={page}>
            <Button variant="ghost" size="md" onClick={() => onGoToPage(page)}>
              {t.goToPage(page + 1)}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** El automapeo llego al tope de campos: dice cuantos se colocaron y deja ir a las paginas que quedaron sin iniciales. */
function CapPanel({ notice, strings, onGoToPage }: { notice: DocNotice; strings: SignStrings; onGoToPage: (page: number) => void }) {
  const t = strings.template.notices;
  const [open, setOpen] = useState(false);
  const cap = notice.cap;
  if (!cap) return null;
  const listId = `${notice.docId}-cap`;
  return (
    <div className="mt-3 border-t border-white/10 pt-3" data-template-cap="">
      <p className="text-footnote leading-relaxed text-foreground">{t.capNotice(cap.placed, cap.pages.length)}</p>
      {cap.pages.length > 0 ? (
        <>
          <Button className="mt-2" variant="secondary" size="md" wrap aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
            {t.capPanelTitle(cap.pages.length)}
          </Button>
          {open ? (
            <ul id={listId} className="mt-3 flex flex-wrap gap-2">
              {cap.pages.map((page) => (
                <li key={page}>
                  <Button variant="ghost" size="md" onClick={() => onGoToPage(page)}>
                    {t.goToPage(page + 1)}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function NoticeCard({ notice, controller, strings, signers, session, multi, onReview, onGoToPage, onGoSign }: { notice: DocNotice } & Omit<TemplateNoticesProps, "controller"> & { controller: TemplateController }) {
  const t = strings.template.notices;
  const docName = multi ? notice.name : null;
  if (notice.phase === "automapping") {
    return <AutomapProgress label={docName ? `${docName}: ${t.detecting}` : t.detecting} />;
  }
  if (notice.phase === "asking" && notice.lookup) {
    return (
      <div className="mb-6 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-3" data-template-notice="asking">
        <p className="text-subheadline font-semibold text-foreground [overflow-wrap:anywhere]">{docName ? `${docName}: ` : ""}{t.similarQuestion(notice.lookup.template.name, notice.lookup.percent)}</p>
        <p className="mt-1 text-footnote text-muted-foreground">{t.similarHint}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="md" disabled={notice.busy} onClick={() => controller.acceptSimilar(notice.docId)}>
            {t.use}
          </Button>
          <Button variant="secondary" size="md" disabled={notice.busy} onClick={() => controller.declineSimilar(notice.docId)}>
            {t.no}
          </Button>
        </div>
      </div>
    );
  }
  const record = notice.record;
  if (!record) return null;
  const support = notice.lookup ? variantSupport(notice.lookup.template) : { one: true, two: true };
  const showCount = support.one && support.two;
  const title = record.source === "template" && record.template ? t.appliedTitle(record.template.name) : t.automapTitle(record.placed ?? 0);
  const body =
    record.source === "template"
      ? t.appliedBody(record.count, record.fieldIds.length + record.textFieldIds.length, record.pages)
      : t.automapBody(record.count, record.pages);
  const warnings = record.warnings.map((warning) => warning.code);
  // Con firmas, nombres o valores de la persona ya puestos, «Deshacer» arrastraria su trabajo: no se ofrece.
  const canUndo = !session || !hasLoss(undoWork(session, notice.docId, record));
  return (
    <div className="mb-6 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-3" data-template-notice={notice.phase}>
      <p className="text-subheadline font-semibold text-foreground [overflow-wrap:anywhere]">{docName ? `${docName}: ` : ""}{title}</p>
      <p className="mt-1 text-footnote text-muted-foreground">{body}</p>
      {warnings.includes("missingSecondSigner") ? <p className="mt-1 text-footnote text-muted-foreground">{t.warnMissingSecond}</p> : null}
      {warnings.includes("fallbackFromTwoSigners") ? <p className="mt-1 text-footnote text-muted-foreground">{t.warnFallbackOne}</p> : null}
      {record.keptSigners && record.keptSigners.length > 0 ? <p className="mt-1 text-footnote text-muted-foreground" data-template-kept="">{t.keptSigners(record.keptSigners)}</p> : null}
      {showCount || record.source === "automap" ? (
        <div className="mt-3">
          <SegmentedControl<"1" | "2">
            label={t.signersLabel}
            value={String(notice.count) as "1" | "2"}
            onChange={(value) => controller.setCount(notice.docId, value === "2" ? 2 : 1)}
            options={[
              { value: "1", label: t.signersOne },
              { value: "2", label: t.signersTwo },
            ]}
          />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="md" wrap disabled={notice.busy} onClick={() => onGoSign(notice.docId)}>
          {t.goSign}
        </Button>
        <Button variant="secondary" size="md" wrap disabled={notice.busy} onClick={() => onReview(notice.docId)}>
          {t.review}
        </Button>
        {canUndo ? (
          <Button variant="secondary" size="md" wrap disabled={notice.busy} onClick={() => controller.undo(notice.docId)}>
            {t.undo}
          </Button>
        ) : null}
      </div>
      <FlaggedPanel pages={record.flaggedPages ?? []} onGoToPage={(page) => onGoToPage(notice.docId, page)} />
      <CapPanel notice={notice} strings={strings} onGoToPage={(page) => onGoToPage(notice.docId, page)} />
      <PendingPanel notice={notice} controller={controller} strings={strings} signers={signers} onGoToPage={(page) => onGoToPage(notice.docId, page)} />
    </div>
  );
}

/**
 * «Cambiar a 1 firmante quitara la firma de X. ¿Continuar?»: la hoja de confirmacion (foco atrapado, botones de 44 px) del
 * cambio de firmantes que perderia trabajo de la persona. Cancelar no toca nada.
 */
function ChangeConfirm({ notice, controller, strings }: { notice: DocNotice; controller: TemplateController; strings: SignStrings }) {
  const t = strings.template.notices;
  const pending: PendingChange | null = notice.confirm;
  // La hoja que sale conserva el texto con que se abrio.
  const [shown, setShown] = useState<PendingChange | null>(pending);
  if (pending && pending !== shown) setShown(pending);
  const content = pending ?? shown;
  if (!content) return null;
  const lossText = { signers: content.loss.signers.map((signer) => ({ name: signer.name, strokes: signer.strokes })), values: content.loss.values };
  return (
    <ConfirmSheet
      open={pending !== null}
      onClose={() => controller.cancelChange(notice.docId)}
      onConfirm={() => controller.confirmChange(notice.docId)}
      title={content.replaceDocument ? t.replaceTitle : t.changeTitle(content.count)}
      body={content.replaceDocument ? t.replaceBody(lossText) : t.changeBody(content.count, lossText)}
      confirmLabel={t.changeConfirm}
      cancelLabel={t.changeCancel}
      closeLabel={t.changeClose}
      inertBackground
    />
  );
}

/** «Hay N plantillas en Mis documentos · Elegir»: no bloquea nada ni toca el documento; «Elegir» abre la hoja «Plantillas». */
function LibraryOfferCard({ offer, controller, multi, onChoose }: { offer: LibraryOffer; controller: TemplateController; multi: boolean; onChoose: (docId: DocId) => void }) {
  const t = libraryTemplateStrings(useOptionalLanguage());
  return (
    <div className="mb-6 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-3" data-template-library-offer={offer.docId}>
      <p className="text-subheadline font-semibold text-foreground [overflow-wrap:anywhere]">
        {multi ? `${offer.name}: ` : ""}
        {t.offerTitle(offer.count)}
      </p>
      <p className="mt-1 text-footnote text-muted-foreground">{t.offerBody}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="md" wrap onClick={() => onChoose(offer.docId)}>
          {t.offerChoose}
        </Button>
        <Button variant="secondary" size="md" wrap onClick={() => controller.dismissLibraryOffer?.(offer.docId)}>
          {t.offerDismiss}
        </Button>
      </div>
    </div>
  );
}

/** Cuanto tarda en aparecer «Buscando campos…»: casi todos los PDF se mapean antes y no deben mover nada bajo el dedo. */
export const PROGRESS_DELAY_MS = 800;

/** Progreso discreto: no se pinta hasta pasado el plazo (si el automapeo termina antes, no llega a verse). */
function AutomapProgress({ label }: { label: string }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), PROGRESS_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  return (
    <div className="mb-6 flex items-center gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-3" data-template-notice="automapping">
      <Spinner />
      <p className="min-w-0 text-footnote text-muted-foreground [overflow-wrap:anywhere]">{label}</p>
    </div>
  );
}

export function TemplateNotices({ controller, strings, signers, session, multi, onReview, onGoToPage, onGoSign, onChooseTemplate }: TemplateNoticesProps) {
  const visible = controller.notices.filter((notice) => notice.phase !== "applied" || notice.record !== null || notice.confirm !== null);
  // `contents`: el contenedor no genera caja. Sin avisos NO ocupa nada en el apilado de la herramienta (un contenedor vacio le
  // sumaba su separacion y movia lo de debajo); cada aviso lleva su propio margen y el de progreso ni existe hasta que hace falta.
  return (
    <div data-template-notices="" className="contents">
      <p role="status" aria-live="polite" className="sr-only" data-template-live="">
        {controller.announcement}
      </p>
      {visible.map((notice) => (
        <NoticeCard key={notice.docId} notice={notice} controller={controller} strings={strings} signers={signers} session={session} multi={multi} onReview={onReview} onGoToPage={onGoToPage} onGoSign={onGoSign} />
      ))}
      {visible.map((notice) => (
        <ChangeConfirm key={`${notice.docId}-confirm`} notice={notice} controller={controller} strings={strings} />
      ))}
      {onChooseTemplate
        ? (controller.offers ?? []).map((offer) => <LibraryOfferCard key={`${offer.docId}-library-offer`} offer={offer} controller={controller} multi={multi} onChoose={onChooseTemplate} />)
        : null}
    </div>
  );
}

/** «¿Guardar como plantilla para la proxima vez?», en la pantalla final, para los documentos que se mapearon solos. */
export function SaveTemplateOffer({ controller, strings }: { controller: TemplateController; strings: SignStrings }) {
  const t = strings.template.offer;
  const offers = controller.notices.filter((notice) => notice.offerSave === "available" || notice.offerSave === "saved" || notice.saveResult?.ok === false);
  if (offers.length === 0) return null;
  return (
    <div className="surface-card rounded-ios mt-6 space-y-3 p-5" data-template-offer="">
      {offers.map((notice) => (
        <div key={notice.docId} className="space-y-2">
          {notice.offerSave === "saved" && notice.saveResult?.ok ? (
            <p role="status" className="text-subheadline font-semibold text-foreground">{t.saved(notice.name, notice.saveResult.pages)}</p>
          ) : (
            <>
              <h3 className="text-headline text-foreground [overflow-wrap:anywhere]">{t.title(notice.name)}</h3>
              <p className="text-subheadline text-muted-foreground">{t.body}</p>
              {notice.saveResult?.ok === false ? <p className="text-footnote text-destructive-text">{strings.template.editor.saveFailed(notice.saveResult.reason)}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button size="md" wrap disabled={notice.busy} onClick={() => controller.saveAsTemplate(notice.docId)}>
                  {t.save}
                </Button>
                <Button variant="ghost" size="md" disabled={notice.busy} onClick={() => controller.dismissOffer(notice.docId)}>
                  {t.notNow}
                </Button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
