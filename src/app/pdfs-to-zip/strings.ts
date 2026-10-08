import type { Language } from "@/lib/i18n";

/**
 * Copy propio de "PDFs a ZIP". El diccionario global (`t.tools["pdfs-to-zip"]`)
 * ya cubre el nombre y la descripción corta que usa `ToolShell`; aquí solo
 * vive el texto adicional de esta página y el nombre base del ZIP
 * descargado (sin depender de `t.filenames`, que esta herramienta no toca).
 */
export type PdfsToZipStrings = {
  howItWorksTitle: string;
  howItWorksBody: string;
  filenameBase: string;
};

const es: PdfsToZipStrings = {
  howItWorksTitle: "Cómo funciona",
  howItWorksBody:
    "Cada PDF se agrega al ZIP tal cual, sin abrirlo ni volver a procesarlo: el contenido de cada archivo llega intacto, byte a byte. Si eliges esta herramienta para combinar el contenido de varios PDF en un solo documento, es 'Unir PDF' lo que necesitas — aquí los archivos siguen siendo documentos independientes dentro del mismo ZIP. Todo ocurre en tu navegador: los archivos no se suben a ningún servidor.",
  filenameBase: "pdfs",
};

const en: PdfsToZipStrings = {
  howItWorksTitle: "How it works",
  howItWorksBody:
    "Each PDF is added to the ZIP as-is, without opening or reprocessing it: every file's content arrives intact, byte for byte. If you're looking to combine the content of several PDFs into a single document, 'Merge PDF' is what you need — here the files stay independent documents inside the same ZIP. Everything runs in your browser: files are never uploaded.",
  filenameBase: "pdfs",
};

export const PDFS_TO_ZIP_STRINGS: Record<Language, PdfsToZipStrings> = {
  es,
  en,
};
