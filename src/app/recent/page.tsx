import type { Metadata } from "next";
import { RecentView } from "@/components/views/RecentView";

export const metadata: Metadata = {
  title: "Recientes",
  description:
    "Tus trabajos sin terminar y el historial de herramientas usadas, guardados solo en este navegador. Los trabajos sin terminar incluyen el documento para poder continuarlos.",
};

export default function RecentPage() {
  return <RecentView />;
}
