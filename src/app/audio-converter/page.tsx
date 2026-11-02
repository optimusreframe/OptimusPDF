import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Convertidor de audio",
  description: "Convertidor de audio en OptimusPDF. Todavía no está disponible.",
  alternates: { canonical: "/audio-converter" },
};

export default function AudioConverterPage() {
  return <ToolPageSoon slug="audio-converter" />;
}
