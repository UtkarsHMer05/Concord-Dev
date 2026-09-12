import { DocumentLoadingIndicator } from "@/components/loading-indicator";

/**
 * Next.js streaming fallback for the document route: shown while the
 * server component resolves authz + the document DTO. Kept deliberate
 * (not a skeleton) so a slow load is distinguishable from a blank
 * canvas — the editor page itself must never render a writable
 * surface before authorization resolves.
 */
export default function DocumentLoadingPage() {
  return <DocumentLoadingIndicator label="Opening document…" />;
}
