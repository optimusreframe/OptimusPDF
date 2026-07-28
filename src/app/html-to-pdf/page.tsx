import type { Metadata } from "next";
import { HtmlToPdfToolClient } from "@/app/html-to-pdf/HtmlToPdfToolClient";

export const metadata: Metadata = {
  title: "HTML a PDF",
  description:
    "Convierte un archivo HTML en PDF capturando cómo se ve en el navegador. Todo ocurre en tu dispositivo y el HTML nunca llega a ejecutarse.",
  alternates: { canonical: "/html-to-pdf" },
};

export default function HtmlToPdfPage() {
  return <HtmlToPdfToolClient />;
}
