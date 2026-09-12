import { clerkMiddleware } from "@clerk/nextjs/server";

// An exact origin is supplied by the cloud bundle. Keep local development
// compatible with its own Clerk instance until a local origin is configured.
const appOrigin = process.env.CONCORD_APP_ORIGIN;
if (appOrigin && new URL(appOrigin).origin !== appOrigin) {
  throw new Error("CONCORD_APP_ORIGIN must be an exact origin without a path or trailing slash");
}
export default clerkMiddleware(
  appOrigin ? { authorizedParties: [appOrigin] } : {},
);

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
    // Clerk's frontend API routes also require the middleware.
    '/__clerk/(.*)',
  ],
};
