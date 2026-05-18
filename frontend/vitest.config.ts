import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Mock import.meta.env.PROD in tests
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
  },
});
