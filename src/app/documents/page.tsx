import type { Metadata } from "next";
import { MyDocumentsView } from "@/components/views/MyDocumentsView";

export const metadata: Metadata = {
  title: "Mis documentos",
  description:
    "Tus contratos guardados solo en este navegador, con la plantilla de dónde firma cada quien. Your contracts, saved only in this browser, with a template for where each person signs.",
};

export default function DocumentsPage() {
  return <MyDocumentsView />;
}
