import type { Metadata } from "next";
import { RemovePagesToolClient } from "@/app/remove-pages/RemovePagesToolClient";

export const metadata: Metadata = {
  title: "Eliminar páginas de un PDF",
  description:
    "Marca sobre las miniaturas las páginas que sobran, o escribe sus números, y descarga el PDF sin ellas. Sin subir el archivo a ningún servidor.",
  alternates: { canonical: "/remove-pages" },
};

export default function RemovePagesPage() {
  return <RemovePagesToolClient />;
}
