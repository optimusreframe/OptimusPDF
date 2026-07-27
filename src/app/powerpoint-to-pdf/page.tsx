import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "PowerPoint a PDF",
  description:
    "Convierte presentaciones PPT y PPTX en un PDF listo para enviar. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/powerpoint-to-pdf" },
};

export default function PowerpointToPdfPage() {
  return <ToolPageSoon slug="powerpoint-to-pdf" />;
}
