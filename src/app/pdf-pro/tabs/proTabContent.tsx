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
 * `PRO_TAB_CONTENT[tab]`; una pestaña sin entrada muestra su aviso «Próximamente».
 *
 *  - `home` (Inicio): resumen, herramientas de documento, acciones rapidas e historial (Wave 7 · U5).
 *  - `protect` (Proteger): «Guardar con contraseña…» y «Quitar protección» (U5).
 *  - `convert` (Convertir): contenedor de exportaciones (U5; las implementa U8).
 *  - `pages` / `edit` / `annotate` / `sign`: las añaden U4 y las unidades de modos.
 */
export const PRO_TAB_CONTENT: Partial<Record<ProTabId, ComponentType>> = {
  home: DocumentTab,
  pages: PagesTabPanel,
  protect: ProtectTab,
  convert: ConvertTab,
};
