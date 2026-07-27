import type { Metadata, Viewport } from "next";
import { Caveat, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/layout/Providers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { MobileTabBar } from "@/components/layout/MobileTabBar";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

/** Cursiva manuscrita para firmas (la consume /sign-pdf). */
const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://optimuspdf.app"),
  title: {
    default: "OptimusPDF — Todas las herramientas PDF. Cero subidas.",
    template: "%s · OptimusPDF",
  },
  description:
    "Suite completa de herramientas PDF que se ejecuta entera en tu navegador: unir, dividir, comprimir, convertir, firmar y proteger sin subir un solo archivo.",
  applicationName: "OptimusPDF",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "OptimusPDF",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    siteName: "OptimusPDF",
    title: "OptimusPDF — Todas las herramientas PDF. Cero subidas.",
    description:
      "Procesa tus PDF sin que salgan del dispositivo. Sin cuentas, sin servidores, sin límites diarios.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    // Deben coincidir con --color-background de cada tema en globals.css.
    { media: "(prefers-color-scheme: light)", color: "#f5f5f5" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${inter.variable} ${jetbrainsMono.variable} ${caveat.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-background text-foreground antialiased">
        <Providers>
          <Header />
          <main id="content" className="flex-1">
            {children}
          </main>
          <Footer />
          {/* Reserva del alto de la tab bar fija en movil. */}
          <div
            aria-hidden="true"
            className="md:hidden"
            style={{ height: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
          />
          <MobileTabBar />
        </Providers>
      </body>
    </html>
  );
}
