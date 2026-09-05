const authConfig = {
  providers: [
    {
      // Clerk Frontend API URL, provided via environment (dev + prod deployments).
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
