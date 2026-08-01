import type { Metadata } from "next";
import { PdfToWordClient } from "@/app/pdf-to-word/PdfToWordClient";

export const metadata: Metadata = {
  title: "PDF a Word",
  description:
    "Convierte un PDF en un documento DOCX editable, con títulos, listas, tablas y bloques de código reconstruidos.",
  alternates: { canonical: "/pdf-to-word" },
};

export default function PdfToWordPage() {
  return <PdfToWordClient />;
}
