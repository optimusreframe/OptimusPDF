import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Convertidor de imágenes",
  description: "Convertidor de imágenes en OptimusPDF. Todavía no está disponible.",
  alternates: { canonical: "/image-converter" },
};

export default function ImageConverterPage() {
  return <ToolPageSoon slug="image-converter" />;
}
