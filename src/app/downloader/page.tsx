import type { Metadata } from "next";
import { ToolPageSoon } from "@/components/tool/ToolPageSoon";

export const metadata: Metadata = {
  title: "Downloader",
  description: "Downloader en OptimusPDF. Todavía no está disponible.",
  alternates: { canonical: "/downloader" },
};

export default function DownloaderPage() {
  return <ToolPageSoon slug="downloader" />;
}
