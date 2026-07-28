import type { Metadata } from "next";
import { RepairToolClient } from "@/app/repair-pdf/RepairToolClient";

export const metadata: Metadata = {
  title: "Reparar PDF",
  description:
    "Recupera documentos dañados reconstruyendo su estructura interna: índice de objetos, trailer y cabecera. Te dice exactamente cuántas páginas se recuperaron. Todo en tu navegador, sin subir el archivo.",
  alternates: { canonical: "/repair-pdf" },
};

export default function RepairPdfPage() {
  return <RepairToolClient />;
}
