import type { Metadata } from "next";
import { HtmlToPdfToolClient } from "@/app/html-to-pdf/HtmlToPdfToolClient";

export const metadata: Metadata = {
  title: "HTML a PDF",
  description:
    "Convierte una página web (escribe su dirección) o un archivo HTML en un PDF tamaño carta. El PDF se crea en tu dispositivo; solo para leer una dirección la consulta nuestro servidor, que no guarda nada. El HTML nunca llega a ejecutarse.",
  alternates: { canonical: "/html-to-pdf" },
};

export default function HtmlToPdfPage() {
  return <HtmlToPdfToolClient />;
}
