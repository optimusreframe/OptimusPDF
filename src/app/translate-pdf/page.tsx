import type { Metadata } from "next";
import { TranslateReportToolClient } from "@/app/translate-pdf/TranslateReportToolClient";

/**
 * La copy dice "informe de traducción" y no "traducir PDF" a proposito:
 * la herramienta devuelve un informe bilingue en texto, no el PDF
 * original maquetado en otro idioma. Prometer lo segundo en el <title>
 * o en la descripcion seria atraer a alguien a una pagina que no hace
 * lo que espera.
 */
export const metadata: Metadata = {
  title: "Informe de traducción de PDF",
  description:
    "Extrae el texto de un PDF y tradúcelo en tu navegador con un modelo local. Obtienes un informe bilingüe (original y traducción, página a página), no un PDF traducido con la maquetación original. El documento no se sube a ningún servidor.",
  alternates: { canonical: "/translate-pdf" },
};

export default function TranslatePdfPage() {
  return <TranslateReportToolClient />;
}
