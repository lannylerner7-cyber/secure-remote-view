// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { readFile } from "node:fs/promises";

export default defineConfig({
  vite: {
    plugins: [{
      name: "isolated-session-tools-test-page",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split("?")[0] !== "/tests/session-tools-fixture.html") return next();
          try {
            const html = await readFile(new URL("./tests/session-tools-fixture.html", import.meta.url), "utf8");
            response.setHeader("Content-Type", "text/html");
            response.setHeader("Cache-Control", "no-store");
            response.end(await server.transformIndexHtml(request.url,html));
          } catch (error) { next(error); }
        });
      },
    }],
    server: {
      host: "0.0.0.0",
      port: Number(process.env.PORT || 3000),
      strictPort: true,
      allowedHosts: true,
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
