import type { Metadata } from "next";
import localFont from "next/font/local";
import "@/app/globals.css";
import { Providers } from "@/components/providers";

// Self-hosted variable fonts (OFL licensed, see src/fonts/OFL-*.txt) so builds
// and page loads never depend on external font CDNs.
const sans = localFont({
  src: "../fonts/Inter-Variable.ttf",
  variable: "--font-sans",
  display: "swap",
  weight: "100 900",
});
const mono = localFont({
  src: "../fonts/JetBrainsMono-Variable.ttf",
  variable: "--font-mono",
  display: "swap",
  weight: "100 800",
});

export const metadata: Metadata = {
  title: { default: "NGO File Cloud", template: "%s | NGO File Cloud" },
  description: "Secure private cloud control panel for managing NGO documents.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Apply the saved theme before first paint to avoid a flash.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("nfc-theme")||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`,
          }}
        />
      </head>
      <body className={`${sans.variable} ${mono.variable} font-sans`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
