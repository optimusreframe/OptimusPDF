import type { Language } from "@/lib/i18n";

/** Copy propio del panel de resumen de Unir PDF (ES/EN). */
export type MergeStrings = {
  summaryFiles: (count: number) => string;
  summaryPages: (selected: number, total: number) => string;
  reading: string;
  hint: string;
};

export const MERGE_STRINGS: Record<Language, MergeStrings> = {
  es: {
    summaryFiles: (count) => `${count} archivos para unir`,
    summaryPages: (selected, total) =>
      selected === total
        ? `${total} páginas en el documento final`
        : `${selected} de ${total} páginas en el documento final`,
    reading: "Leyendo las páginas…",
    hint: "Cambia el orden de los archivos con las flechas y el de las páginas arrastrando o con las flechas de cada miniatura. Desmarca o quita las páginas que no quieras.",
  },
  en: {
    summaryFiles: (count) => `${count} files to merge`,
    summaryPages: (selected, total) =>
      selected === total
        ? `${total} pages in the final document`
        : `${selected} of ${total} pages in the final document`,
    reading: "Reading the pages…",
    hint: "Change the order of the files with the arrows and the order of the pages by dragging or with each thumbnail's arrows. Uncheck or remove the pages you don't want.",
  },
};
