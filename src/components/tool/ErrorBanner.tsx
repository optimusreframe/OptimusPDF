"use client";

import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { AlertTriangle, Info, X } from "lucide-react";
import { buttonClasses } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { springs, withCrossFadeOpacity } from "@/lib/motion";

/**
 * Banner de error compartido (Wave 6 · U1/U5): el mismo componente en
 * `ToolShell` y en las cuatro herramientas con cabecera propia, para que un
 * archivo malo se explique igual en todas. `role="alert"` (se anuncia al
 * aparecer), mensaje en lenguaje llano, una pista accionable y las salidas
 * como botones de 44 px: «Elegir otro archivo», «Quitar archivo», etc.
 */

export type ErrorBannerAction = {
  /** Identifica la accion para `onAction` (el llamador decide que hace cada una). */
  id?: string;
  label: string;
  /** Acciones que navegan (enlace) o actuan (boton). */
  href?: string;
  onClick?: () => void;
  /** La accion principal se pinta rellena. */
  primary?: boolean;
  /** Para dirigir el foco a esta accion (p. ej. tras detectar el problema). */
  buttonRef?: Ref<HTMLButtonElement>;
};

export type ErrorBannerProps = {
  title: string;
  message: string;
  /** Pista accionable bajo el mensaje («Prueba con Reparar PDF»). */
  hint?: string;
  /** Nombre del archivo afectado, ya con su etiqueta. */
  detail?: string;
  actions?: ErrorBannerAction[];
  /** Se llama al pulsar una accion que no es un enlace (ademas de su `onClick`). */
  onAction?: (action: ErrorBannerAction) => void;
  /** Cierra el aviso; sin esta funcion no se pinta la X. */
  onDismiss?: () => void;
  dismissLabel: string;
  className?: string;
  /** Identificador estable de este error: cambiarlo reanima la entrada. */
  errorKey?: string;
  /**
   * `"warning"`: aviso que no impide seguir (archivo muy grande): region `role="status"`, tono neutro
   * y sin robar el foco como una alerta. Por defecto, `"error"` (`role="alert"`).
   */
  variant?: "error" | "warning";
  /** Para llevar el foco al banner (tiene `tabIndex={-1}`). */
  bannerRef?: Ref<HTMLDivElement>;
  /** Contenido extra bajo el mensaje (p. ej. un detalle tecnico plegable). */
  children?: ReactNode;
};

function ErrorBannerInner({
  title,
  message,
  hint,
  detail,
  actions,
  onAction,
  onDismiss,
  dismissLabel,
  className,
  bannerRef,
  children,
  variant = "error",
}: ErrorBannerProps) {
    const warning = variant === "warning";
    // Mientras sale (animacion de salida) el banner sigue en el DOM: se marca inerte para que
    // nada le deje el foco ni lo elija como destino (el foco pasa a otro control, nunca a <body>).
    const present = useIsPresent();
    return (
      <motion.div
        ref={bannerRef}
        inert={!present}
        role={warning ? "status" : "alert"}
        tabIndex={-1}
        data-error-banner=""
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={withCrossFadeOpacity(springs.snappy)}
        className={cn(
          "mb-6 flex items-start gap-3 rounded-ios border p-4 pr-2 outline-none",
          warning
            ? "border-hairline-strong bg-white/5"
            : "border-destructive/35 bg-destructive/10",
          className,
        )}
      >
        {warning ? (
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        ) : (
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-subheadline font-semibold text-foreground">{title}</p>
          {detail ? (
            <p className="mt-0.5 break-words text-footnote text-muted-foreground">{detail}</p>
          ) : null}
          <p className="mt-1 text-subheadline text-muted-foreground">{message}</p>
          {hint ? <p className="mt-1 text-subheadline text-muted-foreground">{hint}</p> : null}
          {children}
          {actions && actions.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {actions.map((action) => {
                // `wrap`: «Elegir otro archivo» o una accion traducida mas larga parte en lineas en vez de salirse de la pantalla
                // con la letra grande (el boton base no parte el texto).
                const classes = buttonClasses(action.primary ? "primary" : "secondary", "md", undefined, true);
                return action.href ? (
                  <Link key={action.label} href={action.href} className={classes}>
                    {action.label}
                  </Link>
                ) : (
                  <button
                    key={action.label}
                    ref={action.buttonRef}
                    type="button"
                    onClick={() => {
                      action.onClick?.();
                      onAction?.(action);
                    }}
                    className={classes}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            className="group -mt-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
              <X className="size-4" />
            </span>
          </button>
        ) : null}
      </motion.div>
    );
}

/** Banner con entrada/salida animada: se pinta solo mientras `show`. */
export function ErrorBanner({ show, ...props }: ErrorBannerProps & { show: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {show ? <ErrorBannerInner key={props.errorKey ?? "error"} {...props} /> : null}
    </AnimatePresence>
  );
}
