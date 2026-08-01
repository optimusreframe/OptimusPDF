import type { Metadata } from "next";
import { PdfsToZipClient } from "@/app/pdfs-to-zip/PdfsToZipClient";

export const metadata: Metadata = {
  title: "PDFs a ZIP",
  description:
    "Empaqueta varios PDF en un solo archivo ZIP sin fusionar ni reprocesar su contenido, directamente en tu navegador.",
  alternates: { canonical: "/pdfs-to-zip" },
};

export default function PdfsToZipPage() {
  return <PdfsToZipClient />;
}
