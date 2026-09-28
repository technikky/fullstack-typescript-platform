"use client";

/**
 * Sign in or register.
 *
 * The server gives one message for a wrong password and an unknown address, deliberately, so this
 * form shows whatever it was told rather than trying to be more helpful. "No account with that
 * email" would undo the server's work: the form would become a membership oracle.
 *
 * The submit button is disabled while a request is in flight. That is not only cosmetic -- registering
 * and logging in are rate-limited far more tightly than the rest of the API, so a double-submitted
 * form burns two of a small budget.
 */

import { useState } from "react";

import { ApiError, type ApiClient, type User } from "@/lib/api";

export interface SignInFormProps {
  readonly client: ApiClient;
  readonly onSignedIn: (user: User) => void;
}

type Mode = "signin" | "register";

export const SignInForm = ({ client, onSignedIn }: SignInFormProps): React.JSX.Element => {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const result =
        mode === "signin"
          ? await client.login(email, password)
          : await client.register({ email, name, password });
      onSignedIn(result.user);
    } catch (thrown) {
      // Shown verbatim. The server already decided how much to reveal.
      setError(thrown instanceof ApiError ? thrown.message : "could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="signin" aria-labelledby="signin-heading">
      <h1 id="signin-heading">{mode === "signin" ? "Sign in" : "Create an account"}</h1>

      {error !== null && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={busy}
      />

      {mode === "register" && (
        <>
          <label htmlFor="name">Name</label>
          <input
            id="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </>
      )}

      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        // `new-password` on the register form so a password manager offers to generate one, and
        // `current-password` on sign-in so it offers the saved one. Getting this backwards is why
        // managers sometimes fail to fill a form.
        autoComplete={mode === "register" ? "new-password" : "current-password"}
        required
        minLength={mode === "register" ? 12 : undefined}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={busy}
      />
      {mode === "register" && (
        <p className="muted">At least 12 characters. Length is the only requirement.</p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
      </button>

      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(mode === "signin" ? "register" : "signin");
          setError(null);
        }}
        disabled={busy}
      >
        {mode === "signin" ? "Create an account instead" : "I already have an account"}
      </button>
    </form>
  );
};
