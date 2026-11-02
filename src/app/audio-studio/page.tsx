import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Audio Studio",
  description: "Audio Studio en OptimusPDF. Todavía no está disponible.",
  alternates: { canonical: "/audio-studio" },
};

export default function AudioStudioPage() {
  return <ToolPageSoon slug="audio-studio" />;
}
