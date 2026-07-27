import type { Metadata } from "next";
import { ToolsView } from "@/components/views/ToolsView";

export const metadata: Metadata = {
  title: "Herramientas",
  description:
    "Catálogo completo de herramientas PDF de OptimusPDF, agrupadas por tarea y con estado honesto de disponibilidad.",
};

export default function ToolsPage() {
  return <ToolsView />;
}
