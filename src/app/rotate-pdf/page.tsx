import type { Metadata } from "next";
import { RotateToolClient } from "@/app/rotate-pdf/RotateToolClient";

export const metadata: Metadata = {
  title: "Rotar PDF",
  description:
    "Gira todo el documento o páginas sueltas en múltiplos de 90 grados y guarda el resultado. El PDF nunca sale de tu navegador.",
  alternates: { canonical: "/rotate-pdf" },
};

export default function RotatePdfPage() {
  return <RotateToolClient />;
}
