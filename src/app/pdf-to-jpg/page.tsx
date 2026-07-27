import type { Metadata } from "next";
import { PdfToJpgClient } from "@/app/pdf-to-jpg/PdfToJpgClient";

export const metadata: Metadata = {
  title: "PDF a JPG",
  description:
    "Convierte las páginas de un PDF en imágenes JPG eligiendo calidad y resolución. El documento no sale de tu navegador.",
  alternates: { canonical: "/pdf-to-jpg" },
};

export default function PdfToJpgPage() {
  return <PdfToJpgClient />;
}
