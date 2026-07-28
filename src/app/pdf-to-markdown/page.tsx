import type { Metadata } from "next";
import { PdfToMarkdownToolClient } from "@/app/pdf-to-markdown/PdfToMarkdownToolClient";

export const metadata: Metadata = {
  title: "PDF a Markdown",
  description:
    "Convierte el contenido de un PDF en Markdown estructurado dentro de tu navegador: títulos, listas, código y tablas regulares. El documento no se sube a ningún servidor.",
  alternates: { canonical: "/pdf-to-markdown" },
};

export default function PdfToMarkdownPage() {
  return <PdfToMarkdownToolClient />;
}
