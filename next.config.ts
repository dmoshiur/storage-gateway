import type { NextConfig } from "next";

const connectSources = [
  "'self'",
  "https://vercel.com",
  "https://*.blob.vercel-storage.com",
  "https://blob.vercel-storage.com",
].join(" ");

/**
 * Frame policy.
 *
 * Production default: the app must not be embedded (`frame-ancestors 'none'` +
 * `X-Frame-Options: DENY`). A hosting platform that renders the app inside an
 * iframe (a preview sandbox, for example) can opt in explicitly with
 * `FRAME_ANCESTORS=https://preview.example.com`; no production deployment sets
 * that variable, so the secure default is unchanged.
 */
const frameAncestors = process.env.FRAME_ANCESTORS?.trim() || "'none'";
const frameHeaders =
  frameAncestors === "'none'"
    ? [{ key: "X-Frame-Options", value: "DENY" }]
    : [{ key: "Content-Security-Policy-Report-Only", value: `frame-ancestors ${frameAncestors}` }];

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSources}${process.env.NODE_ENV !== "production" ? " ws: wss:" : ""}`,
  "frame-src 'self' https://*.blob.vercel-storage.com https://blob.vercel-storage.com blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${frameAncestors}`,
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep the libSQL native driver outside the serverless bundle so its
  // prebuilt binaries are traced correctly on Vercel.
  serverExternalPackages: ["@libsql/client", "libsql"],
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ...frameHeaders,
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      ],
    }];
  },
};

export default nextConfig;
