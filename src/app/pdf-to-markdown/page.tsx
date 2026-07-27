import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "PDF a Markdown",
  description:
    "Convierte el contenido del PDF en Markdown estructurado. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/pdf-to-markdown" },
};

export default function PdfToMarkdownPage() {
  return <ToolPageSoon slug="pdf-to-markdown" />;
}
