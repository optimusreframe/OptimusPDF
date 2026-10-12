import type { Language } from "@/lib/i18n";

/** Textos de guardar y descargar de PDF Pro (Wave 7 · U8), es/en. */
export type SaveStrings = {
  menuLabel: string;
  downloadPdf: string;
  saveAs: string;
  saveWithPassword: string;
  exportAs: string;
  confirmTitle: string;
  confirmSignatures: string;
  confirmDecrypted: string;
  confirmDownload: string;
  confirmDownloadPlain: string;
  confirmProtect: string;
  cancel: string;
  saveAsTitle: string;
  saveAsBody: string;
  nameLabel: string;
  nameHint: string;
  nameEmpty: string;
  saveAsButton: string;
  protectTitle: string;
  downloaded: (filename: string) => string;
};

const es: SaveStrings = {
  menuLabel: "Guardar y exportar",
  downloadPdf: "Descargar PDF",
  saveAs: "Guardar como…",
  saveWithPassword: "Guardar con contraseña…",
  exportAs: "Exportar como…",
  confirmTitle: "Antes de descargar",
  confirmSignatures:
    "Este PDF tiene firmas digitales: al descargarlo con cambios dejarán de ser válidas.",
  confirmDecrypted:
    "Trabajas con una copia sin contraseña, así que la descarga saldrá sin cifrar. Si quieres protegerla otra vez, guárdala con contraseña.",
  confirmDownload: "Descargar de todos modos",
  confirmDownloadPlain: "Descargar sin contraseña",
  confirmProtect: "Guardar con contraseña…",
  cancel: "Cancelar",
  saveAsTitle: "Guardar como…",
  saveAsBody: "Elige el nombre con el que se descargará el PDF.",
  nameLabel: "Nombre del archivo",
  nameHint: "Se añade .pdf si falta.",
  nameEmpty: "Escribe un nombre para el archivo.",
  saveAsButton: "Descargar",
  protectTitle: "Guardar con contraseña",
  downloaded: (filename) => `Descargado: ${filename}`,
};

const en: SaveStrings = {
  menuLabel: "Save and export",
  downloadPdf: "Download PDF",
  saveAs: "Save as…",
  saveWithPassword: "Save with a password…",
  exportAs: "Export as…",
  confirmTitle: "Before downloading",
  confirmSignatures:
    "This PDF has digital signatures: downloading it with changes will make them invalid.",
  confirmDecrypted:
    "You are working with a copy without a password, so the download will come out unencrypted. If you want to protect it again, save it with a password.",
  confirmDownload: "Download anyway",
  confirmDownloadPlain: "Download without a password",
  confirmProtect: "Save with a password…",
  cancel: "Cancel",
  saveAsTitle: "Save as…",
  saveAsBody: "Choose the name the PDF will be downloaded with.",
  nameLabel: "File name",
  nameHint: ".pdf is added if it is missing.",
  nameEmpty: "Type a name for the file.",
  saveAsButton: "Download",
  protectTitle: "Save with a password",
  downloaded: (filename) => `Downloaded: ${filename}`,
};

export const SAVE_STRINGS: Record<Language, SaveStrings> = { es, en };

export function getSaveStrings(language: Language): SaveStrings {
  return SAVE_STRINGS[language] ?? es;
}
