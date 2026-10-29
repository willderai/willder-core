import type { Metadata } from "next";
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "@/lib/site-metadata";
import { Fraunces, Manrope, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { PostHogProvider } from "@/components/posthog-provider";
import { GrainBackground } from "@/components/grain-background";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  icons: {
    icon: "/logo.svg",
    apple: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fraunces.variable} ${manrope.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <GrainBackground />
        <PostHogProvider>
          <ThemeProvider>
            {/* ClerkProvider now lives in the route groups that actually need
              it ((app), (auth)) instead of wrapping every route here -- the
              marketing pages ship no Clerk SDK on first paint. See
              components/marketing-auth-nav.tsx for their own lazy auth
              widget. */}
            {children}
          </ThemeProvider>
        </PostHogProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
