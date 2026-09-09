import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      boxShadow: {
        panel: "0 8px 30px rgb(15 23 42 / 0.08)",
      },
      colors: {
        ink: {
          50: "#f6f8fb",
          100: "#edf1f6",
          500: "#4c5d75",
          700: "#27364b",
          900: "#142033",
        },
        ngo: {
          50: "#effaf5",
          100: "#d8f3e5",
          500: "#167a57",
          600: "#106747",
          700: "#0a5038",
        },
      },
    },
  },
  plugins: [],
};

export default config;
