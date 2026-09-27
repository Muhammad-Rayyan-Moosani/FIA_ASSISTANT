import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { IntroSplash } from "@/components/intro/IntroSplash";
import { INTRO_COOKIE } from "@/lib/intro";
import { THEME_COOKIE } from "@/store/themeStore";
import { Providers } from "./providers";
import "./globals.css";

const display = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700", "800"], style: ["normal", "italic"], variable: "--font-barlow", display: "swap" });
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Circuit Guard", template: "%s · Circuit Guard" },
  description: "Circuit Guard: find where a race track is dangerous from its own incident data, and what to do about it."
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0f" },
    { media: "(prefers-color-scheme: light)", color: "#f3f4f6" },
  ],
  colorScheme: "dark light",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The theme is a cookie so the server renders the right one: no flash, no inline script.
  const jar = await cookies();
  const theme = jar.get(THEME_COOKIE)?.value === "day" ? "light" : "dark";
  // the intro plays once per browser session; the cookie keeps it from flashing on later pages
  const introSeen = jar.get(INTRO_COOKIE)?.value === "1";
  return (
    <html lang="en" data-theme={theme} className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
        {!introSeen && <IntroSplash />}
      </body>
    </html>
  );
}
