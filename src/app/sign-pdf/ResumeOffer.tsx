"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { formatSavedAgo, summarizeDraft, type DraftSummary } from "@/app/sign-pdf/draftLookup";
import { deleteDraftEntry, type DraftEntry } from "@/app/sign-pdf/signDrafts";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { useUploadOffer } from "@/app/sign-pdf/useRecoverableDrafts";
import { localeTag, useI18n } from "@/lib/i18n";

/**
 * El borrador en lenguaje llano (Fase 0 «Firma agil», U0.3): documentos, firmantes, «firmas recogidas: Ana ✓, Luis
 * pendiente» y hace cuanto se guardo. Compartido por la tarjeta de entrada y la oferta al subir los mismos PDF.
 */
function DraftFacts({
  summary,
  strings,
  id,
  withSavedAgo = true,
}: {
  summary: DraftSummary;
  strings: SignStrings;
  id: string;
  withSavedAgo?: boolean;
}) {
  const { language } = useI18n();
  const r = strings.resume;
  const nameOf = (signer: { index: number; name: string }) => signer.name || r.signerFallback(signer.index + 1);
  const ago = formatSavedAgo(summary.entry.meta.savedAt, localeTag(language), r.justNow);
  return (
    <div id={id} className="space-y-1 text-subheadline text-muted-foreground">
      <p className="break-words" data-draft-documents="">
        {r.cardDocuments(summary.documents)}
      </p>
      {summary.signers.length > 0 ? <p>{r.cardSigners(summary.signers.map(nameOf))}</p> : null}
      {summary.collection.length > 0 ? (
        summary.signaturesAsked ? (
          // Guardado sin las firmas (U0.4): «Ana pendiente, Luis pendiente» seria verdad pero enganoso; se dice que se piden de nuevo.
          <p data-draft-collected="" data-signatures-asked="">
            {strings.draftPrivacy.cardSignaturesAgain}
          </p>
        ) : (
          <p data-draft-collected="">
            {r.cardCollected(summary.collection.map((signer) => ({ name: nameOf(signer), done: signer.collected })))}
          </p>
        )
      ) : null}
      {withSavedAgo && ago ? <p>{r.cardSavedAgo(ago)}</p> : null}
    </div>
  );
}

export type ResumeCardProps = {
  /** Borradores recuperables, el mas reciente primero (ya filtrados por `recoverableDrafts`). */
  entries: readonly DraftEntry[];
  strings: SignStrings;
  /** «Retomar»: carga el borrador (el mismo camino que «Ver borradores» -> «Reanudar»). */
  onResume: (entry: DraftEntry) => void;
  /** «Ver todos»: abre la hoja de borradores. */
  onViewAll: () => void;
  /** Tras «Descartar» confirmado, para que quien lo monta lo anuncie. */
  onDiscarded: () => void;
};

/**
 * El foco, tras descartar, no puede quedarse en un boton que desaparece: con mas borradores va al «Retomar» de la tarjeta
 * (que se queda y muestra el siguiente); con el ultimo, a la zona de carga (la tarjeta se retira poco despues).
 */
function focusAfterDiscard(card: HTMLElement | null, more: boolean): void {
  const next = more ? card?.querySelector<HTMLElement>("[data-resume-primary]") : null;
  if (next) {
    next.focus({ preventScroll: true });
    return;
  }
  const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*="pdf"]');
  input?.parentElement?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
}

/**
 * «Tienes una firma sin terminar» (Fase 0 «Firma agil», U0.3): al entrar en `/sign-pdf` con borradores guardados, el mas
 * reciente se ofrece de frente, sin tener que buscar «Ver borradores». «Retomar» es el boton primario (44 px);
 * «Descartar» pide confirmacion y borra el borrador; «Ver todos» abre la lista completa. No es una region viva (es contenido
 * de la pagina): lo anuncia el contenido, y el descarte lo anuncia la region unica de quien lo monta.
 */
export function ResumeCard({ entries, strings, onResume, onViewAll, onDiscarded }: ResumeCardProps) {
  const r = strings.resume;
  const titleId = useId();
  const factsId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const [confirming, setConfirming] = useState<DraftEntry | null>(null);
  const first = entries[0];

  if (!first) return null;
  const summary = summarizeDraft(first);
  return (
    <section
      ref={cardRef}
      aria-labelledby={titleId}
      data-resume-card=""
      className="surface-card rounded-ios mb-6 p-4"
    >
      <h2 id={titleId} className="text-headline text-foreground">
        {r.cardTitle}
      </h2>
      <div className="mt-2">
        <DraftFacts summary={summary} strings={strings} id={factsId} />
        {entries.length > 1 ? (
          <p className="mt-1 text-subheadline text-muted-foreground">{r.cardMore(entries.length - 1)}</p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="md" data-resume-primary="" aria-describedby={factsId} onClick={() => onResume(first)}>
          {r.resume}
        </Button>
        <Button variant="secondary" size="md" onClick={() => setConfirming(first)}>
          {r.discard}
        </Button>
        <Button variant="ghost" size="md" onClick={onViewAll}>
          {r.viewAll}
        </Button>
      </div>

      <ConfirmSheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const target = confirming;
          if (!target) return;
          const more = entries.length > 1;
          void deleteDraftEntry(target).then(() => {
            focusAfterDiscard(cardRef.current, more);
            onDiscarded();
          });
        }}
        title={r.discardTitle}
        body={r.discardBody(summary.documents.length)}
        confirmLabel={r.discardConfirm}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
        // El boton que la abrio desaparece al descartar: el foco lo coloca `focusAfterDiscard`.
        restoreFocusOnClose={() => false}
      />
    </section>
  );
}

export type UploadOfferCardProps = {
  entry: DraftEntry;
  strings: SignStrings;
  onResume: (entry: DraftEntry) => void;
  onStartOver: () => void;
  /** Cuantos borradores MAS hay de estos mismos documentos (otros clientes con la misma plantilla): con alguno sale «Ver todos». */
  others?: number;
  onViewAll?: () => void;
};

/**
 * «Retomar lo que tenias» (Fase 0 «Firma agil», U0.3): los PDF recien subidos son EXACTAMENTE los de un borrador guardado
 * (misma huella de contenido). Se ofrece continuar donde se dejo antes de empezar de cero; «Empezar de nuevo» solo retira
 * la oferta (el borrador no se borra). Se muestra mientras el trabajo de pantalla aun no tiene progreso.
 */
export function UploadOfferCard({ entry, strings, onResume, onStartOver, others = 0, onViewAll }: UploadOfferCardProps) {
  const { language } = useI18n();
  const r = strings.resume;
  const titleId = useId();
  const factsId = useId();
  const summary = summarizeDraft(entry);
  const ago = formatSavedAgo(entry.meta.savedAt, localeTag(language), r.justNow);
  return (
    <section aria-labelledby={titleId} data-resume-offer="" className="surface-card rounded-ios mb-6 p-4">
      <h2 id={titleId} className="text-headline text-foreground">
        {r.offerTitle}
      </h2>
      <p className="mt-1 text-subheadline text-muted-foreground">{r.offerBody(ago || r.justNow)}</p>
      <div className="mt-2">
        <DraftFacts summary={summary} strings={strings} id={factsId} withSavedAgo={false} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="md" aria-describedby={factsId} onClick={() => onResume(entry)}>
          {r.resume}
        </Button>
        <Button variant="ghost" size="md" onClick={onStartOver}>
          {r.offerStartOver}
        </Button>
        {others > 0 && onViewAll ? (
          <Button variant="ghost" size="md" onClick={onViewAll}>
            {r.viewAll}
          </Button>
        ) : null}
      </div>
      {others > 0 ? <p className="mt-2 text-subheadline text-muted-foreground">{r.cardMore(others)}</p> : null}
    </section>
  );
}

export type UploadOfferHostProps = {
  /** Los archivos de la ronda. */
  files: readonly File[];
  /** Borradores recuperables (`useRecoverableDrafts`); `null` mientras se leen. */
  entries: readonly DraftEntry[] | null;
  /** `false` cuando ya hay trabajo en pantalla: no se ofrece nada que pudiera pisarlo. */
  enabled: boolean;
  strings: SignStrings;
  onResume: (entry: DraftEntry) => void;
  /** Para anunciar por la region viva unica que aparecio la oferta. */
  onAnnounce: (text: string) => void;
  /** «Ver todos»: abre la lista de borradores (con varios del mismo PDF, la plantilla de otros clientes). */
  onViewAll?: () => void;
};

/** Busca el borrador de los archivos subidos (por huella) y, si lo hay, pinta `UploadOfferCard`. Si no, no pinta nada. */
export function UploadOfferHost({ files, entries, enabled, strings, onResume, onAnnounce, onViewAll }: UploadOfferHostProps) {
  const { entry, others, dismiss } = useUploadOffer(files, entries, enabled);
  const announcedRef = useRef<string | null>(null);
  const key = entry ? `${entry.kind}:${entry.meta.id}` : null;
  const announce = strings.resume.offerAnnounce;

  useEffect(() => {
    if (key === null) {
      announcedRef.current = null;
      return;
    }
    if (announcedRef.current === key) return;
    announcedRef.current = key;
    onAnnounce(announce);
  }, [key, announce, onAnnounce]);

  if (!entry) return null;
  return (
    <UploadOfferCard
      entry={entry}
      strings={strings}
      onResume={onResume}
      onStartOver={dismiss}
      others={others}
      onViewAll={onViewAll}
    />
  );
}
