import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { AppProviders } from "@/app/components/providers";
import { NavigationProgress } from "@/app/components/ui/navigation-progress";

export const metadata: Metadata = {
  title: "Audit Sessions",
  description: "Audit session dashboard",
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
      className="font-sans"
      data-scroll-behavior="smooth"
    >
      <body>
        <AppProviders>
          <Suspense fallback={null}>
            <NavigationProgress />
          </Suspense>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
