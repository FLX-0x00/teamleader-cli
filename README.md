# teamleader-cli

A non-interactive command line client for the [Teamleader Focus API](https://developer.focus.teamleader.eu/docs/api).
Every API endpoint (292 actions across 68 resources) is available as a command, with the exact
parameters and types of the official API — generated from Teamleader's own
[OpenAPI specification](https://www.npmjs.com/package/@teamleader/focus-api-specification).

- **One-shot, like the API itself** — no TUI, no prompts (except `auth login`). Perfect for scripts and AI agents.
- **Safe mode by default** — destructive actions (`delete`, `bulk-delete`, …) refuse to run without `--rm`.
- **Tables for humans, `--json` for machines** — raw API responses on demand.
- **Schema-validated input** — types, enums and required fields are checked locally before any request is sent.

## TL;DR — the commands you'll actually use

```sh
tl auth login                                          # one-time OAuth setup (guided)

# search & find (most used)
tl contacts list --filter.term "james"                 # search contacts (name/email/phone)
tl companies list --filter.term "piedpiper"            # search companies
tl deals list --filter.phase_id <uuid> --sort weighted_value:desc
tl invoices list --filter.status booked --all          # --all = fetch every page

# look at one record
tl contacts info <uuid> --include custom_fields
tl companies info <uuid> --json                        # raw API JSON for scripting

# create & update
tl contacts add --first_name Jane --last_name Doe --emails.0.type primary --emails.0.email jane@x.eu
tl deals create --title "Big deal" --lead.customer.type company --lead.customer.id <uuid>
tl deals win <uuid>
tl tasks create --title "Follow up" --due_on 2026-07-01 --work_type_id <uuid>

# invoices & files
tl invoices download <uuid> --format pdf --output invoice.pdf

# delete (safe mode: nothing is deleted without --rm)
tl contacts delete <uuid> --rm

# discovery
tl --help                  # everything at a glance
tl deals                   # actions of a resource
tl deals create --help     # all parameters with types & examples
tl commands --json         # machine-readable spec of all 292 commands (for AI agents)
```

## Install

```sh
pnpm install
pnpm link --global   # makes `tl` (and `teamleader`) available everywhere
```

Requires Node.js ≥ 18.

## Authentication (one-time setup)

The Teamleader Focus API uses OAuth2. You need a free integration of your own:

1. Open <https://marketplace.focus.teamleader.eu/eu/en/build> and sign in.
2. Create a new integration (a private one is fine).
3. Add this **redirect URI** exactly: `http://localhost:41330/oauth/callback`
4. Select all **scopes** the CLI should be able to use.
5. Run:

```sh
tl auth login
```

The command walks you through these steps, asks for the client ID/secret, opens the
authorization page in your browser and catches the OAuth callback on localhost.
No browser on the machine? Use `tl auth login --manual` and paste the redirect URL
(or just its `code` parameter) into the terminal.

Tokens are stored in `~/.config/teamleader-cli/credentials.json` (mode 600) and the
access token refreshes automatically. Other auth commands: `tl auth status`,
`tl auth refresh`, `tl auth logout [--full]`.

Headless/CI use — environment overrides: `TEAMLEADER_CLIENT_ID`, `TEAMLEADER_CLIENT_SECRET`,
`TEAMLEADER_ACCESS_TOKEN`, `TEAMLEADER_REFRESH_TOKEN`, `TEAMLEADER_CLI_CONFIG`.

## Usage

```
tl <resource> <action> [id] [--param value ...] [flags]
```

```sh
tl contacts list --filter.term "james" --limit 5
tl companies info 5d2f4a0e-... --include custom_fields
tl deals create --title "Big deal" \
    --lead.customer.type company --lead.customer.id <uuid> \
    --estimated_value '{"amount":5000,"currency":"EUR"}'
tl invoices list --filter.status booked --sort invoice_date:desc --json
tl invoices download <uuid> --format pdf --output invoice.pdf
tl contacts delete <uuid> --rm        # destructive: --rm required
```

Discovering commands:

```sh
tl --help                       # all resources + global flags
tl invoices                     # actions of a resource
tl invoices draft --help        # every parameter with type, enum, required, example
tl commands                     # flat list of all 292 commands
tl commands --json              # machine-readable spec of every command and parameter
```

`tl contacts.list ...` (API path style) works too.

### Parameters

API parameters map 1:1 to dot-path flags — the body is assembled and validated
against the request schema of the endpoint:

| Input | Flag syntax |
| --- | --- |
| nested field | `--filter.term "Pied Piper"` |
| array of scalars | `--filter.tags expo --filter.tags vip` (repeat) |
| array of objects | `--sort.0.field name --sort.0.order desc` (numeric index) |
| any object/array as JSON | `--estimated_value '{"amount":100,"currency":"EUR"}'` |
| whole body | `--body '{...}'`, `--body @file.json`, `--body -` (stdin) |
| null (nullable fields) | `--field null` |

Dot flags override `--body`; values are coerced to the schema type (integer,
number, boolean, enum) and rejected locally when invalid.

### Global flags

| Flag | Effect |
| --- | --- |
| `--json` | print the raw API response |
| `--fields a,b.c` | choose table columns (dot paths into the response) |
| `--limit N` / `--page N` | shortcut for `--page.size` / `--page.number` |
| `--sort field[:asc\|desc]` | shortcut for `--sort.0.field` (repeatable) |
| `--include a,b` | shortcut for `--includes` (sideloads, e.g. `custom_fields`) |
| `--all` | follow pagination and fetch every page |
| `--rm` | required to run destructive actions (safe mode) |
| `--output FILE` | save the result of a `*.download` action to disk |
| `--file FILE` | upload a local file (`tl files upload ... --file x.pdf`) |
| `--dry-run` | print the request without sending it |
| `--verbose`, `-v` | log requests to stderr |

Tables and results go to **stdout**, notices/footers to **stderr** — safe for piping.
Exit codes: `0` success, `1` API/auth error, `2` usage error.
Rate limits (HTTP 429) are retried automatically; expired tokens refresh transparently.

### File transfer

```sh
tl files upload --name report.pdf --subject.type company --subject.id <uuid> --file ./report.pdf
tl files download <file-uuid> --output report.pdf
tl invoices download <uuid> --format ubl/peppol_bis_3 --output invoice.xml
```

## Updating to a new API version

The command registry (`src/registry.json`) is generated from
`@teamleader/focus-api-specification`:

```sh
pnpm update @teamleader/focus-api-specification
pnpm generate
```

## Development

```sh
pnpm test       # node:test suite (schema parsing + CLI against a mock API server)
pnpm generate   # rebuild src/registry.json from the spec
```

No runtime dependencies — plain Node.js with the built-in `fetch`.
