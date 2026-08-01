import type { Metadata } from "next";
import { PdfToPowerpointClient } from "@/app/pdf-to-powerpoint/PdfToPowerpointClient";

export const metadata: Metadata = {
  title: "PDF a PowerPoint",
  description:
    "Convierte cada página de un PDF en una diapositiva de imagen dentro de un PPTX. El documento no sale de tu navegador.",
  alternates: { canonical: "/pdf-to-powerpoint" },
};

export default function PdfToPowerpointPage() {
  return <PdfToPowerpointClient />;
}
