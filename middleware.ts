import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "ngo_gateway_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public admin login page and its assets should always be accessible.
  if (pathname === "/admin/login") {
    // If already has session cookie, redirect to overview to avoid login loop.
    // Actual verification happens server-side in layout; this is just a UX shortcut.
    if (request.cookies.has(SESSION_COOKIE_NAME)) {
      const next = request.nextUrl.searchParams.get("next");
      if (next && next.startsWith("/admin") && next !== "/admin/login") {
        return NextResponse.redirect(new URL(next, request.url));
      }
    }
    return NextResponse.next();
  }

  // Protect all other /admin routes: require session cookie existence.
  // Full verification (signature, expiry, revocation) happens in server components and API routes.
  if (pathname.startsWith("/admin") && !request.cookies.has(SESSION_COOKIE_NAME)) {
    const login = new URL("/admin/login", request.url);
    // Preserve original destination for post-login redirect, but avoid open redirect.
    if (pathname !== "/admin") {
      login.searchParams.set("next", pathname + request.nextUrl.search);
    }
    return NextResponse.redirect(login);
  }

  // For API routes, add security headers and allow request to proceed to route handlers
  // which enforce auth via requireAdminRequest / verifySessionCookie.
  const response = NextResponse.next();
  // Add request ID for tracing if not already present.
  if (!request.headers.get("x-request-id")) {
    response.headers.set("X-Request-Id", crypto.randomUUID());
  }
  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
