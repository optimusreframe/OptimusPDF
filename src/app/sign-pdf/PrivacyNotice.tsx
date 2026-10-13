"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { clearValueHistory } from "@/lib/valueHistory";
import {
  clearLocalSignData,
  type ClearFailure,
} from "@/app/sign-pdf/clearLocalSignData";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
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
 * completo se abre solo, sin preguntar, la primera vez que se ve un documento; a partir de ahí queda colapsado mientras siga
 * alcanzable con el icono "i". El botón de borrado vive siempre en la
 * misma fila, no solo dentro del aviso: la idea explícita del producto es
 * que "Borrar datos" nunca dependa de haber abierto el aviso primero.
 */
export function PrivacyNotice({ strings }: PrivacyNoticeProps) {
  const [open, setOpen] = useState(() => !hasSeenNotice());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  const [cleared, setCleared] = useState(false);
  /** Almacenes que no se pudieron vaciar en el ultimo intento (vacio = bien). */
  const [failed, setFailed] = useState<ClearFailure[]>([]);

  const statusText =
    failed.length > 0 ? strings.vaultClearFailed(failed) : cleared ? strings.privacyDataCleared : "";

  const dismiss = () => {
    setOpen(false);
    markNoticeSeen();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          // Zona de toque de 44 px de alto bajo puntero grueso, sin cambiar el aspecto de escritorio.
          className="relative flex items-center gap-1.5 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:min-h-11 pointer-coarse:-my-[13px] pointer-coarse:px-2 pointer-coarse:-mx-2"
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

      {open ? (
        <div className="surface-card rounded-ios flex items-start gap-3 p-4">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
            {strings.privacyNoticeBody}
            {vaultEnabled ? ` ${strings.privacyNoticeVaultNote}` : ""}
          </p>
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
