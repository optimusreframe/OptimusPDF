"use client";

import { useCallback, useRef, useState } from "react";

/*
 * Preferencias de distribucion de la suite (Wave 7 · U3): ancho de las miniaturas y del panel contextual y
 * si estan abiertos. Se guardan en localStorage (NO son datos sensibles: solo numeros y dos booleanos), con
 * try/catch por si el almacenamiento esta bloqueado (modo privado) y validacion al leer.
 */

export const PRO_LAYOUT_STORAGE_KEY = "optimuspdf.pro.layout.v1";

export const THUMBS_WIDTH = { min: 144, max: 280, def: 176 } as const;
export const CONTEXT_WIDTH = { min: 280, max: 560, def: 340 } as const;
/** El visor nunca baja de este ancho: antes se estrechan y luego se pliegan los paneles. */
export const MIN_VIEWER_WIDTH = 320;
/**
 * (M2 · GE-02) Con un DEDO (iPad, tabletas Android) el visor no baja de este ancho: en un iPad vertical (834 px) la hoja quedaba en
 * ≈ 330 px entre miniaturas y panel. Con 448 px el panel de herramientas se pliega solo (el boton «Mostrar panel» y las pestañas lo
 * reabren) y la hoja ocupa el resto; con 768 px de pantalla aun cabe el panel de 280 si se pide. Con raton no cambia nada.
 */
export const TOUCH_MIN_VIEWER_WIDTH = 448;
/** Reserva para los tiradores de los dos paneles (px). */
const HANDLES_WIDTH = 12;

export type ProLayoutPrefs = {
  thumbsWidth: number;
  contextWidth: number;
  thumbsOpen: boolean;
  contextOpen: boolean;
};

export const DEFAULT_LAYOUT_PREFS: ProLayoutPrefs = {
  thumbsWidth: THUMBS_WIDTH.def,
  contextWidth: CONTEXT_WIDTH.def,
  thumbsOpen: true,
  contextOpen: true,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampThumbsWidth(value: number): number {
  return Number.isFinite(value) ? Math.round(clamp(value, THUMBS_WIDTH.min, THUMBS_WIDTH.max)) : THUMBS_WIDTH.def;
}

export function clampContextWidth(value: number): number {
  return Number.isFinite(value) ? Math.round(clamp(value, CONTEXT_WIDTH.min, CONTEXT_WIDTH.max)) : CONTEXT_WIDTH.def;
}

/** Valida lo leido del almacenamiento: cualquier dato raro vuelve al valor por defecto. */
export function parseLayoutPrefs(raw: unknown): ProLayoutPrefs {
  if (typeof raw !== "object" || raw === null) return DEFAULT_LAYOUT_PREFS;
  const record = raw as Record<string, unknown>;
  return {
    thumbsWidth: typeof record.thumbsWidth === "number" ? clampThumbsWidth(record.thumbsWidth) : THUMBS_WIDTH.def,
    contextWidth: typeof record.contextWidth === "number" ? clampContextWidth(record.contextWidth) : CONTEXT_WIDTH.def,
    thumbsOpen: typeof record.thumbsOpen === "boolean" ? record.thumbsOpen : true,
    contextOpen: typeof record.contextOpen === "boolean" ? record.contextOpen : true,
  };
}

export function loadLayoutPrefs(): ProLayoutPrefs {
  try {
    const text = window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY);
    if (!text) return DEFAULT_LAYOUT_PREFS;
    return parseLayoutPrefs(JSON.parse(text));
  } catch {
    return DEFAULT_LAYOUT_PREFS;
  }
}

export function saveLayoutPrefs(prefs: ProLayoutPrefs): void {
  try {
    window.localStorage.setItem(PRO_LAYOUT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Sin almacenamiento: la distribucion dura lo que dure la sesion.
  }
}

export type FittedPanels = {
  thumbsWidth: number;
  contextWidth: number;
  /** Se pinta el panel (abierto por el usuario Y con sitio). */
  showThumbs: boolean;
  showContext: boolean;
  /** El usuario lo tenia abierto pero no cabe: se pliega solo (el boton sigue disponible). */
  contextAutoHidden: boolean;
  thumbsAutoHidden: boolean;
};

/**
 * Reparte el ancho disponible: el visor conserva `MIN_VIEWER_WIDTH`. Primero se estrecha el panel contextual
 * hasta su minimo, luego las miniaturas; si aun asi no cabe se pliega el contextual y, por ultimo, las miniaturas.
 */
export function fitPanels(containerWidth: number, prefs: ProLayoutPrefs, minViewerWidth: number = MIN_VIEWER_WIDTH): FittedPanels {
  let thumbs = prefs.thumbsOpen ? prefs.thumbsWidth : 0;
  let context = prefs.contextOpen ? prefs.contextWidth : 0;
  const handles = (prefs.thumbsOpen ? HANDLES_WIDTH / 2 : 0) + (prefs.contextOpen ? HANDLES_WIDTH / 2 : 0);
  const budget = Math.max(0, containerWidth - minViewerWidth - handles);
  let contextAutoHidden = false;
  let thumbsAutoHidden = false;
  if (containerWidth > 0) {
    if (thumbs + context > budget && context > 0) context = Math.max(CONTEXT_WIDTH.min, budget - thumbs);
    if (thumbs + context > budget && thumbs > 0) thumbs = Math.max(THUMBS_WIDTH.min, budget - context);
    if (thumbs + context > budget && context > 0) {
      context = 0;
      contextAutoHidden = true;
    }
    if (thumbs + context > budget && thumbs > 0) {
      thumbs = 0;
      thumbsAutoHidden = true;
    }
  }
  return {
    thumbsWidth: thumbs,
    contextWidth: context,
    showThumbs: thumbs > 0,
    showContext: context > 0,
    contextAutoHidden,
    thumbsAutoHidden,
  };
}

export type UseProLayout = {
  prefs: ProLayoutPrefs;
  update: (patch: Partial<ProLayoutPrefs>, persist?: boolean) => void;
  /** Guarda lo que haya (al soltar un tirador). */
  commit: () => void;
  reset: () => void;
};

export function useProLayout(): UseProLayout {
  const [prefs, setPrefs] = useState<ProLayoutPrefs>(() =>
    typeof window === "undefined" ? DEFAULT_LAYOUT_PREFS : loadLayoutPrefs(),
  );
  const prefsRef = useRef(prefs);
  const update = useCallback((patch: Partial<ProLayoutPrefs>, persist = true) => {
    const next = parseLayoutPrefs({ ...prefsRef.current, ...patch });
    prefsRef.current = next;
    setPrefs(next);
    if (persist) saveLayoutPrefs(next);
  }, []);
  const commit = useCallback(() => saveLayoutPrefs(prefsRef.current), []);
  const reset = useCallback(() => {
    prefsRef.current = DEFAULT_LAYOUT_PREFS;
    saveLayoutPrefs(DEFAULT_LAYOUT_PREFS);
    setPrefs(DEFAULT_LAYOUT_PREFS);
  }, []);
  return { prefs, update, commit, reset };
}
