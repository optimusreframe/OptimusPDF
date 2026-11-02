import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Extraer audio de un video",
  description: "Extraer audio de un video en OptimusPDF. Todavía no está disponible.",
  alternates: { canonical: "/audio-extractor" },
};

export default function AudioExtractorPage() {
  return <ToolPageSoon slug="audio-extractor" />;
}
