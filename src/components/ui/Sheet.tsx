"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useIsClient } from "@/hooks/useIsClient";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  closeLabel: string;
  children: ReactNode;
  className?: string;
  /**
   * En un telefono en apaisado el ancho ya supera el punto de corte `md` y
   * el panel se confundiria con un escritorio (tarjeta centrada y
   * estrecha). Con esto activado, el panel pasa a pantalla completa en
   * touch —cualquier orientacion, hasta tablet— en vez de esa tarjeta: lo
   * usa el contenido que necesita el hueco real entero, como el lienzo de
   * firma.
   */
  mobileFullscreen?: boolean;
};

/**
 * Puntero grueso (dedo, no raton/trackpad) y ancho de escritorio-pequeño
 * hacia abajo: cubre telefono en cualquier giro y tablet, sin arrastrar a
 * un monitor tactil de escritorio a la pantalla completa.
 */
export const MOBILE_FULLSCREEN_QUERY =
  "(pointer: coarse) and (max-width: 1024px)";

/**
 * Bottom sheet estilo iOS: grabber, muelle de entrada, respeta el
 * safe-area inferior y bloquea el scroll de fondo mientras esta abierto.
 */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel,
  children,
  className,
  mobileFullscreen = false,
}: SheetProps) {
  const isClient = useIsClient();
  const coarseAndNarrow = useMediaQuery(MOBILE_FULLSCREEN_QUERY);
  const fullscreen = mobileFullscreen && coarseAndNarrow;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!isClient || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center">
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-background/70 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative flex w-full flex-col animate-sheet-in",
          fullscreen
            ? "h-full rounded-none border-0 bg-elevated"
            : cn(
                "max-h-[88vh] rounded-t-ios-lg border-t border-white/10 bg-elevated/95 backdrop-blur-2xl",
                "md:max-w-lg md:rounded-ios-lg md:border",
              ),
          className,
        )}
      >
        {fullscreen ? null : (
          <div className="flex shrink-0 flex-col items-center pt-2.5">
            <span
              aria-hidden="true"
              className="h-1 w-10 rounded-full bg-white/25 md:hidden"
            />
          </div>
        )}
        <div
          className="flex shrink-0 items-center justify-between px-5 pb-2"
          style={{
            paddingTop: fullscreen
              ? "calc(0.75rem + env(safe-area-inset-top, 0px))"
              : "0.75rem",
          }}
        >
          {title ? (
            <h2 className="hud-label text-[11px] text-muted-foreground">
              {title}
            </h2>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="flex size-8 items-center justify-center rounded-full bg-white/8 text-muted-foreground transition-colors hover:bg-white/15 hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-5"
          style={{
            paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))",
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
