"use client";

import type { ComponentType } from "react";
import type { ProTabId } from "@/app/pdf-pro/ProTabs";
import { ConvertTab } from "@/app/pdf-pro/tabs/ConvertTab";
import { DocumentTab } from "@/app/pdf-pro/tabs/DocumentTab";
import { ProtectTab } from "@/app/pdf-pro/tabs/ProtectTab";
import { PagesTabPanel } from "@/app/pdf-pro/pages/PagesTabPanel";
// Modos con sesion propia (Wave 7 · U6/U7): importarlos los registra; `ProModeHost` monta el de la pestaña activa.
import "@/app/pdf-pro/modes/registerEditModes";
import "@/app/pdf-pro/modes/signModes";

/**
 * Contenido del panel contextual de cada pestaña de la suite (mapa `pestaña → componente`). La suite pinta
 * `PRO_TAB_CONTENT[tab]`. Las pestañas SIN entrada (`edit`, `annotate`, `sign`) son modos con sesion propia: ocupan la
 * region central (`ProModeHost`) y no tienen panel; la suite no pinta ninguno para ellas (ni «Próximamente»).
 *
 *  - `home` (Inicio): resumen, herramientas de documento, acciones rapidas e historial (Wave 7 · U5).
 *  - `pages` (Páginas): el organizador de paginas (U4).
 *  - `protect` (Proteger): «Guardar con contraseña…» y «Quitar protección» (U5).
 *  - `convert` (Convertir): las ocho exportaciones (U5 el contenedor, U8 los motores).
 */
export const PRO_TAB_CONTENT: Partial<Record<ProTabId, ComponentType>> = {
  home: DocumentTab,
  pages: PagesTabPanel,
  protect: ProtectTab,
  convert: ConvertTab,
};
