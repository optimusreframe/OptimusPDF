import type { Metadata } from "next";
import { MergeToolClient } from "@/app/merge-pdf/MergeToolClient";

export const metadata: Metadata = {
  title: "Unir PDF",
  description:
    "Combina varios PDF en un solo documento directamente en tu navegador. Sin subir archivos, sin cuentas y sin marcas de agua.",
  alternates: { canonical: "/merge-pdf" },
};

export default function MergePdfPage() {
  return <MergeToolClient />;
}
