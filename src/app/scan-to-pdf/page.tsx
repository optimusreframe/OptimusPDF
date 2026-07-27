import type { Metadata } from "next";
import { ScanToPdfClient } from "@/app/scan-to-pdf/ScanToPdfClient";

export const metadata: Metadata = {
  title: "Escanear a PDF",
  description:
    "Convierte la cámara de tu dispositivo en un escáner: captura página a página y guárdalas en un PDF sin subir nada a internet.",
  alternates: { canonical: "/scan-to-pdf" },
};

export default function ScanToPdfPage() {
  return <ScanToPdfClient />;
}
