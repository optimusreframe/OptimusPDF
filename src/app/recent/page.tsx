import type { Metadata } from "next";
import { RecentView } from "@/components/views/RecentView";

export const metadata: Metadata = {
  title: "Recientes",
  description:
    "Trabajos recientes guardados solo en este dispositivo: nombre, herramienta y fecha. Nunca el documento.",
};

export default function RecentPage() {
  return <RecentView />;
}
