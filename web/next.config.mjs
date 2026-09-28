/**
 * Next configuration.
 *
 * `output: "standalone"` is what makes the Docker image small: Next traces the modules the build
 * actually reaches and copies only those, so the runtime stage needs no `node_modules` install and
 * no dev dependencies.
 *
 * The API base URL is read at *runtime* from `window.__PLATFORM_CONFIG__` rather than inlined at
 * build time by `NEXT_PUBLIC_`. Inlining means one image per environment, which defeats the point
 * of building an image once and promoting it through staging to production. See
 * `src/lib/runtime-config.ts`.
 */
const config = {
  output: "standalone",
  reactStrictMode: true,
  // The Server header says nothing useful to a client and names the framework to an attacker.
  poweredByHeader: false,
};

export default config;
