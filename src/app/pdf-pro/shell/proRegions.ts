"use client";

import { useEffect, type RefObject } from "react";

/*
 * Foco por region (Wave 7 · U3): F6 / Mayus+F6 recorren las regiones de la suite (barra, pestañas,
 * miniaturas, visor, panel) y los enlaces de salto llevan directo a una. Cada region lleva
 * `data-pro-region="..."`; el foco va a su control «de entrada» (la miniatura o la pagina que es parada de
 * tabulador, la pestaña activa...) o, si no hay, a la propia region (`tabindex="-1"`).
 */

export const PRO_REGION_ORDER = ["top", "tabs", "thumbs", "viewer", "context"] as const;
export type ProRegionId = (typeof PRO_REGION_ORDER)[number];

/** Selectores del control «de entrada» de cada region, de mas a menos preferido (se prueba uno tras otro). */
const ENTRY_SELECTORS: Record<ProRegionId, readonly string[]> = {
  top: ["h1"],
  tabs: ['[role="tab"][aria-selected="true"]', '[role="tab"]', "button"],
  thumbs: ['[role="option"][tabindex="0"]'],
  viewer: ['article[tabindex="0"]', "[data-pro-viewer-toolbar] button", "[data-pro-viewer-scroller]"],
  context: [
    'button:not([aria-disabled="true"]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
  ],
};

function isHidden(element: Element): boolean {
  return element.closest("[hidden]") !== null || element.closest('[aria-hidden="true"]') !== null;
}

/** Regiones presentes (y visibles) bajo `root`, en el orden de recorrido. */
export function availableRegions(root: ParentNode): ProRegionId[] {
  return PRO_REGION_ORDER.filter((id) => {
    const region = root.querySelector(`[data-pro-region="${id}"]`);
    return region !== null && !isHidden(region);
  });
}

/** Region que contiene `element`, o `null`. */
export function regionOf(element: Element | null): ProRegionId | null {
  const region = element?.closest<HTMLElement>("[data-pro-region]");
  const id = region?.dataset.proRegion;
  return id && (PRO_REGION_ORDER as readonly string[]).includes(id) ? (id as ProRegionId) : null;
}

/** La region siguiente (o anterior) de `available`, dando la vuelta. */
export function nextRegion(
  current: ProRegionId | null,
  direction: 1 | -1,
  available: readonly ProRegionId[],
): ProRegionId | null {
  if (available.length === 0) return null;
  const at = current ? available.indexOf(current) : -1;
  if (at < 0) return direction > 0 ? available[0] : available[available.length - 1];
  return available[(at + direction + available.length) % available.length];
}

/** Lleva el foco a la region; `false` si no existe. */
export function focusRegion(root: ParentNode, id: ProRegionId): boolean {
  const region = root.querySelector<HTMLElement>(`[data-pro-region="${id}"]`);
  if (!region || isHidden(region)) return false;
  let target: HTMLElement = region;
  for (const selector of ENTRY_SELECTORS[id]) {
    const found = region.matches(selector) ? region : region.querySelector<HTMLElement>(selector);
    if (found) {
      target = found;
      break;
    }
  }
  if (target === region && !region.hasAttribute("tabindex")) region.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return document.activeElement === target || region.contains(document.activeElement);
}

/** F6 / Mayus+F6: siguiente / anterior region. */
export function useRegionShortcuts(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const root = rootRef.current;
      if (!root) return;
      const available = availableRegions(root);
      const target = nextRegion(regionOf(document.activeElement), event.shiftKey ? -1 : 1, available);
      if (!target) return;
      event.preventDefault();
      focusRegion(root, target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rootRef]);
}
