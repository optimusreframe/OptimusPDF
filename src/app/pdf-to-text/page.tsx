import type { Metadata } from "next";
import { PdfToTextClient } from "@/app/pdf-to-text/PdfToTextClient";

export const metadata: Metadata = {
  title: "PDF a Texto",
  description:
    "Extrae todo el texto de un PDF como archivo .txt, página por página, sin títulos ni listas reconstruidas. Con OCR opcional para páginas escaneadas. Todo en tu navegador.",
  alternates: { canonical: "/pdf-to-text" },
};

export default function PdfToTextPage() {
  return <PdfToTextClient />;
}
