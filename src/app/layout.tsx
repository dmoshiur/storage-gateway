import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: { default: "AM Storage Company", template: "%s | AM Storage Company" },
  description: "Private administrative PDF storage gateway.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
