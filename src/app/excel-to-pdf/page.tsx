import type { Metadata } from "next";
import { ExcelToPdfClient } from "@/app/excel-to-pdf/ExcelToPdfClient";

export const metadata: Metadata = {
  title: "Excel a PDF",
  description:
    "Convierte hojas de cálculo XLSX en un PDF con tablas nativas, texto seleccionable y buscable.",
  alternates: { canonical: "/excel-to-pdf" },
};

export default function ExcelToPdfPage() {
  return <ExcelToPdfClient />;
}
