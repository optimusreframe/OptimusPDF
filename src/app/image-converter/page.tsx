import type { Metadata } from "next";
import { ImageConverterToolClient } from "@/app/image-converter/ImageConverterToolClient";

export const metadata: Metadata = {
  title: "Convertidor de imágenes",
  description:
    "Convierte imágenes entre JPG, PNG, WebP y otros formatos, eligiendo calidad, tamaño y color de fondo. Varias a la vez, todo en tu navegador, sin subir nada.",
  alternates: { canonical: "/image-converter" },
};

export default function ImageConverterPage() {
  return <ImageConverterToolClient />;
}
