import type { Metadata, Viewport } from "next";
import "./globals.css";
import { publicEnv } from "@/lib/env";

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.siteUrl),
  title: { default: "FACE CARD", template: "%s · FACE CARD" },
  description: "Your face. Your choices. Your movie. An interactive AI film where you are the main character.",
  openGraph: {
    title: "FACE CARD",
    description: "You're not watching the movie. You are the movie.",
    siteName: "FACE CARD",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "FACE CARD", description: "Your face. Your choices. Your movie." },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "FACE CARD" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
