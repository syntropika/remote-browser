/** The keys agents connect with: one per client, each scoped to the sessions it may use. */
import { Alert, Button, Input, Label, Radio, RadioGroup } from "@heroui/react";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useState } from "react";

import { api, failure } from "./api.js";
import { asyncHandler, background } from "./async-boundary.js";
import { Icon } from "./icons.js";
import type { Profile } from "./model.js";
import { FormRow, Group, Row } from "./rows.js";
import { flag, list, optionalText, record, text } from "./wire.js";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  legacy: boolean;
  /** The sessions this key may use, or null for every session including future ones. */
  profileIds: string[] | null;
};

function readKey(value: unknown): ApiKey {
  const key = record(value);
  const scope = key.profileIds;
  return {
    id: text(key.id),
    name: text(key.name),
    prefix: text(key.prefix),
    createdAt: text(key.createdAt),
    lastUsedAt: optionalText(key.lastUsedAt),
    legacy: flag(key.legacy),
    profileIds: Array.isArray(scope) ? scope.map((id) => text(id)) : null,
  };
}

function when(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/** One choice in a session-access group. HeroUI composes a radio from its own parts, and a
    bare `<Radio>` renders its label with no control at all. */
function Choice({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Radio value={value}>
      <Radio.Content>
        <Radio.Control>
          <Radio.Indicator />
        </Radio.Control>
        <Label>{children}</Label>
      </Radio.Content>
    </Radio>
  );
}

export function Keys({ profiles, endpoint }: { profiles: Profile[]; endpoint: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  /** The session this key may reach, or "" for every session. */
  const [scope, setScope] = useState("");
  /** The key whose access is being changed, while its choice is open. */
  const [scoping, setScoping] = useState("");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState("");

  const load = useCallback(async () => {
    setKeys(list(record(await api("/api/keys")).keys).map(readKey));
  }, []);

  useEffect(() => {
    background(
      load().catch((cause: unknown) => {
        setError(failure(cause).message);
      }),
    );
  }, [load]);

  const work = (task: () => Promise<void>) =>
    asyncHandler(async () => {
      if (busy) {
        return;
      }
      setBusy(true);
      setError("");
      try {
        await task();
      } catch (cause) {
        setError(failure(cause).message);
      } finally {
        setBusy(false);
      }
    });

  const copy = (value: string, what: string) =>
    asyncHandler(async () => {
      try {
        await navigator.clipboard.writeText(value);
        setNote(`${what} copied.`);
      } catch {
        setNote(`Select the ${what.toLowerCase()} and copy it with your device.`);
      }
    });

  const named = (id: string) => profiles.find((profile) => profile.id === id)?.name || id;
  const scopeOf = (key: ApiKey) =>
    key.profileIds === null
      ? "Every session, including ones created later"
      : key.profileIds.map(named).join(", ") || "No sessions";

  return (
    <>
      <Group
        description="Streamable HTTP with the header Authorization: Bearer <API_KEY>."
        title="Connect over MCP"
      >
        <FormRow description="The address an agent connects to" title="Server URL">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input aria-label="Server URL" className="min-w-0 flex-1" readOnly value={endpoint} />
            <Button onPress={copy(endpoint, "Server URL")} size="sm" variant="secondary">
              Copy
            </Button>
          </div>
        </FormRow>
      </Group>

      <Group
        description="Give each client its own key, so you can revoke one without touching the rest."
        title="Create a key"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            work(async () => {
              const created = record(
                await api("/api/keys", {
                  name,
                  ...(scope ? { profileIds: [scope] } : {}),
                }),
              );
              setSecret(text(created.secret));
              setName("");
              setNote("Key created. Copy it before leaving this page.");
              await load();
            })();
          }}
        >
          <FormRow description="How you will recognise this client" title="Key name">
            <Input
              aria-label="Key name"
              className="w-full"
              maxLength={64}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="e.g. Work laptop"
              value={name}
            />
          </FormRow>
          <FormRow
            description="A key reaches every session, or one of them, and the websites it is signed in to."
            title="Session access"
          >
            <RadioGroup
              aria-label="Session access"
              onChange={(value) => {
                setScope(value);
              }}
              value={scope}
            >
              <Choice value="">Every session, including ones created later</Choice>
              {profiles.map((profile) => (
                <Choice key={profile.id} value={profile.id}>
                  Only {profile.name}
                </Choice>
              ))}
            </RadioGroup>
          </FormRow>
          <Row description={note || error || "The key is shown once."} title="Create">
            <Button isDisabled={busy || !name.trim()} type="submit" variant="primary">
              <Icon name="plus" />
              Create key
            </Button>
          </Row>
        </form>
      </Group>

      {secret ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Your key is ready</Alert.Title>
            <Alert.Description>
              Copy it now; it is not shown again.
              <span className="mt-2 flex items-center gap-2">
                <Input aria-label="New API key" className="font-mono" readOnly value={secret} />
                <Button onPress={copy(secret, "API key")} size="sm" variant="secondary">
                  Copy
                </Button>
                <Button
                  onPress={() => {
                    setSecret("");
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Done
                </Button>
              </span>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Group
        description="Revoking a key stops new requests at once. An action already running may finish."
        title={`Active keys${keys.length ? ` (${keys.length})` : ""}`}
      >
        {keys.length === 0 ? (
          <Row description="Create one above to connect your first agent." title="None yet" />
        ) : null}
        {keys.map((key) => (
          <Fragment key={key.id}>
            <Row
              description={`${key.prefix}… · created ${when(key.createdAt)} · last used ${when(
                key.lastUsedAt,
              )} · ${scopeOf(key)}`}
              title={key.name}
            >
              <Button
                onPress={() => {
                  setScoping(scoping === key.id ? "" : key.id);
                }}
                size="sm"
                variant="secondary"
              >
                {scoping === key.id ? "Keep as it is" : "Change access"}
              </Button>
              <Button
                onPress={
                  armed === key.id
                    ? work(async () => {
                        await api("/api/keys/revoke", { id: key.id });
                        setArmed("");
                        await load();
                      })
                    : () => {
                        setArmed(key.id);
                      }
                }
                size="sm"
                variant={armed === key.id ? "danger" : "danger-soft"}
              >
                {armed === key.id ? "Confirm revoke" : "Revoke"}
              </Button>
            </Row>
            {scoping === key.id ? (
              <FormRow
                description="Choosing applies at once; requests already running are unaffected."
                title={`Sessions for ${key.name}`}
              >
                <RadioGroup
                  aria-label={`Sessions for ${key.name}`}
                  onChange={(value) => {
                    work(async () => {
                      await api("/api/keys/permissions", {
                        id: key.id,
                        profileIds: value ? [value] : null,
                      });
                      setScoping("");
                      await load();
                    })();
                  }}
                  value={key.profileIds?.[0] ?? ""}
                >
                  <Choice value="">Every session, including ones created later</Choice>
                  {profiles.map((profile) => (
                    <Choice key={profile.id} value={profile.id}>
                      Only {profile.name}
                    </Choice>
                  ))}
                </RadioGroup>
              </FormRow>
            ) : null}
          </Fragment>
        ))}
      </Group>

      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </>
  );
}
