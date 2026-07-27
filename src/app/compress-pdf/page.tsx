import type { Metadata } from "next";
import { CompressToolClient } from "@/app/compress-pdf/CompressToolClient";

export const metadata: Metadata = {
  title: "Comprimir PDF",
  description:
    "Reduce el peso de un PDF en tu propio navegador eligiendo entre tres niveles de compresión. Sin subir archivos y explicando qué se pierde por el camino.",
  alternates: { canonical: "/compress-pdf" },
};

export default function CompressPdfPage() {
  return <CompressToolClient />;
}
