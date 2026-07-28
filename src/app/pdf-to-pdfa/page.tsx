import type { Metadata } from "next";
import { PdfaCheckerToolClient } from "@/app/pdf-to-pdfa/PdfaCheckerToolClient";

/**
 * La ruta se mantiene en `/pdf-to-pdfa` (nunca estuvo publicada como
 * herramienta viva, asi que no hay enlaces que romper), pero la
 * herramienta ya no promete convertir: revisa el documento y explica
 * que le falta para ser PDF/A.
 */
export const metadata: Metadata = {
  title: "Verificar PDF/A",
  description:
    "Revisa si tu PDF cumple los requisitos de PDF/A y qué le falta: identificación en los metadatos, fuentes incrustadas, perfil de color, cifrado, JavaScript y adjuntos. Todo en tu navegador; no convierte el archivo ni certifica la conformidad.",
  alternates: { canonical: "/pdf-to-pdfa" },
};

export default function PdfToPdfaPage() {
  return <PdfaCheckerToolClient />;
}
