"use client";

import { ClerkProvider, SignIn, useAuth } from "@clerk/nextjs";
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

export function ClerkClientProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!}>
      <AuthGate>
        {children}
      </AuthGate>
    </ClerkProvider>
  );
}
