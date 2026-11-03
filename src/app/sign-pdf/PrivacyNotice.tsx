"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { clearValueHistory } from "@/lib/valueHistory";
import {
  clearLocalSignData,
  type ClearFailure,
} from "@/app/sign-pdf/clearLocalSignData";
import { StripSavedSignatures } from "@/app/sign-pdf/StripSavedSignatures";
import { RememberedDataButton } from "@/app/sign-pdf/RememberedData";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";
import { setSignPdfFeatureFlag, useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { clearAllTemplates } from "@/app/sign-pdf/signTemplates";
import type { SignStrings } from "@/app/sign-pdf/strings";

const PRIVACY_NOTICE_SEEN_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

function hasSeenNotice(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_NOTICE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markNoticeSeen(): void {
  try {
    window.localStorage.setItem(PRIVACY_NOTICE_SEEN_KEY, "1");
  } catch {
    // Sin localStorage disponible no hay nada que marcar; el aviso
    // simplemente reaparecera la proxima vez, sin romper nada.
  }
}

export type PrivacyNoticeProps = {
  strings: SignStrings;
};

/**
 * Aviso de privacidad + botón "Borrar datos" del modo "varios firmantes"
 * -- el único que toca `src/lib/valueHistory.ts`, `signDrafts.ts` y el baúl
 * de firmas (`signVault.ts`). El modo "solo yo" no tiene este aviso: su hoja
 * de firmas guardadas lleva sus propios «Borrar» (una o todas). El texto
 * completo YA NO se abre solo (era un muro de ~1 000 px la primera vez, ER-03 de la auditoria movil/iPad): la primera vez se ve
 * un RESUMEN de una frase con «Leer completo» y «Entendido»; cualquiera de los dos (o cerrar el texto) recuerda que ya se vio
 * y a partir de ahí queda colapsado mientras siga alcanzable con el icono "i". El botón de borrado vive siempre en la
 * misma fila, no solo dentro del aviso: la idea explícita del producto es
 * que "Borrar datos" nunca dependa de haber abierto el aviso primero.
 *
 * Firmas en el borrador (Fase 0 «Firma agil», U0.4): el aviso abierto trae el interruptor «Guardar tambien las firmas
 * recogidas para no perderlas» (encendido por defecto; el mismo ajuste que Ajustes) y el texto dice, segun su estado, si las
 * firmas ya recogidas viajan en el borrador (solo en este dispositivo, 7 dias) o se piden de nuevo al retomarlo. Debajo, el boton
 * «Quitar ahora las firmas de los borradores guardados» (F0-fix2, N2): apagar el interruptor no purga lo ya guardado.
 */
export function PrivacyNotice({ strings }: PrivacyNoticeProps) {
  /** Texto completo abierto. */
  const [open, setOpen] = useState(false);
  /** Primera vez: el resumen corto con «Leer completo» y «Entendido». */
  const [summary, setSummary] = useState(() => !hasSeenNotice());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  const signaturesInDraft = useSignPdfFeatureFlag("signaturesInDraft");
  const privacy = strings.draftPrivacy;
  const tagStrings = useTagStrings();
  const [cleared, setCleared] = useState(false);
  /** Almacenes que no se pudieron vaciar en el ultimo intento (vacio = bien). */
  const [failed, setFailed] = useState<ClearFailure[]>([]);

  const statusText =
    failed.length > 0 ? strings.vaultClearFailed(failed) : cleared ? strings.privacyDataCleared : "";

  const dismiss = () => {
    setOpen(false);
    markNoticeSeen();
  };

  const toggleFull = () => {
    setSummary(false);
    if (open) markNoticeSeen();
    setOpen(!open);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={toggleFull}
          aria-expanded={open}
          // Zona de toque de 44 px de alto bajo puntero grueso, sin cambiar el aspecto de escritorio. Con raton, 24 px
          // reales de alto (WCAG 2.5.8): la linea de texto sola mide ~19,5 px y, segun la tipografia del sistema (p. ej.
          // DejaVu en Linux), axe ya no la salva por espaciado con el boton vecino.
          className="relative flex min-h-6 items-center gap-1.5 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:min-h-11 pointer-coarse:-my-[13px] pointer-coarse:px-2 pointer-coarse:-mx-2"
        >
          <Info aria-hidden="true" className="size-3.5" />
          {strings.privacyNoticeToggle}
        </button>
        <Button
          variant="ghost"
          size="sm"
          // 44 px reales con puntero grueso (el `sm` mide 36 px).
          className="pointer-coarse:h-11 pointer-coarse:before:hidden"
          onClick={() => setConfirmClearOpen(true)}
        >
          {strings.privacyClearData}
        </Button>
        {/* Datos recordados: ver, corregir y borrar lo que la memoria guarda por etiqueta. */}
        <RememberedDataButton className="pointer-coarse:h-11 pointer-coarse:before:hidden" />
        {/* Region de estado siempre montada: solo cambia su contenido. */}
        <StatusRegion
          as="span"
          text={statusText}
          className={
            failed.length > 0
              ? "text-xs text-destructive-text"
              : "text-xs text-success-text"
          }
        >
          {statusText}
        </StatusRegion>
      </div>

      {summary && !open ? (
        <div data-privacy-summary="" className="surface-card rounded-ios flex flex-col gap-3 p-4">
          <p className="flex items-start gap-3 text-footnote leading-relaxed text-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">{strings.privacySummary}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setSummary(false);
                setOpen(true);
              }}
            >
              {strings.privacyReadFull}
            </Button>
            <Button
              size="md"
              onClick={() => {
                setSummary(false);
                markNoticeSeen();
              }}
            >
              {strings.privacyUnderstood}
            </Button>
          </div>
        </div>
      ) : null}

      {open ? (
        <div className="surface-card rounded-ios flex items-start gap-3 p-4">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <Checkbox
              label={privacy.signaturesLabel}
              hint={privacy.signaturesHint}
              checked={signaturesInDraft}
              onChange={(enabled) => setSignPdfFeatureFlag("signaturesInDraft", enabled)}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.privacyNoticeBody}{" "}
              {signaturesInDraft ? privacy.noticeSignaturesOn : privacy.noticeSignaturesOff}
              {vaultEnabled ? ` ${strings.privacyNoticeVaultNote}` : ""}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">{tagStrings.privacyMemoryNote}</p>
            {/* F0-fix2 (N2): apagar el interruptor no toca lo ya guardado; este boton lo quita ya. */}
            <StripSavedSignatures strings={strings} />
          </div>
          <button
            type="button"
            aria-label={strings.confirmClose}
            onClick={dismiss}
            // 16 px visibles; zona de toque de 44x44 px bajo puntero grueso (caja fija de 16 px, el `::before` aporta el resto).
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:size-11 pointer-coarse:-m-3.5"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmClearOpen}
        onClose={() => setConfirmClearOpen(false)}
        onConfirm={() => {
          // Borrar borradores y baul es asincrono (IndexedDB): no se afirma
          // "Datos borrados" hasta que terminaron BIEN. Si alguno falla (p. ej.
          // el baul esta bloqueado por otra pestaña) se dice cual, no se
          // muestra el exito y el boton sigue sirviendo para reintentar.
          void (async () => {
            clearValueHistory();
            clearAllTemplates();
            setCleared(false);
            setFailed([]);
            const failures = await clearLocalSignData();
            setFailed(failures);
            setCleared(failures.length === 0);
          })();
        }}
        title={strings.privacyClearDataTitle}
        body={strings.privacyClearDataBody}
        confirmLabel={strings.privacyClearData}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </div>
  );
}
