import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { Toaster } from "@/components/ui/sonner";
import { ClerkClientProvider } from "@/components/clerk-client-provider";

import "./globals.css";
const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Concord",
  description: "Concord — collaborative documents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={inter.className}
      >
        <NuqsAdapter>
          <ClerkClientProvider>
            <Toaster />
            {children}
          </ClerkClientProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}
