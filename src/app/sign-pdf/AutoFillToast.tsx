"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { LiveSinkProvider, StatusRegion, useLiveSink } from "@/components/tool/liveRouting";
import { cn } from "@/lib/cn";
import { useFieldEditMode } from "@/app/sign-pdf/editMode/FieldEditModeProvider";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

/** Lo que se avisa: el texto y si se puede deshacer. `id` cambia con cada aviso nuevo (reinicia los 6 s). */
export type AutoFillNotice = { id: number; message: string; undoable: boolean };

/** Tiempo (ms) que el aviso espera antes de irse solo (o hasta que la persona lo cierre). */
export const AUTOFILL_TOAST_MS = 6000;

type Props = {
  notice: AutoFillNotice | null;
  onUndo: () => void;
  onDismiss: () => void;
};

/**
 * Aviso del autorrelleno al estilo iOS: una pastilla flotante, centrada, con «Rellenado en N campos · Deshacer». Se va sola a
 * los 6 s, pero NO mientras la persona la apunta con el raton o tiene el foco dentro (nadie debe perder el «Deshacer» por
 * ir despacio), y tiene su boton de cerrar. El texto se anuncia por la region de estado (siempre montada), asi que un lector
 * de pantalla lo lee sin que la persona tenga que ir a buscarlo.
 *
 * Va fija por encima de las barras de abajo: en el telefono, de la paleta, «Opciones/Procesar» y la barra de pestañas
 * (~12,5 rem); en pantallas mayores, por encima de la barra pegajosa de acciones. Con el modo «Editar campos» a pantalla
 * completa abierto (W3-B1) la pagina esta inerte: el aviso (y su region viva) se pintan DENTRO de ese modo, sobre sus barras.
 */
export function AutoFillToast({ notice, onUndo, onDismiss }: Props) {
  const strings = useTagStrings();
  const editContainer = useFieldEditMode()?.container ?? null;
  /**
   * Dentro de PDF Pro el anuncio va a la region viva unica de la suite: `StatusRegion` deja entonces el contenedor SIN rol, y
   * un `aria-label` en un `div` sin rol esta prohibido (axe `aria-prohibited-attr`). El nombre solo va cuando la region es viva
   * por si misma: fuera de la suite, o en el portal del modo «Editar campos» (que corta el encaminamiento).
   */
  const routed = useLiveSink() !== null && editContainer === null;
  /** Aviso que la persona esta apuntando o tiene enfocado: no se va solo (el estado es del aviso, no se arrastra al siguiente). */
  const [heldId, setHeldId] = useState<number | null>(null);
  const noticeId = notice?.id ?? null;
  const held = heldId !== null && heldId === noticeId;

  useEffect(() => {
    if (noticeId === null || held) return;
    const timer = window.setTimeout(onDismiss, AUTOFILL_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [noticeId, held, onDismiss]);

  const region = (
    <StatusRegion text={notice?.message ?? ""} data-autofill-region="" aria-label={routed ? undefined : strings.autoFillRegion}>
      {notice ? (
        <div
          className={cn(
            "pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4",
            // Con el asistente «Rellenar» abierto (W3-B2) su panel publica su altura en `--fill-dock-h`: el aviso se coloca sobre el.
            editContainer
              ? "bottom-[calc(env(safe-area-inset-bottom,0px)+9.5rem)]"
              : "bottom-[calc(env(safe-area-inset-bottom,0px)+var(--fill-dock-h,6rem))] max-md:bottom-[calc(env(safe-area-inset-bottom,0px)+var(--fill-dock-h,13.5rem))]",
          )}
        >
          <div
            key={notice.id}
            data-autofill-toast=""
            onPointerEnter={() => setHeldId(notice.id)}
            onPointerLeave={() => setHeldId(null)}
            onFocus={() => setHeldId(notice.id)}
            onBlur={() => setHeldId(null)}
            className="material-thick animate-rise-in pointer-events-auto flex max-w-full items-center gap-1 rounded-full py-1 pr-1 pl-4 shadow-elevation-3 ring-1 ring-white/14"
          >
            <span className="min-w-0 py-2 text-footnote font-medium text-foreground">{notice.message}</span>
            {notice.undoable ? (
              <button
                type="button"
                onClick={onUndo}
                className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-footnote font-semibold text-signal-text focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100 hover:bg-white/10 transition-[scale,background-color]"
              >
                {strings.autoFillUndo}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={strings.autoFillDismiss}
              onClick={onDismiss}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100 hover:bg-white/10 hover:text-foreground transition-[scale,background-color]"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </StatusRegion>
  );
  return editContainer ? createPortal(<LiveSinkProvider value={null}>{region}</LiveSinkProvider>, editContainer) : region;
}
