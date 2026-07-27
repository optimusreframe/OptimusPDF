import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Excel a PDF",
  description:
    "Convierte hojas de cálculo XLS y XLSX en un PDF paginado. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/excel-to-pdf" },
};

export default function ExcelToPdfPage() {
  return <ToolPageSoon slug="excel-to-pdf" />;
}
