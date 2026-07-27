import type { Metadata } from "next";
import { SplitToolClient } from "@/app/split-pdf/SplitToolClient";

export const metadata: Metadata = {
  title: "Dividir PDF",
  description:
    "Parte un PDF por tramos, cada N páginas o extrae las que necesites. Un documento o un ZIP, siempre dentro de tu navegador.",
  alternates: { canonical: "/split-pdf" },
};

export default function SplitPdfPage() {
  return <SplitToolClient />;
}
