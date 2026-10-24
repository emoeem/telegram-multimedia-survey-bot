import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Durable Object classes extend the workerd-provided base class; vitest
      // has no workerd runtime, so tests use a minimal stand-in.
      "cloudflare:workers": new URL("./tests/helpers/cloudflare-workers.stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "qa/**"],
  },
});
