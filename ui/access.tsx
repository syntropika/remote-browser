/** The optional Access extension protects the dashboard, independently of agent keys. */
import { Button, Chip, Input, Spinner } from "@heroui/react";
import { useEffect, useRef, useState } from "react";

import { api, failure } from "./api.js";
import { asyncHandler, background } from "./async-boundary.js";
import { Icon } from "./icons.js";
import type { NativeExtension } from "./native-extensions.js";
import { FormRow, Group, Row } from "./rows.js";
import { flag, record } from "./wire.js";

export function AccessSettings({
  entry,
  onSaved,
}: {
  entry: NativeExtension;
  onSaved: () => Promise<void>;
}) {
  const [username, setUsername] = useState(entry.username);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const working = useRef(false);

  return (
    <>
      <Group
        description="A login for people opening this browser. MCP clients continue using their own API keys."
        title="Browser login"
      >
        <Row
          description={
            entry.configured
              ? "A username and password are saved."
              : "Set up a login before enabling Access."
          }
          title="Protection"
        >
          <Chip variant="soft">{entry.enabled ? "Enabled" : "Disabled"}</Chip>
        </Row>
        <form
          onSubmit={asyncHandler(async (event: { preventDefault: () => void }) => {
            event.preventDefault();
            if (working.current) {
              return;
            }
            if (password !== confirmation) {
              setError("The passwords do not match.");
              return;
            }
            working.current = true;
            setBusy(true);
            setError("");
            setSaved("");
            try {
              await api("/api/extensions/access/configure", { username, password });
              setPassword("");
              setConfirmation("");
              setSaved("Browser login saved and enabled.");
              await onSaved();
            } catch (cause) {
              setError(failure(cause).message);
            } finally {
              working.current = false;
              setBusy(false);
            }
          })}
        >
          <FormRow title="Username">
            <Input
              aria-label="Browser username"
              autoComplete="username"
              disabled={busy}
              maxLength={64}
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </FormRow>
          <FormRow
            description="At least 12 characters. Updating the password signs out other browser sessions."
            title={entry.configured ? "New password" : "Password"}
          >
            <Input
              aria-label="Browser password"
              autoComplete="new-password"
              disabled={busy}
              minLength={12}
              maxLength={1024}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </FormRow>
          <FormRow title="Confirm password">
            <Input
              aria-label="Confirm browser password"
              autoComplete="new-password"
              disabled={busy}
              minLength={12}
              maxLength={1024}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              type="password"
              value={confirmation}
            />
          </FormRow>
          <div className="flex flex-wrap items-center justify-end gap-3 px-6 py-4">
            {busy ? <Spinner size="sm" /> : null}
            <Button isDisabled={busy} type="submit" variant="primary">
              Save and enable login
            </Button>
          </div>
        </form>
      </Group>
      {error ? (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-ink-dim text-sm" role="status">
          {saved}
        </p>
      ) : null}
      {entry.enabled ? (
        <Group title="This browser session">
          <Row
            description="Sign out here. Website sessions inside the browser remain saved."
            title="Sign out"
          >
            <Button
              isDisabled={busy}
              onPress={() =>
                background(
                  (async () => {
                    try {
                      await api("/api/access/logout", {});
                      location.reload();
                    } catch (cause) {
                      setError(failure(cause).message);
                    }
                  })(),
                )
              }
              size="sm"
              variant="secondary"
            >
              Sign out
            </Button>
          </Row>
        </Group>
      ) : null}
    </>
  );
}

export function BrowserLogin({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [required, setRequired] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  useEffect(() => {
    let mounted = true;
    background(
      (async () => {
        try {
          const value = record(await api("/api/access/status"));
          if (mounted) {
            setRequired(flag(value.required) && !flag(value.authenticated));
          }
        } catch (cause) {
          if (mounted) {
            setError(failure(cause).message);
          }
        }
      })(),
    );
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <main className="bg-page grid min-h-dvh place-items-center px-6 py-8">
      <section aria-labelledby="login-title" className="flex w-full max-w-96 flex-col gap-5">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <Icon name="window" /> Remote Browser
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" id="login-title">
            {required ? "Sign in to this browser" : "Connect to this browser"}
          </h1>
          <p className="text-ink-dim mt-2 text-sm">
            {required
              ? "Access protects this browser with a username and password."
              : "Check that the browser is running, then try again."}
          </p>
        </div>
        {required ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={asyncHandler(async (event: { preventDefault: () => void }) => {
              event.preventDefault();
              if (working.current) {
                return;
              }
              working.current = true;
              setBusy(true);
              setError("");
              try {
                await api("/api/access/login", { username, password });
                setPassword("");
                await onSignedIn();
              } catch (cause) {
                setError(failure(cause).message);
              } finally {
                working.current = false;
                setBusy(false);
              }
            })}
          >
            <label className="flex flex-col gap-2 text-sm">
              Username
              <Input
                aria-label="Username"
                autoComplete="username"
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
                required
                value={username}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm">
              Password
              <Input
                aria-label="Password"
                autoComplete="current-password"
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            <Button isDisabled={busy} type="submit" variant="primary">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <Button onPress={() => location.reload()} variant="secondary">
            Try again
          </Button>
        )}
        {error ? (
          <p className="text-danger text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
