import type { Metadata } from "next";
import { WatermarkToolClient } from "@/app/add-watermark/WatermarkToolClient";

export const metadata: Metadata = {
  title: "Marca de agua en PDF",
  description:
    "Añade una marca de agua de texto o imagen a tu PDF con control de posición, mosaico, transparencia y rotación. Todo se procesa en tu navegador.",
  alternates: { canonical: "/add-watermark" },
};

export default function AddWatermarkPage() {
  return <WatermarkToolClient />;
}
