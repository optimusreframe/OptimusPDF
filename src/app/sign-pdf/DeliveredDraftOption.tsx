"use client";

import { useEffect, useState, type MutableRefObject } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { deleteDeliveredDraft, type DeliveredDraft } from "@/app/sign-pdf/deliveredDraft";
import type { DraftPrivacyStrings } from "@/app/sign-pdf/strings";

/**
 * Cuanto se espera, tras pulsar «Descargar», para borrar de verdad el borrador (F0-fix, D5).
 *
 * LIMITE QUE NO SE PUEDE SALVAR: la pagina no puede saber si el archivo LLEGO. `downloadBlob` dispara un `<a download>` y
 * ningun navegador avisa de que la descarga termino; en Safari de iPad, ademas, puede quedarse en una hoja de «Descargas»
 * que la persona ignora o fallar sin decir nada. Borrar el borrador en el mismo instante del clic dejaria sin nada a quien
 * no recibio el archivo. Por eso el borrado se RETRASA unos segundos y, mientras tanto, hay un «Deshacer» de 44 px: si la
 * descarga no llega, se toca y el borrador se conserva. Si la persona se va de la pagina antes de que pase el plazo, no se
 * borra nada (el temporizador muere con la pagina): ante la duda el borrador se queda y caduca solo a los 7 dias.
 */
export const DELIVERED_DELETE_DELAY_MS = 8000;

let deleteDelayMs = DELIVERED_DELETE_DELAY_MS;

/** Solo para tests: acorta el plazo del borrado (`null` lo devuelve a `DELIVERED_DELETE_DELAY_MS`). */
export function __setDeliveredDeleteDelayForTests(ms: number | null): void {
  deleteDelayMs = ms ?? DELIVERED_DELETE_DELAY_MS;
}

export type DeliveredDraftOptionProps = {
  /**
   * Resuelve el borrador de la ronda entregada (`deliveredDraftOf`). Se llama UNA vez, al aparecer la pantalla de resultado;
   * sin borrador (`null`) no se pinta nada: no hay nada que borrar.
   */
  resolveDraft: () => DeliveredDraft | null;
  strings: DraftPrivacyStrings;
  /** Con las firmas guardadas en el borrador la etiqueta lo dice y explica que pasa si no se marca. */
  withSignatures: boolean;
  /**
   * Aqui deja registrado lo que hay que hacer al pulsar «Descargar» (`ToolShell.onDownloaded`): borrar el borrador si la
   * casilla esta marcada. Se retira al desmontar.
   */
  downloadedRef: MutableRefObject<(() => void) | null>;
};

/**
 * `kept` = «Deshacer»; `unchecked` = la casilla se desmarco con la descarga ya hecha (F0-fix2, N1): en ambos el borrador se
 * conserva y la espera esta cancelada, pero lo que se anuncia es distinto.
 */
type Status = "idle" | "pending" | "deleted" | "failed" | "kept" | "unchecked";

/**
 * La casilla de la pantalla de resultado de Firmar (Fase 0 «Firma agil», U0.4): «Borrar el borrador de esta firma
 * (incluye las firmas guardadas en el)», MARCADA por defecto. Si sigue marcada al descargar, el borrador de la ronda
 * entregada se borra (sesion o documento) y se anuncia; desmarcada, se conserva (con la caducidad de 7 dias si lleva firmas).
 *
 * No borra al aparecer la pantalla ni al irse sin descargar: solo cuando la persona descarga de verdad, y NO en el acto sino
 * tras `DELIVERED_DELETE_DELAY_MS`, con «Deshacer» mientras tanto (ver esa constante: la llegada del archivo no se puede
 * confirmar, sobre todo en Safari de iPad).
 *
 * LA CASILLA ES LA VERDAD (F0-fix2, N1): desmarcarla durante la espera cancela el borrado en el acto (y se anuncia que el
 * borrador se conserva), igual que «Deshacer»; volver a marcarla empieza la espera de nuevo. Antes solo «Deshacer» cancelaba y
 * el borrador se borraba con la casilla desmarcada a la vista.
 */
export function DeliveredDraftOption({ resolveDraft, strings, withSignatures, downloadedRef }: DeliveredDraftOptionProps) {
  const [draft] = useState(resolveDraft);
  const [checked, setChecked] = useState(true);
  const [status, setStatus] = useState<Status>("idle");

  const onToggle = (next: boolean) => {
    setChecked(next);
    // Con la descarga ya hecha, la casilla decide: desmarcada = se conserva (cancela la espera), marcada = vuelve a esperar.
    if (!next && (status === "pending" || status === "failed")) setStatus("unchecked");
    else if (next && (status === "kept" || status === "unchecked")) setStatus("pending");
  };

  useEffect(() => {
    if (!draft || status === "deleted") return;
    downloadedRef.current = () => {
      // Una descarga mas mientras ya hay un borrado en marcha no lo reinicia.
      if (!checked || status === "pending") return;
      setStatus("pending");
    };
    return () => {
      downloadedRef.current = null;
    };
  }, [draft, checked, status, downloadedRef]);

  // El borrado en si: pasado el plazo, salvo que se haya tocado «Deshacer» o la persona se haya ido (desmontar lo cancela).
  useEffect(() => {
    if (status !== "pending" || !draft) return;
    const timer = setTimeout(() => {
      void deleteDeliveredDraft(draft).then((ok) => setStatus(ok ? "deleted" : "failed"));
    }, deleteDelayMs);
    return () => clearTimeout(timer);
  }, [status, draft]);

  if (!draft) return null;
  const message =
    status === "pending"
      ? strings.deleteSoon
      : status === "deleted"
        ? strings.deleteDone
        : status === "failed"
          ? strings.deleteFailed
          : status === "kept"
            ? strings.deleteUndone
            : status === "unchecked"
              ? withSignatures
                ? strings.deleteKeptExpires
                : strings.deleteKept
              : "";
  return (
    <div data-delete-draft="" className="w-full">
      {status === "deleted" ? null : (
        <Checkbox
          label={withSignatures ? strings.deleteLabelWithSignatures : strings.deleteLabel}
          hint={withSignatures ? strings.deleteHintKept : undefined}
          checked={checked}
          onChange={onToggle}
        />
      )}
      {/* Region viva siempre montada: solo cambia su contenido. */}
      <div className={status === "idle" ? "sr-only" : "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"}>
        <p
          role="status"
          aria-live="polite"
          data-delete-draft-status=""
          className={status === "idle" ? undefined : "text-footnote text-muted-foreground"}
        >
          {message}
        </p>
        {status === "pending" ? (
          <Button
            variant="secondary"
            size="md"
            data-delete-draft-undo=""
            onClick={() => {
              // «Deshacer»: el borrador se queda y una descarga posterior ya no lo borra (la casilla se desmarca).
              setChecked(false);
              setStatus("kept");
            }}
          >
            {strings.deleteUndo}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
