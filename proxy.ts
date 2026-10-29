import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Only the product (after-login) routes are gated. The marketing landing,
// sign-in, and sign-up stay public.
const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/memory(.*)",
  "/agents(.*)",
  "/access(.*)",
  "/audit(.*)",
  "/billing(.*)",
  "/integrations(.*)",
  "/settings(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // These exact public metadata endpoints need no session. Keep all API
    // and workspace paths on the existing authentication path.
    "/((?!robots\\.txt$|sitemap\\.xml$|opengraph-image$|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
