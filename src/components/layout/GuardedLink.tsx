"use client";

import Link from "next/link";
import { forwardRef, useCallback, useRef, type ComponentPropsWithoutRef } from "react";
import { interceptNavigation, runWithoutNavigationGuard } from "@/lib/navigationGuard";

type LinkProps = ComponentPropsWithoutRef<typeof Link>;

/** El destino como texto, para pasarselo a la guarda (la cabecera y el menu solo usan cadenas). */
function hrefText(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  const search = typeof href.search === "string" ? href.search : "";
  const hash = typeof href.hash === "string" ? href.hash : "";
  return `${href.pathname ?? ""}${search}${hash}`;
}

/** El destino es la pagina en la que ya se esta (misma ruta): navegar ahi no abandona nada, asi que no se guarda. */
function isSamePage(target: string): boolean {
  try {
    const url = new URL(target, window.location.href);
    return url.origin === window.location.origin && url.pathname === window.location.pathname;
  } catch {
    return false;
  }
}

/**
 * `next/link` con la guarda de navegacion de `@/lib/navigationGuard` (Fase 0 «Firma agil», U0.3). Usa `onNavigate` de
 * Next 16 -- que solo se ejecuta en una navegacion de cliente al mismo origen, no con Cmd/Ctrl + clic ni con enlaces
 * externos ni con `download` -- y cancela con `preventDefault()` cuando la guarda lo pide.
 *
 * Sin guarda registrada se comporta exactamente como `Link`. Si la guarda pregunta y la persona decide salir, repite el
 * clic sobre el propio enlace saltandose la guarda: la navegacion es la de siempre (misma transicion, mismo scroll).
 */
export const GuardedLink = forwardRef<HTMLAnchorElement, LinkProps>(function GuardedLink(
  { onNavigate, href, ...props },
  forwarded,
) {
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const setRef = useCallback(
    (node: HTMLAnchorElement | null) => {
      anchorRef.current = node;
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );

  return (
    <Link
      {...props}
      href={href}
      ref={setRef}
      onNavigate={(event) => {
        onNavigate?.(event);
        const target = hrefText(href);
        const blocked =
          !isSamePage(target) &&
          interceptNavigation(target, () => {
            runWithoutNavigationGuard(() => anchorRef.current?.click());
          });
        if (blocked) event.preventDefault();
      }}
    />
  );
});
