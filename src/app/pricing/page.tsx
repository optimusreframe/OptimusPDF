import type { Metadata } from "next";
import { PricingView } from "@/components/views/PricingView";

export const metadata: Metadata = {
  title: "Precios",
  description:
    "Todo lo que se ejecuta en tu navegador es gratis. Lo que necesitaría servidores todavía no existe, y lo decimos claro.",
};

export default function PricingPage() {
  return <PricingView />;
}
