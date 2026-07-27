import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "PDF a PDF/A",
  description:
    "Convierte el documento al estándar PDF/A para archivo a largo plazo. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/pdf-to-pdfa" },
};

export default function PdfToPdfaPage() {
  return <ToolPageSoon slug="pdf-to-pdfa" />;
}
