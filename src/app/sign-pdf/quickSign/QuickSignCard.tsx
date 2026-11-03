"use client";

import { useMemo } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { vaultImageToDataUrl, type VaultEntry } from "@/app/sign-pdf/signVault";
import { useQuickSignStrings } from "@/app/sign-pdf/fillMode/fillStrings";
import { captureTypeLabel } from "@/app/sign-pdf/blockModel";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { QuickProposal, SlotCounts } from "@/app/sign-pdf/quickSign/quickSignModel";

/*
 * «Firmar todo con mi firma guardada» (W3-B2): la tarjeta del turno con la vista previa de la firma y las iniciales que se van a
 * usar, lo que se va a firmar (huecos) y el boton grande de un toque. Y, sobre ella, el resumen editable del turno
 * «Firmas: 5 · Iniciales: 12 · Campos: 8», que dice POR QUE el turno es corto sin esconder nada y lleva a corregirlo.
 */

/** «Firmas: 5 · Iniciales: 12 · Campos: 8» con su boton «Editar» (vuelve al documento). */
export function CeremonySummary({
  counts,
  fields,
  onEdit,
  className,
}: {
  counts: SlotCounts;
  fields: number;
  onEdit?: () => void;
  className?: string;
}) {
  const strings = useQuickSignStrings();
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)} data-ceremony-summary="">
      <p className="min-w-0 text-footnote font-semibold text-foreground tabular-nums [overflow-wrap:anywhere]">
        {strings.summary(counts.signatures, counts.initials, fields)}
      </p>
      {onEdit ? (
        <Button
          variant="ghost"
          size="sm"
          className="pointer-coarse:h-11 pointer-coarse:before:hidden"
          aria-label={`${strings.summaryEdit}. ${strings.summaryEditHint}`}
          onClick={onEdit}
          data-ceremony-summary-edit=""
        >
          {strings.summaryEdit}
        </Button>
      ) : null}
    </div>
  );
}

export type QuickSignCardProps = {
  proposal: QuickProposal;
  /** Nombre del firmante del turno, ya con su respaldo numerado. */
  signerName: string;
  counts: SlotCounts;
  onApply: (entry: VaultEntry) => void;
  /** Abre las firmas guardadas para elegir otra (ausente = no hay otra que ofrecer). */
  onChooseOther?: () => void;
  signStrings: SignStrings;
  disabled?: boolean;
};

export function QuickSignCard({ proposal, signerName, counts, onApply, onChooseOther, signStrings, disabled = false }: QuickSignCardProps) {
  const strings = useQuickSignStrings();
  const { entry } = proposal;
  const images = useMemo(
    () => ({
      signature: entry.signature ? vaultImageToDataUrl(entry.signature) : null,
      initials: entry.initials ? vaultImageToDataUrl(entry.initials) : null,
    }),
    [entry],
  );
  const who = entry.signerName || signerName;
  const will = strings.willPlace(counts.signatures > 0 && entry.signature ? counts.signatures : 0, counts.initials > 0 && entry.initials ? counts.initials : 0);
  return (
    <section aria-label={strings.buttonShort} className="space-y-3 rounded-ios border border-signal/40 bg-signal/10 p-3.5" data-quick-sign="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 items-center gap-2">
          {images.signature ? (
            <span className="flex h-11 w-24 items-center justify-center rounded-ios-sm bg-white p-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={images.signature} alt={strings.previewSignature} className="max-h-full max-w-full object-contain" />
            </span>
          ) : null}
          {images.initials ? (
            <span className="flex h-11 w-14 items-center justify-center rounded-ios-sm bg-white p-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={images.initials} alt={strings.previewInitials} className="max-h-full max-w-full object-contain" />
            </span>
          ) : null}
        </div>
        <p className="min-w-0 flex-1 basis-32 truncate text-subheadline font-semibold text-foreground">{who}</p>
      </div>
      {will ? <p className="text-footnote leading-relaxed text-muted-foreground">{will}</p> : null}
      {proposal.missing.length > 0 ? (
        <p className="text-footnote font-medium text-foreground" data-quick-missing="">
          {strings.onlyMissing(proposal.missing.map((type) => captureTypeLabel(type, signStrings)))}
        </p>
      ) : null}
      <div className="flex flex-col items-stretch gap-1">
        {/* El nombre ya esta en la tarjeta: el boton dice solo lo que hace (cabe en una linea hasta en 320 px con letra grande). */}
        <Button size="lg" wrap disabled={disabled} onClick={() => onApply(entry)} data-quick-sign-apply="">
          <PenLine aria-hidden="true" className="size-5 shrink-0" />
          {strings.buttonShort}
        </Button>
        {proposal.alternatives > 0 && onChooseOther ? (
          <Button variant="ghost" size="md" wrap onClick={onChooseOther} data-quick-sign-other="">
            {strings.chooseOther}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
