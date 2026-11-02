import type { Metadata } from "next";
import { AboutView } from "@/components/views/AboutView";
import { AboutLicensesCard } from "@/app/licenses/LicensesView";

export const metadata: Metadata = {
  title: "El proyecto",
  description:
    "Por qué OptimusPDF procesa los documentos en tu navegador en lugar de subirlos a un servidor.",
};

export default function AboutPage() {
  return (
    <>
      <AboutView />
      {/* Enlace a /licenses: la vista de «El proyecto» vive en components/views, asi que la tarjeta se anade aqui, debajo. */}
      <AboutLicensesCard />
    </>
  );
}
