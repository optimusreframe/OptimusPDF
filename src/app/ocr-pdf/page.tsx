import type { Metadata } from "next";
import { OcrToolClient } from "@/app/ocr-pdf/OcrToolClient";

export const metadata: Metadata = {
  title: "OCR de PDF",
  description:
    "Reconoce el texto de un PDF escaneado en tu navegador y añádelo como capa invisible para poder buscarlo y copiarlo. El documento no se sube a ningún servidor.",
  alternates: { canonical: "/ocr-pdf" },
};

export default function OcrPdfPage() {
  return <OcrToolClient />;
}
