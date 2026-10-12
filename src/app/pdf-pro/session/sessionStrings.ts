import type { Language } from "@/lib/i18n";

/** Textos de sesion de PDF Pro (Wave 7 · U8): cambiar de documento, recientes y acciones del estado vacio. */
export type SessionStrings = {
  replaceTitle: string;
  replaceBody: string;
  replaceConfirm: string;
  recentsTitle: string;
  recentsLoading: string;
  openLast: string;
  openLastHint: (name: string) => string;
  actionsTitle: string;
  newFromImages: string;
  newBlank: string;
  limitsTitle: string;
};

const es: SessionStrings = {
  replaceTitle: "Cambiar de documento",
  replaceBody:
    "Tienes cambios sin descargar en este documento. Si continúas, se cierra y solo quedará el borrador automático de este navegador (si está activado).",
  replaceConfirm: "Continuar",
  recentsTitle: "Documentos recientes",
  recentsLoading: "Buscando documentos recientes…",
  openLast: "Reabrir el último documento",
  openLastHint: (name) => `Retoma «${name}», guardado en este navegador.`,
  actionsTitle: "Empezar",
  newFromImages: "Nuevo desde imágenes",
  newBlank: "Nuevo en blanco",
  limitsTitle: "Tamaño y memoria",
};

const en: SessionStrings = {
  replaceTitle: "Switch document",
  replaceBody:
    "You have changes you haven't downloaded in this document. If you continue, it closes and only this browser's automatic draft (if enabled) will remain.",
  replaceConfirm: "Continue",
  recentsTitle: "Recent documents",
  recentsLoading: "Looking for recent documents…",
  openLast: "Reopen the last document",
  openLastHint: (name) => `Pick up “${name}”, saved in this browser.`,
  actionsTitle: "Get started",
  newFromImages: "New from images",
  newBlank: "New blank document",
  limitsTitle: "Size and memory",
};

export const SESSION_STRINGS: Record<Language, SessionStrings> = { es, en };

export function getSessionStrings(language: Language): SessionStrings {
  return SESSION_STRINGS[language] ?? es;
}
