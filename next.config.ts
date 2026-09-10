import type { NextConfig } from "next";

// Vercel Blob object hosts (private stores included) + Firebase Auth endpoints.
//
// CRITICAL for direct-to-storage uploads: the @vercel/blob client
// (`upload`/`uploadPresigned`) does NOT upload to *.blob.vercel-storage.com —
// it PUTs to the Blob control-plane API at https://vercel.com/api/blob.
// If "https://vercel.com" is missing from connect-src, the browser blocks the
// PUT (TypeError "Failed to fetch") and the SDK retries with exponential
// backoff for ~17 minutes, which surfaces as "Uploading… 0%" forever.
const connectSources = [
  "'self'",
  "https://vercel.com",
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://www.googleapis.com",
  "https://*.blob.vercel-storage.com",
  "https://blob.vercel-storage.com",
].join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next injects bootstrap scripts/styles; a nonce-based CSP can be added at the proxy later.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSources}${process.env.NODE_ENV !== "production" ? " ws: wss:" : ""}`,
  // PDF preview renders authorized, short-lived Blob URLs inside the app shell.
  "frame-src 'self' https://*.blob.vercel-storage.com https://blob.vercel-storage.com blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      ],
    }];
  },
};

export default nextConfig;
