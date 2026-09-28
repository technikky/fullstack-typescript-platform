"use client";

/**
 * The single page: sign in, then the workspace shell.
 *
 * The session is restored by *asking the server*, not by trusting what is in storage. A stored
 * refresh token may have been revoked -- by a logout elsewhere, a password change, or reuse detection
 * -- and the only way to find out is to try. So the page calls `/api/auth/me`, which triggers the
 * client's refresh-and-retry, and treats a failure as "not signed in".
 */

import { useEffect, useMemo, useState } from "react";

import { ApiClient, browserTokenStore, type User } from "@/lib/api";
import { readRuntimeConfig } from "@/lib/runtime-config";
import { SignInForm } from "@/components/SignInForm";
import { WorkspacePanel } from "@/components/WorkspacePanel";

export default function Page(): React.JSX.Element {
  const config = useMemo(() => readRuntimeConfig(), []);
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: config.apiUrl,
        store: browserTokenStore(),
        onUnauthenticated: () => setUser(null),
      }),
    [config.apiUrl],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!client.isAuthenticated) {
        if (!cancelled) setRestoring(false);
        return;
      }
      try {
        const restored = await client.me();
        if (!cancelled) setUser(restored);
      } catch {
        // A stored token that no longer works is not an error worth showing: it means signed out.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => void (cancelled = true);
  }, [client]);

  if (restoring) return <p role="status">Restoring your session…</p>;

  if (user === null) return <SignInForm client={client} onSignedIn={setUser} />;

  return (
    <WorkspacePanel
      client={client}
      user={user}
      wsUrl={config.wsUrl}
      onSignOut={() => {
        void client.logout().finally(() => setUser(null));
      }}
    />
  );
}
