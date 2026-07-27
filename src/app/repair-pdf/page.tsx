import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Reparar PDF",
  description:
    "Recupera documentos dañados reconstruyendo su estructura interna. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/repair-pdf" },
};

export default function RepairPdfPage() {
  return <ToolPageSoon slug="repair-pdf" />;
}
