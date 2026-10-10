"use client";

import type { MouseEvent } from "react";
import { useT } from "@/lib/i18n";

/** Id de la zona principal (`<main>` del layout raiz): destino del enlace. */
export const MAIN_CONTENT_ID = "content";

/**
 * Enlace «Saltar al contenido» (WCAG 2.4.1): es el PRIMER elemento enfocable
 * del documento, queda fuera de pantalla (`sr-only`) y aparece arriba a la
 * izquierda al recibir el foco con el teclado. Lleva a la persona a la zona
 * principal sin recorrer la barra lateral (logotipo, colapsar, buscador,
 * categorias, idioma...) ni la cabecera.
 *
 * El salto mueve el FOCO (no solo el desplazamiento): `<main>` es
 * `tabIndex={-1}`, asi el siguiente Tab cae en el primer control de la
 * herramienta (la zona de carga) y los lectores de pantalla anuncian la
 * region. Sin JavaScript el ancla `#content` hace lo mismo de forma nativa.
 */
export function SkipLink() {
  const t = useT();

  function skip(event: MouseEvent<HTMLAnchorElement>) {
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (!main) return;
    event.preventDefault();
    main.focus();
  }

  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={skip}
      className={[
        // Oculto hasta recibir el foco; `focus-visible` lo trae a pantalla.
        "sr-only focus-visible:not-sr-only",
        "focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-[100]",
        "focus-visible:inline-flex focus-visible:h-11 focus-visible:items-center focus-visible:rounded-ios-sm",
        "focus-visible:bg-signal focus-visible:px-5 focus-visible:text-callout focus-visible:font-semibold focus-visible:text-[var(--color-on-signal)]",
        "focus-visible:shadow-elevation-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
        "forced-colors:focus-visible:border forced-colors:focus-visible:border-[ButtonText]",
      ].join(" ")}
    >
      {t.common.skipToContent}
    </a>
  );
}
