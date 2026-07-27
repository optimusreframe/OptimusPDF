import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Traducir PDF",
  description:
    "Traduce el contenido del documento a otro idioma. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/translate-pdf" },
};

export default function TranslatePdfPage() {
  return <ToolPageSoon slug="translate-pdf" />;
}
