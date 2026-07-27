import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Resumir PDF",
  description:
    "Obtén un resumen del documento con sus puntos clave. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/pdf-summarizer" },
};

export default function PdfSummarizerPage() {
  return <ToolPageSoon slug="pdf-summarizer" />;
}
