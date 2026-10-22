import type { Metadata } from "next";
import { ExtractToolClient } from "@/app/extract-assets/ExtractToolClient";

export const metadata: Metadata = {
  title: "Extraer elementos de un PDF",
  description:
    "Saca de un PDF las firmas, iniciales, imágenes, logos, sellos y marcas de agua, con fondo transparente y listos para descargar o guardar. Todo ocurre en tu navegador: el documento no se sube a ningún servidor.",
  alternates: { canonical: "/extract-assets" },
};

export default function ExtractAssetsPage() {
  return <ExtractToolClient />;
}
