import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "PDF a Word",
  description:
    "Convierte un PDF en un documento DOCX editable. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/pdf-to-word" },
};

export default function PdfToWordPage() {
  return <ToolPageSoon slug="pdf-to-word" />;
}
