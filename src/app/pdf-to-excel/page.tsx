import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "PDF a Excel",
  description:
    "Extrae las tablas de un PDF a una hoja de cálculo XLSX. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/pdf-to-excel" },
};

export default function PdfToExcelPage() {
  return <ToolPageSoon slug="pdf-to-excel" />;
}
