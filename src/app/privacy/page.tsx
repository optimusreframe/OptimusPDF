import type { Metadata } from "next";
import { PrivacyView } from "@/app/privacy/PrivacyView";

export const metadata: Metadata = {
  title: "Política de privacidad",
  description:
    "Qué se procesa localmente en tu navegador y qué peticiones de red existen en OptimusPDF (descarga de modelos de IA, nunca tu documento).",
};

export default function PrivacyPage() {
  return <PrivacyView />;
}
