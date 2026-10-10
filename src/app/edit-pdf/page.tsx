import type { Metadata } from "next";
import { EditToolClient } from "@/app/edit-pdf/EditToolClient";

export const metadata: Metadata = {
  title: "Editar PDF",
  description:
    "Edita el texto que ya trae tu PDF y añade texto, imágenes y formas directamente sobre el documento. Todo ocurre en tu navegador; los escaneados solo admiten añadir contenido.",
  alternates: { canonical: "/edit-pdf" },
};

export default function EditPdfPage() {
  return <EditToolClient />;
}
