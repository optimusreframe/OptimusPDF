"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ZERO_INSETS,
  fitSheetSize,
  freeBoxOf,
  type FitMode,
  type FreeBox,
  type Insets,
  type Size,
} from "@/app/sign-pdf/editMode/viewMath";
import { readFitPref, writeFitPref } from "@/app/sign-pdf/editMode/editModePrefs";

/*
 * El escenario del modo «Editar campos»: el rectangulo donde vive la hoja fija. Mide su tamano, decide el tamano de la hoja
 * segun el ajuste (pagina entera / ancho) y lleva la CUENTA DE LO QUE LO TAPA: el panel de edicion (inspector, elementos...) y
 * el teclado virtual con su barra de sugerencias. La caja libre que sale de ahi es contra la que se reencuadra la hoja para
 * que lo que se edita no quede debajo de nada.
 */

/** Aire (px) alrededor de la hoja ajustada. */
export const SHEET_MARGIN = 12;
/** Diferencia (px) entre la ventana y la ventana visual a partir de la cual se da por abierto un teclado virtual. */
const KEYBOARD_MIN_PX = 120;

const sameInsets = (a: Insets, b: Insets): boolean =>
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.right - b.right) < 0.5 &&
  Math.abs(a.bottom - b.bottom) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5;

/** Lo que tapan el teclado virtual y su barra de sugerencias sobre el escenario `stage` (px de pantalla). */
export function readObstructionInsets(stage: DOMRect): { insets: Insets; keyboard: boolean } {
  const viewport = window.visualViewport;
  let top = 0;
  let bottom = 0;
  let keyboard = false;
  if (viewport) {
    keyboard = window.innerHeight - viewport.height - viewport.offsetTop > KEYBOARD_MIN_PX;
    // La ventana visual puede estar desplazada (iOS sube la pagina al enfocar un campo) o recortada por el teclado.
    top = Math.max(0, viewport.offsetTop - stage.top);
    bottom = Math.max(0, stage.bottom - (viewport.offsetTop + viewport.height));
  }
  const bar = document.querySelector<HTMLElement>("[data-suggestion-bar]");
  if (bar) {
    const rect = bar.getBoundingClientRect();
    if (rect.height > 0) bottom = Math.max(bottom, stage.bottom - rect.top);
  }
  const limit = stage.height * 0.8;
  return { insets: { top: Math.min(top, limit), right: 0, bottom: Math.min(bottom, limit), left: 0 }, keyboard };
}

export type EditStage = {
  stageSize: Size;
  fitMode: FitMode;
  setFitMode: (mode: FitMode) => void;
  /** Lo que tapan el panel y el teclado, ya combinado. */
  insets: Insets;
  /** El panel de edicion avisa de cuanto tapa del escenario. */
  setChromeInsets: (insets: Insets) => void;
  keyboardOpen: boolean;
  free: FreeBox;
  /** Tamano de la hoja (px de layout, sin zoom), o `null` mientras el escenario no tiene tamano. */
  sheet: Size | null;
};

export function useEditStage({
  enabled,
  clipRef,
  aspect,
  watchKey,
}: {
  enabled: boolean;
  clipRef: RefObject<HTMLElement | null>;
  /** Proporcion ancho/alto de la pagina que se ve. */
  aspect: number;
  /** Cambia cuando puede aparecer o irse la barra de sugerencias (el campo que se edita): se vuelve a medir. */
  watchKey: string | null;
}): EditStage {
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [fitMode, setFitModeState] = useState<FitMode>(readFitPref);
  const [chrome, setChrome] = useState<Insets>(ZERO_INSETS);
  const [obstruction, setObstruction] = useState<{ insets: Insets; keyboard: boolean }>({
    insets: ZERO_INSETS,
    keyboard: false,
  });
  const frameRef = useRef<number | null>(null);

  const setFitMode = useCallback((mode: FitMode) => {
    setFitModeState(mode);
    writeFitPref(mode);
  }, []);

  const setChromeInsets = useCallback((insets: Insets) => {
    setChrome((current) => (sameInsets(current, insets) ? current : insets));
  }, []);

  /* Tamano del escenario. */
  useEffect(() => {
    if (!enabled) return;
    const element = clipRef.current;
    if (!element) return;
    const measure = () => {
      setStageSize((current) =>
        Math.abs(current.width - element.clientWidth) < 0.5 && Math.abs(current.height - element.clientHeight) < 0.5
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const frame = window.requestAnimationFrame(measure);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [enabled, clipRef]);

  /* Teclado virtual y barra de sugerencias: la ventana visual cambia al abrirse o al desplazarse. */
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const element = clipRef.current;
      if (!element) return;
      const next = readObstructionInsets(element.getBoundingClientRect());
      setObstruction((current) =>
        sameInsets(current.insets, next.insets) && current.keyboard === next.keyboard ? current : next,
      );
    };
    const schedule = () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        update();
      });
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    // La barra de sugerencias se monta DESPUES de enfocar el campo: una segunda medida cuando ya esta pintada.
    const late = window.setTimeout(schedule, 250);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.clearTimeout(late);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [enabled, clipRef, watchKey]);

  const insets = useMemo<Insets>(
    () => ({
      top: Math.max(chrome.top, obstruction.insets.top),
      right: Math.max(chrome.right, obstruction.insets.right),
      // Con el teclado abierto el panel de abajo queda tapado por el: manda lo que tape mas, no la suma.
      bottom: Math.max(chrome.bottom, obstruction.insets.bottom),
      left: Math.max(chrome.left, obstruction.insets.left),
    }),
    [chrome, obstruction],
  );
  const free = useMemo(() => freeBoxOf(stageSize, insets, SHEET_MARGIN), [stageSize, insets]);
  const sheet = useMemo<Size | null>(
    () =>
      stageSize.width > 0 && stageSize.height > 0 ? fitSheetSize(stageSize, aspect, fitMode, SHEET_MARGIN) : null,
    [stageSize, aspect, fitMode],
  );

  return {
    stageSize,
    fitMode,
    setFitMode,
    insets,
    setChromeInsets,
    keyboardOpen: obstruction.keyboard,
    free,
    sheet,
  };
}
