import type { Metadata } from "next";
import { CropToolClient } from "@/app/crop-pdf/CropToolClient";

export const metadata: Metadata = {
  title: "Recortar PDF",
  description:
    "Ajusta los márgenes de tu PDF dibujando el área útil sobre la vista previa. El recorte se aplica a todas las páginas o solo a la que elijas, sin salir del navegador.",
  alternates: { canonical: "/crop-pdf" },
};

export default function CropPdfPage() {
  return <CropToolClient />;
}
