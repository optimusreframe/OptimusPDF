import type { Metadata } from "next";
import { PdfToCsvClient } from "@/app/pdf-to-csv/PdfToCsvClient";

export const metadata: Metadata = {
  title: "Extraer tablas de PDF",
  description:
    "Extrae solo las tablas de un PDF a un archivo CSV o JSON, en el orden en que aparecen en el documento.",
  alternates: { canonical: "/pdf-to-csv" },
};

export default function PdfToCsvPage() {
  return <PdfToCsvClient />;
}
