import type { Metadata } from "next";
import { SettingsView } from "@/components/views/SettingsView";

export const metadata: Metadata = {
  title: "Ajustes",
  description:
    "Idioma de la interfaz y datos locales guardados por OptimusPDF en este navegador.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
