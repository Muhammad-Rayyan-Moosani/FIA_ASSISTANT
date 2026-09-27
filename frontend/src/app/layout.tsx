import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { THEME_COOKIE } from "@/store/themeStore";
import { Providers } from "./providers";
import "./globals.css";

const display = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-barlow", display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-source-serif", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Circuit Guard", template: "%s · Circuit Guard" },
  description: "Circuit Guard: find where a race track is dangerous from its own incident data, and what to do about it."
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1f1e1d" },
    { media: "(prefers-color-scheme: light)", color: "#f5f4ed" },
  ],
  colorScheme: "dark light",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The theme is a cookie so the server renders the right one: no flash, no inline script.
  const theme = (await cookies()).get(THEME_COOKIE)?.value === "day" ? "light" : "dark";
  return (
    <html lang="en" data-theme={theme} className={`${display.variable} ${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
