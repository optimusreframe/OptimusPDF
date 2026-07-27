import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "PDF a PowerPoint",
  description:
    "Convierte un PDF en una presentación PPTX editable. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/pdf-to-powerpoint" },
};

export default function PdfToPowerpointPage() {
  return <ToolPageSoon slug="pdf-to-powerpoint" />;
}
