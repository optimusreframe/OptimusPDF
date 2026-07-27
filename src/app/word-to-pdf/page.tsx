import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Word a PDF",
  description:
    "Convierte documentos DOC y DOCX a PDF conservando el formato. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/word-to-pdf" },
};

export default function WordToPdfPage() {
  return <ToolPageSoon slug="word-to-pdf" />;
}
