import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "HTML a PDF",
  description:
    "Captura una página web o un archivo HTML como documento PDF. Todavía no está disponible en OptimusPDF.",
  alternates: { canonical: "/html-to-pdf" },
};

export default function HtmlToPdfPage() {
  return <ToolPageSoon slug="html-to-pdf" />;
}
