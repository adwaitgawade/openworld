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
  title: "MERIDIAN — Watch",
  description:
    "Global sensor-fusion watch floor: live ADS-B and AIS on a 3D earth.",
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
