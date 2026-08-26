import type { Metadata } from "next";
import { Geist, Geist_Mono, BioRhyme } from "next/font/google";
import "./globals.css";

const bioRhyme = BioRhyme({
  variable: "--font-bio-rhyme",
  subsets: ["latin"],
})

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenWorld — 3D Earth",
  description: "An interactive 3D view of the Earth built with CesiumJS.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bioRhyme.variable} ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
