import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Convertidor de video",
  description: "Convertidor de video en OptimusPDF. Todavía no está disponible.",
  alternates: { canonical: "/video-converter" },
};

export default function VideoConverterPage() {
  return <ToolPageSoon slug="video-converter" />;
}
