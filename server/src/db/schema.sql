-- Schema for the platform.
--
-- Written as SQL rather than generated from an ORM, because several of the guarantees this
-- platform makes are constraints rather than code. A check that lives in the application can
-- be bypassed by the next caller; a check that lives here cannot.
--
-- The ones worth reading for:
--
--   * `memberships` is keyed on (workspace_id, user_id), so a user cannot hold two roles in
--     one workspace. The "which role wins" bug is not possible.
--   * `items.version` starts at 1 and every update carries `where version = $expected`, which
--     is optimistic concurrency enforced by the database rather than by a read-then-write in
--     the application.
--   * `refresh_tokens.token_hash` is unique, and the row records `used_at`, `revoked_at` and
--     `replaced_by`. Reuse detection reads those columns; without them, a stolen refresh token
--     is indistinguishable from a legitimate one.
--   * every foreign key that represents containment cascades, so deleting a workspace cannot
--     leave orphaned boards that a later query happily returns.
--   * `citext` is deliberately NOT used: it is an extension, and a managed Postgres may not
--     have it. Emails are stored already-normalised, and a unique index on the stored value is
--     what makes that reliable. See `normaliseEmail`.

create table if not exists users (
  id            text        primary key,
  email         text        not null,
  name          text        not null check (length(trim(name)) between 1 and 200),
  password_hash text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Case-insensitive uniqueness without an extension. Emails are normalised before insert, so
-- this index is a second line of defence rather than the only one.
create unique index if not exists users_email_key on users (lower(email));

create table if not exists workspaces (
  id         text        primary key,
  name       text        not null check (length(trim(name)) between 1 and 200),
  slug       text        not null,
  created_by text        not null references users (id),
  created_at timestamptz not null default now()
);

create unique index if not exists workspaces_slug_key on workspaces (slug);

-- Roles are an enum-like check constraint rather than a Postgres enum type: adding a value to
-- a Postgres enum cannot be done inside a transaction on older versions, and dropping one is
-- not possible at all. A check constraint is alterable.
create table if not exists memberships (
  id           text        primary key,
  workspace_id text        not null references workspaces (id) on delete cascade,
  user_id      text        not null references users (id) on delete cascade,
  role         text        not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- One role per user per workspace. Without this, "what is my role here" has no answer.
  unique (workspace_id, user_id)
);

create index if not exists memberships_user_idx on memberships (user_id);

create table if not exists boards (
  id           text        primary key,
  workspace_id text        not null references workspaces (id) on delete cascade,
  name         text        not null check (length(trim(name)) between 1 and 200),
  created_by   text        not null references users (id),
  created_at   timestamptz not null default now()
);

create index if not exists boards_workspace_idx on boards (workspace_id, created_at);

create table if not exists items (
  id          text        primary key,
  board_id    text        not null references boards (id) on delete cascade,
  title       text        not null check (length(trim(title)) between 1 and 300),
  body        text        not null default '',
  status      text        not null default 'open' check (status in ('open', 'in_progress', 'blocked', 'done')),
  assignee_id text        references users (id) on delete set null,
  -- Optimistic concurrency. Every update matches on the expected value and increments.
  version     integer     not null default 1 check (version >= 1),
  created_by  text        not null references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists items_board_idx on items (board_id, created_at desc);
create index if not exists items_assignee_idx on items (assignee_id) where assignee_id is not null;

create table if not exists comments (
  id         text        primary key,
  item_id    text        not null references items (id) on delete cascade,
  author_id  text        not null references users (id) on delete cascade,
  body       text        not null check (length(trim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists comments_item_idx on comments (item_id, created_at);

-- Refresh tokens, stored hashed and grouped into families.
--
-- A family is one login. Rotation replaces a token with its successor in the same family. If a
-- token that has already been used is presented again, either the client replayed it or it was
-- stolen -- and the two are indistinguishable from here -- so the whole family is revoked.
-- That converts a stolen refresh token from indefinite access into one extra request.
create table if not exists refresh_tokens (
  id          text        primary key,
  family_id   text        not null,
  user_id     text        not null references users (id) on delete cascade,
  -- SHA-256 of the opaque token. The token itself is never stored: a database leak must not
  -- hand over working credentials.
  token_hash  text        not null unique,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  replaced_by text        references refresh_tokens (id) on delete set null
);

create index if not exists refresh_tokens_family_idx on refresh_tokens (family_id);
create index if not exists refresh_tokens_user_idx on refresh_tokens (user_id);
create index if not exists refresh_tokens_expiry_idx on refresh_tokens (expires_at);

-- Append-only. No update or delete path exists in the application, which is the only thing
-- that makes an audit trail worth having.
create table if not exists audit_log (
  id           text        primary key,
  workspace_id text        references workspaces (id) on delete cascade,
  actor_id     text        references users (id) on delete set null,
  action       text        not null,
  subject      text,
  metadata     jsonb       not null default '{}'::jsonb,
  at           timestamptz not null default now()
);

create index if not exists audit_log_workspace_idx on audit_log (workspace_id, at desc);
create index if not exists audit_log_actor_idx on audit_log (actor_id, at desc);
