"use client";

import { SignIn, useAuth } from "@clerk/nextjs";
import { ReactNode } from "react";

import { DocumentLoadingIndicator } from "./loading-indicator";

/**
 * Identity provider boundary: Clerk owns authentication. Data access is
 * performed by server components/actions against Concord's PostgreSQL layer —
 * there is no third-party data-plane client in the browser.
 */

export function SignInGate() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-8rem)] py-16">
      <SignIn routing="hash" />
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) {
    return <DocumentLoadingIndicator label="Restoring session…" />;
  }
  if (!isSignedIn) {
    return <SignInGate />;
  }
  return <>{children}</>;
}

/**
 * Client-only authentication gate beneath the server-rendered ClerkProvider.
 * The provider itself lives in app/layout.tsx so Clerk can receive the
 * per-request CSP nonce while rendering its script tags.
 */
export function ClerkAuthGate({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
