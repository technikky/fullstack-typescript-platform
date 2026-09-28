/**
 * Runtime configuration, not build-time.
 *
 * `NEXT_PUBLIC_API_URL` is inlined into the bundle at build time, which means one image per
 * environment: staging and production need separate builds of identical code, and the artefact that
 * was tested is not the artefact that ships. That defeats build-once-promote-everywhere.
 *
 * So the values are read at runtime from `window.__PLATFORM_CONFIG__`, injected by the layout from
 * the server's environment. The same image runs anywhere; only the injected script differs.
 *
 * It is not a secret store. Everything here is visible to the browser, so it holds URLs and feature
 * flags and nothing else -- a "secret" delivered to a browser is not a secret, whichever mechanism
 * delivers it.
 */

export interface RuntimeConfig {
  readonly apiUrl: string;
  readonly wsUrl: string;
}

declare global {
  interface Window {
    __PLATFORM_CONFIG__?: Partial<RuntimeConfig>;
  }
}

const DEFAULTS: RuntimeConfig = {
  apiUrl: "http://localhost:4000",
  wsUrl: "ws://localhost:4000/ws",
};

/**
 * Derive the WebSocket URL from the API URL when it was not given separately.
 *
 * They share a port by design -- the platform serves both from one server -- so deriving is right by
 * default and configuring both separately is the exception, for a deployment that terminates them
 * differently.
 */
export const deriveWsUrl = (apiUrl: string): string => {
  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // A path on the API base is replaced, not appended to: `/api` + `/ws` would be `/api/ws`,
    // which is not where the upgrade is routed.
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return DEFAULTS.wsUrl;
  }
};

export const readRuntimeConfig = (
  source: Partial<RuntimeConfig> | undefined = typeof window === "undefined"
    ? undefined
    : window.__PLATFORM_CONFIG__,
): RuntimeConfig => {
  const apiUrl =
    typeof source?.apiUrl === "string" && source.apiUrl.length > 0 ? source.apiUrl : DEFAULTS.apiUrl;
  const wsUrl =
    typeof source?.wsUrl === "string" && source.wsUrl.length > 0 ? source.wsUrl : deriveWsUrl(apiUrl);
  return { apiUrl, wsUrl };
};

/**
 * The script tag the layout renders.
 *
 * `JSON.stringify` twice: once for the object, once to produce a JavaScript *string literal* that is
 * then parsed at runtime. That handles quoting -- but **not** the thing that actually matters here,
 * and a test in `tests/panel.test.tsx` caught the gap.
 *
 * An HTML parser does not understand JavaScript strings. A closing-script sequence inside a script
 * body terminates the element regardless of the quoting around it, so double-encoding alone leaves a
 * configuration value able to close the tag and open a new one. `\u003C` is a JavaScript escape the
 * JS parser resolves back to `<`, so the value arrives unchanged while the HTML parser never sees a
 * `<` at all.
 *
 * U+2028 and U+2029 are escaped for a different reason: they are line terminators in JavaScript but
 * legal literal characters in JSON, so an unescaped one is a syntax error in the emitted script
 * rather than a security problem.
 */
export const runtimeConfigScript = (config: RuntimeConfig): string => {
  const encoded = JSON.stringify(JSON.stringify(config))
    .replace(/</g, "\\u003C")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__PLATFORM_CONFIG__ = JSON.parse(${encoded});`;
};

/** Read the deployment's values from the server environment, for the layout to inject. */
export const runtimeConfigFromEnv = (env: Record<string, string | undefined>): RuntimeConfig => {
  const apiUrl = env["PLATFORM_API_URL"] ?? DEFAULTS.apiUrl;
  return { apiUrl, wsUrl: env["PLATFORM_WS_URL"] ?? deriveWsUrl(apiUrl) };
};
