import type { Metadata } from "next";
import { JpgToPdfClient } from "@/app/jpg-to-pdf/JpgToPdfClient";

export const metadata: Metadata = {
  title: "Imagen a PDF",
  description:
    "Convierte JPG, PNG o WEBP en un PDF eligiendo tamaño de página, orientación y margen. Todo en tu navegador, sin subir nada.",
  alternates: { canonical: "/jpg-to-pdf" },
};

export default function JpgToPdfPage() {
  return <JpgToPdfClient />;
}
