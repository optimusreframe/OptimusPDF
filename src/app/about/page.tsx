import type { Metadata } from "next";
import { AboutView } from "@/components/views/AboutView";

export const metadata: Metadata = {
  title: "El proyecto",
  description:
    "Por qué OptimusPDF procesa los documentos en tu navegador en lugar de subirlos a un servidor.",
};

export default function AboutPage() {
  return <AboutView />;
}
