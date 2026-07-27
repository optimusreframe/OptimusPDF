import type { Metadata } from "next";
import { CompareToolClient } from "@/app/compare-pdf/CompareToolClient";

export const metadata: Metadata = {
  title: "Comparar PDF",
  description:
    "Enfrenta dos versiones de un PDF y resalta palabra a palabra lo que se ha añadido y lo que se ha eliminado. La comparación ocurre entera en tu navegador.",
  alternates: { canonical: "/compare-pdf" },
};

export default function ComparePdfPage() {
  return <CompareToolClient />;
}
