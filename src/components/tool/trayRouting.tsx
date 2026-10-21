"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

/*
 * Bandeja de herramientas de PDF Pro en movil (M5 · N2).
 *
 * En un telefono la paleta del editor, «Aplanar pagina» y el aviso de privacidad no pueden restar alto a la hoja: el anfitrion
 * de los modos (`ProModeHost`) pinta una BANDEJA flotante sobre el borde inferior de la hoja (no ocupa sitio en el reparto) y
 * el editor lleva ahi esas piezas con un portal. Elegir una herramienta cierra la bandeja y la barra del modo recuerda cual
 * quedo armada. Sin bandeja (escritorio, tablet con paneles, movil horizontal, o la ruta suelta «Editar PDF») el contexto
 * es `null` y cada pieza se pinta donde siempre.
 */

export type TraySlot = "palette" | "actions" | "privacy" | "history";

export type TrayTool = { id: string; label: string; icon: LucideIcon };

export type TrayValue = {
  /**
   * Huecos de la bandeja. Una pieza cuyo hueco NO figura aqui se pinta en su sitio (movil horizontal: la paleta sigue siendo
   * una columna lateral y solo «Aplanar» y la privacidad van a la bandeja); si figura pero aun es `null`, espera a que se monte.
   */
  slots: Partial<Record<TraySlot, HTMLElement | null>>;
  /** Se eligio una herramienta (o se pidio desde fuera): la bandeja se cierra sola. */
  onToolPicked: () => void;
  /** Herramienta armada ahora (`null` = ninguna), para que la barra del modo la nombre cuando la bandeja esta cerrada. */
  reportTool: (tool: TrayTool | null) => void;
};

const TrayContext = createContext<TrayValue | null>(null);

export const TrayProvider = TrayContext.Provider;

export function useTray(): TrayValue | null {
  return useContext(TrayContext);
}

/**
 * Pinta `children` en el hueco `slot` de la bandeja si la hay; sin bandeja, en su sitio. Con bandeja pero con el hueco aun
 * sin montar (el primer pintado) no pinta nada: el hueco se monta en el mismo commit y las piezas aparecen en el siguiente.
 */
export function TrayPortal({ slot, children }: { slot: TraySlot; children: ReactNode }) {
  const tray = useTray();
  if (!tray || !(slot in tray.slots)) return <>{children}</>;
  const target = tray.slots[slot];
  return target ? createPortal(children, target) : null;
}

/**
 * (M6 · a) Deshacer y rehacer van en la BARRA del modo (siempre a la vista, sin abrir la bandeja): el hueco `history` es un nodo
 * de esa barra. A diferencia de los otros huecos, una pieza de `history` NO se pinta en su sitio cuando no hay hueco
 * (escritorio, «Editar PDF» suelto): ahi ya tienen su boton en la paleta.
 */
export function TrayHistoryPortal({ children }: { children: ReactNode }) {
  const tray = useTray();
  const target = tray && "history" in tray.slots ? tray.slots.history : null;
  return target ? createPortal(children, target) : null;
}

/** ¿Los botones de deshacer/rehacer viven en la barra del modo (y la paleta de la bandeja no los repite)? */
export function useHistoryInBar(): boolean {
  const tray = useTray();
  return tray !== null && "history" in tray.slots;
}
