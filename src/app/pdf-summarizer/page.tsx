import type { Metadata } from "next";
import { PdfSummarizerToolClient } from "@/app/pdf-summarizer/PdfSummarizerToolClient";

export const metadata: Metadata = {
  title: "Resumir PDF",
  description:
    "Resume un PDF con un modelo de lenguaje que se ejecuta en tu propio navegador: el documento no se sube a ningún servidor. Requiere WebGPU y descargar el modelo una vez. El resumen lo escribe una IA y puede contener errores.",
  alternates: { canonical: "/pdf-summarizer" },
};

export default function PdfSummarizerPage() {
  return <PdfSummarizerToolClient />;
}
