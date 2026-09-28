/**
 * The root layout.
 *
 * The one interesting thing here is the runtime-configuration script. `NEXT_PUBLIC_` variables are
 * inlined at build time, so using them would mean one image per environment -- and the artefact
 * promoted to production would not be the artefact that was tested in staging. Injecting the values
 * from the server's environment at request time keeps one image for every environment.
 *
 * `dangerouslySetInnerHTML` is required to emit a script body at all. The content is not user input,
 * and `runtimeConfigScript` double-encodes it so a closing-script sequence in a configuration value
 * cannot terminate the tag early.
 */

import type { Metadata } from "next";

import { runtimeConfigFromEnv, runtimeConfigScript } from "@/lib/runtime-config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Platform",
  description: "Workspaces, boards and items, with role-based access and live updates.",
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const config = runtimeConfigFromEnv(process.env);

  return (
    <html lang="en">
      <head>
        <script
          // Before the app bundle, so the client reads its configuration on first render rather
          // than falling back to a default and then correcting itself.
          dangerouslySetInnerHTML={{ __html: runtimeConfigScript(config) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
