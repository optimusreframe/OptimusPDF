import type { Metadata } from "next";
import { PdfToJsonClient } from "@/app/pdf-to-json/PdfToJsonClient";

export const metadata: Metadata = {
  title: "PDF a JSON",
  description:
    "Convierte el contenido de un PDF en un JSON estructurado dentro de tu navegador: títulos, párrafos, listas, tablas y bloques de código. El documento no se sube a ningún servidor.",
  alternates: { canonical: "/pdf-to-json" },
};

export default function PdfToJsonPage() {
  return <PdfToJsonClient />;
}
