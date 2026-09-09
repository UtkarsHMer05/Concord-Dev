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
  title: {
    default: "Concord",
    template: "%s · Concord",
  },
  description:
    "Concord — a local-first collaborative document workspace: rich-text editing with durable offline editing.",
  applicationName: "Concord",
  openGraph: {
    title: "Concord",
    description:
      "A local-first collaborative document workspace. Edit rich-text documents with durable offline editing.",
    siteName: "Concord",
    type: "website",
  },
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
