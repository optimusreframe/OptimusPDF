import type { Metadata } from "next";
import { PdfToExcelClient } from "@/app/pdf-to-excel/PdfToExcelClient";

export const metadata: Metadata = {
  title: "PDF a Excel",
  description:
    "Extrae las tablas de un PDF a una hoja de cálculo XLSX, una hoja por tabla, con texto real.",
  alternates: { canonical: "/pdf-to-excel" },
};

export default function PdfToExcelPage() {
  return <PdfToExcelClient />;
}
