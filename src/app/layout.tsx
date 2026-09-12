import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { Toaster } from "@/components/ui/sonner";
import { ClerkClientProvider } from "@/components/clerk-client-provider";

import "./globals.css";

/**
 * Root layout — the single place app-wide client providers are mounted.
 *
 * Provider order matters:
 * - `NuqsAdapter` wraps everything so any component may read/write URL
 *   search params (the home search box) inside server components.
 * - `ClerkClientProvider` gates the tree on authentication: Clerk owns
 *   identity, while Concord's own server layer owns authorization.
 * - `Toaster` mounts last so sonner toasts (used by actions like rename /
 *   delete / template create) render above the gated tree.
 */

/** Single Inter instance shared by every route in the app. */
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

export default function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;

  // The provider stack is fixed (see the header comment); toast mounting
  // inside the auth gate keeps it available to all gated UI.
  const appTree = (
    <ClerkClientProvider>
      <Toaster />
      {children}
    </ClerkClientProvider>
  );

  return (
    <html lang="en">
      <body className={inter.className}>
        <NuqsAdapter>{appTree}</NuqsAdapter>
      </body>
    </html>
  );
}
