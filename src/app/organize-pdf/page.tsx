import type { Metadata } from "next";
import { OrganizeToolClient } from "@/app/organize-pdf/OrganizeToolClient";

export const metadata: Metadata = {
  title: "Organizar PDF",
  description:
    "Reordena, gira y elimina páginas de un PDF arrastrando sus miniaturas. Todo ocurre en tu navegador: el archivo no se sube a ningún servidor.",
  alternates: { canonical: "/organize-pdf" },
};

export default function OrganizePdfPage() {
  return <OrganizeToolClient />;
}
