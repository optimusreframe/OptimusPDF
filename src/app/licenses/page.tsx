import type { Metadata } from "next";
import { LicensesView } from "@/app/licenses/LicensesView";

export const metadata: Metadata = {
  title: "Licencias y avisos",
  description:
    "Componentes de código abierto que lleva OptimusPDF, con su versión, licencia y código fuente. Incluye la salida MP3 con LAME (LGPL), mediabunny y su codificador (MPL-2.0).",
};

export default function LicensesPage() {
  return <LicensesView />;
}
