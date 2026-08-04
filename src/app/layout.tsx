import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Surveyor: Ask a group",
  description: "Describe a group and a question. Surveyor recruits real participants and reports what they say.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#eaf0f2",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
