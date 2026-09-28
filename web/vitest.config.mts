import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Layout and page shells are Next plumbing: they compose the components below and are
      // covered by the component tests plus `next build`, which type-checks them for real.
      exclude: ["src/app/layout.tsx", "src/app/**/page.tsx"],
      reporter: ["text", "json-summary"],
    },
  },
});
