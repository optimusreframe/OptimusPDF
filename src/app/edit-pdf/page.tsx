import type { Metadata } from "next";
import { EditToolClient } from "@/app/edit-pdf/EditToolClient";

export const metadata: Metadata = {
  title: "Editar PDF",
  description:
    "Añade texto, imágenes, formas, líneas y resaltados sobre las páginas de tu PDF sin rasterizar el original. Todo ocurre en tu navegador.",
  alternates: { canonical: "/edit-pdf" },
};

export default function EditPdfPage() {
  return <EditToolClient />;
}
