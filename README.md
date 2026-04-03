# Cloudflare DDNS


[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/okikio/cloudflare-ddns)

A Cloudflare Worker that keeps a hostname such as `nas.example.com` pointed at your changing public IP address. It is designed for Synology NAS' but can work with any HTTP client.

When your NAS or a script calls this worker, it reads the caller's IP from the request, compares it to the existing Cloudflare DNS record, and creates or updates the record if needed. Responses follow the DynDNS2 protocol so Synology DSM recognizes them like a normal DDNS provider.

![Synology DSM DDNS settings showing a custom Cloudflare provider using a Cloudflare Worker /nic/update DynDNS2 URL with hostname, IP, username, and password fields.](assets/synology-ddns-dashboard.png)

> [!NOTE]
> Most people should use Deploy to Cloudflare. That path lets Cloudflare deploy a copy of the Cloudflare Worker on your Cloudflare account, and provision supported resources such as D1 for keeping track of domain name changes. Use the local Wrangler setup only if you want to develop or operate the project from your own machine.

## Getting started

If you want this working on a Synology NAS and do not want to deal with local tooling, follow these two guides in order:

1. [docs/cloudflare-setup.md](docs/cloudflare-setup.md) for the Cloudflare side
2. [docs/synology-setup.md](docs/synology-setup.md) for the DSM screens

It's much simpler using Deploy to Cloudflare for the first part, and that path still gives you the same Worker URL and shared secret values to use in DSM.

```text
Cloudflare account + domain
            |
            v
Deploy to Cloudflare
            |
            v
Worker URL + shared secret
            |
            v
Synology DSM custom DDNS
            |
            v
Automatic DNS updates when your IP changes
```

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A domain with its DNS managed by Cloudflare
- The hostname you want to keep updated, for example `nas.example.com`
- A Cloudflare API token with `DNS Write` permission for that zone. The easiest way is Cloudflare's [Edit Zone DNS token template](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
- Your zone ID from the Cloudflare dashboard. If you do not know where to look, use [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
- A shared secret you choose for the NAS to send as the password

If you want one update to refresh both an exact record and a wildcard companion, decide that now and allow both names, for example `nas.example.com,*.nas.example.com`.

## Various setup paths
- [docs/cloudflare-setup.md](docs/cloudflare-setup.md): easiest setup path for most users
- [docs/synology-setup.md](docs/synology-setup.md): step-by-step DSM walkthrough with screenshots
- [docs/security-model.md](docs/security-model.md): current trust model, limitations, and hardening options
- [Advanced local setup](#advanced-local-setup): local clone, Wrangler, and explicit D1 workflows
- [JSON API](#json-api): script and automation usage

## Features

- Synology DSM custom DDNS provider compatibility (`GET /nic/update`)
- JSON API for scripts and automation (`POST /update` with OpenAPI docs)
- IPv4 (A) and IPv6 (AAAA) support
- Optional D1-backed audit log with scheduled cleanup
- Default per-IP rate limiting for update endpoints
- Hostname allowlist to limit what records can be changed
- Configurable proxied/DNS-only mode and TTL

## For most users

The easiest path is:

1. Deploy the Worker with [docs/cloudflare-setup.md](docs/cloudflare-setup.md)
2. Configure DSM with [docs/synology-setup.md](docs/synology-setup.md)
3. Save the DDNS entry in DSM and confirm you get `good <ip>` or `nochg <ip>`

If you are not using Synology and just want the API, deploy the Worker first and then use the JSON example in [JSON API](#json-api).

The default deploy path also enables a fixed-window rate limit of 10 update requests per minute per client IP. That is meant to slow down bad password guessing, runaway retry loops, and damage from a leaked secret without requiring extra Cloudflare bindings.

If you need to understand what this setup does and does not protect, read [docs/security-model.md](docs/security-model.md). The short version is that this worker is designed for trusted clients you control, not for strong per-device identity or zero-trust exposure on its own.

## Advanced local deploy

Use this path if you want to deploy manually, need explicit local control over Wrangler, or want to manage D1 from your own machine.

### Local prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A domain with its DNS managed by Cloudflare
- A [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) created from Cloudflare's [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/) page using the `Edit Zone DNS` template. That template grants the zone-scoped `DNS Write` permission this worker needs.
- Your zone ID from the domain overview page in the Cloudflare dashboard. Cloudflare documents the lookup flow in [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
- [Node.js](https://nodejs.org/) 22+ and [pnpm](https://pnpm.io/) 9+

### 1. Clone and install

```sh
git clone https://github.com/okikio/cloudflare-ddns.git
cd cloudflare-ddns
pnpm install
```

### 2. Create the D1 database

```sh
pnpm wrangler d1 create cloudflare-ddns-db
```

If you want the database provisioned before the first deploy, copy the generated D1 binding back into your local `wrangler.jsonc`, or use `pnpm setup:db` to create the database and write that binding for you.

If you skip this step, keep the committed `d1_databases` entry as-is. Wrangler can automatically provision the D1 database from that binding during `pnpm run deploy`, Workers Builds, or Deploy to Cloudflare. This is the default template path.

If you use Cloudflare Workers Builds with Git integration, set the project Deploy command to `pnpm run deploy` instead of `npx wrangler deploy`. This repository uses a pnpm workspace, so `pnpm deploy` runs pnpm's built-in workspace deploy command rather than the package script. `pnpm run deploy` is the form that runs this repository's plain `wrangler deploy` script.

If you already have an existing D1 database that your own Worker must keep using, set the `DDNS_D1_DATABASE_ID` environment variable in your local shell or in Workers Builds. The deploy script will generate a temporary `.wrangler/deploy/wrangler.generated.jsonc` file containing that real `database_id` only for the current deploy. The committed template config remains unchanged.

### 3. Set secrets

```sh
cp .env.production.example .env.production
# edit .env.production with your real values
pnpm wrangler secret bulk .env.production
```

You can also use `pnpm setup:secrets`, which prompts for the values and uploads them safely in one pass.

| Secret | Description |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token for your zone created from Cloudflare's [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/) page using the `Edit Zone DNS` template. That template grants the required zone-scoped `DNS Write` permission. |
| `CF_ZONE_ID` | Zone ID from your domain Overview page. If you do not know where to look, use [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/). |
| `DDNS_SHARED_SECRET` | A password you choose. Callers must send this to authenticate. Use at least 32 random characters. |
The repository includes [`.env.production.example`](./.env.production.example) so the manual upload path has a ready-made template.

### 4. Configure allowed hostnames

Set `DDNS_ALLOWED_HOSTNAMES` in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "DDNS_ALLOWED_HOSTNAMES": "nas.example.com,*.nas.example.com",
  "DDNS_PROXIED": "false",
  "DDNS_TTL": "1",
  "DDNS_LOG_RETENTION_DAYS": "30"
}
```

You can also use `pnpm setup:secrets`, which uploads the actual secrets and writes `DDNS_ALLOWED_HOSTNAMES` into `wrangler.jsonc` for you.

### 5. Deploy

```sh
pnpm run deploy
```

This runs a standard `wrangler deploy`.

For this repository's default template path, the Worker deploys without requiring a pre-existing D1 `database_id`. DDNS updates still work before the audit-log table exists, but D1-backed audit logging only becomes active after you apply the SQL migrations from a local/operator workflow.

Workers Builds does not need a dedicated D1 build secret for this repository when you want the template-safe default path. Use the committed D1 binding and set the Deploy command to `pnpm run deploy`.

If you are deploying your own long-lived Worker and want it to keep the same existing D1 database, add `DDNS_D1_DATABASE_ID=<your-existing-database-uuid>` to the Workers Builds environment variables. `pnpm run deploy` will then inject that `database_id` into a generated deploy-only Wrangler config before running `wrangler deploy`.

If you want to manage the D1 database explicitly after cloning locally, run:

```sh
pnpm setup:db
pnpm setup:secrets
pnpm run migrate:remote
pnpm run deploy
```

That path writes a real `database_id` into your local `wrangler.jsonc`, uploads the required secrets, applies the SQL migrations remotely, and then deploys the Worker. It is the recommended way to enable the D1-backed audit log from a local/operator workflow.

If you want the same behavior in CI or Workers Builds without committing the ID, set `DDNS_D1_DATABASE_ID` and then use:

```sh
pnpm run migrate:remote
pnpm run deploy
```

`pnpm run migrate:remote` requires `DDNS_D1_DATABASE_ID` because remote D1 operations need the real database UUID.

## Configuration reference

These non-secret variables live in `wrangler.jsonc` and can be overridden per-environment:

| Variable | Default | Description |
|---|---|---|
| `DDNS_ALLOWED_HOSTNAMES` | `nas.example.com,*.nas.example.com` | Comma-separated hostnames this worker may update. Replace the default with your real hostname list before production use. Wildcard companions such as `*.nas.example.com` are supported as explicit entries. |
| `DDNS_PROXIED` | `"false"` | Whether DNS records are proxied through Cloudflare. Most NAS setups need `"false"` (DNS-only) for direct IP access on non-standard ports. |
| `DDNS_TTL` | `"1"` | DNS record TTL in seconds. `"1"` means automatic. Valid range: 60-86400. |
| `DDNS_LOG_RETENTION_DAYS` | `"30"` | How many days of update logs to keep in D1. A cron job runs every 6 hours to prune older rows. |
| `DDNS_RATE_LIMIT_MAX_REQUESTS` | `"10"` | Maximum number of update requests allowed per client IP within the current fixed window. Set to `"0"` to disable rate limiting. |
| `DDNS_RATE_LIMIT_WINDOW_SECONDS` | `"60"` | Fixed-window size for DDNS rate limiting, in seconds. |

## Shared secret rotation

If you think `DDNS_SHARED_SECRET` was exposed, rotate it immediately:

1. Generate a new random secret.
2. Update `DDNS_SHARED_SECRET` in Cloudflare.
3. Update every caller that stores the old secret, including DSM and any scripts using `X-DDNS-Secret`.
4. Trigger a manual test request and confirm the worker returns `good <ip>` or `nochg <ip>`.

If you use the D1 audit log, review recent rows for unusual request volume, repeated authentication failures, or unexpected update sources. The built-in per-IP rate limit reduces how fast a leaked secret can be abused, but it does not replace rotating the secret.

## Using the worker

### Synology DSM

For most people, use [docs/synology-setup.md](docs/synology-setup.md). That guide walks through the DSM screens with screenshots.

If you already know DSM and only need the values, use the fields below.

In **Control Panel > External Access > DDNS > Customize**:

| Field | Value |
|---|---|
| Service Provider | Any name, e.g. `Cloudflare DDNS` |
| Query URL | `https://<your-worker>.workers.dev/nic/update?hostname=__HOSTNAME__&myip=__MYIP__&username=__USERNAME__&password=__PASSWORD__` |

Then add a DDNS entry:

| Field | Value |
|---|---|
| Service Provider | The custom provider you just created |
| Hostname | `nas.example.com` (must be in your allowed list) |
| Username | Anything (not used, but DSM requires a value) |
| Password | Your `DDNS_SHARED_SECRET` |

DSM will call the worker whenever it detects an IP change. The worker responds with `good <ip>` or `nochg <ip>` on success.

If DSM or another client starts retrying too quickly, the worker now returns HTTP `429` with a `Retry-After` header. The Synology-compatible body stays `911` so the client treats it as a retryable server-side problem.

If you want one request for `nas.example.com` to also update `*.nas.example.com`, include both in `DDNS_ALLOWED_HOSTNAMES`, for example `nas.example.com,*.nas.example.com`. The worker treats the wildcard entry as a second managed DNS record and updates both records together.

### JSON API

```sh
curl -X POST https://<your-worker>.workers.dev/update \
  -H "Content-Type: application/json" \
  -H "X-DDNS-Secret: <your-secret>" \
  -d '{"hostname": "nas.example.com", "ip": "203.0.113.1"}'
```

Omit `ip` to use the caller's public IP (from Cloudflare's `CF-Connecting-IP` header). Omit `hostname` to default to the first hostname in your allowed list.

Wildcard records work the same way here: if `DDNS_ALLOWED_HOSTNAMES` contains both `nas.example.com` and `*.nas.example.com`, a JSON update request for `nas.example.com` updates both records and returns per-target results in the response.

OpenAPI documentation is served at the worker's root URL (`/`).

If a client IP exceeds the default fixed-window rate limit, `POST /update` returns HTTP `429` with a JSON error body and a `Retry-After` header.

### Health check

```
GET /health  ->  {"ok": true}
```

## Development

```sh
pnpm dev     # starts wrangler dev with local D1 migrations
pnpm test    # runs vitest with Miniflare
```

## Continuous integration

GitHub Actions runs `pnpm test` for pull requests and pushes to `main` on Node.js 22 and 24.
Dependabot checks the workflow action references weekly so the CI setup stays current.

## How it works

1. The caller authenticates with a shared secret (query param or header).
2. The worker validates the hostname against the configured allowlist.
3. It resolves the IP from the request body/query, falling back to `CF-Connecting-IP`.
4. It resolves the request to one or more managed hostnames. For example, `nas.example.com` can fan out to both `nas.example.com` and `*.nas.example.com` when both are explicitly allowed.
5. It queries Cloudflare's DNS API for an existing A or AAAA record matching each target hostname.
6. If a target record already has the same IP, proxied state, and TTL, no change is made for that target (`nochg`).
7. Otherwise it creates or patches that target record (`good`).
8. The outcome is logged to D1 once per concrete DNS record (fire-and-forget, so the response is not delayed).
9. A cron job (every 6 hours) prunes log rows older than the retention period.

## Wildcard notes

- Cloudflare wildcard DNS records only wildcard the first label. `*.nas.example.com` is a wildcard record, but `subdomain.*.example.com` is not.
- Exact DNS records take precedence over wildcard records on Cloudflare. `nas.example.com` and `*.nas.example.com` are separate records with different jobs.
- This worker only auto-updates a wildcard companion when that wildcard record is explicitly present in `DDNS_ALLOWED_HOSTNAMES`.

## Project structure

```
src/
  index.ts             Main app, route wiring, scheduled handler
  types.ts             DdnsEnv interface, response/action constants
  ddns.ts              Shared update logic (findRecord, compare, create/patch)
  cloudflare-api.ts    Typed wrapper around Cloudflare DNS REST API
  validation.ts        IP validation, config parsing (no dependencies)
  logging.ts           Best-effort D1 audit logging and cleanup
  endpoints/
    synology.ts        GET /nic/update  (DynDNS2 text responses)
    update.ts          POST /update     (JSON, OpenAPI via Chanfana)
    health.ts          GET /health
migrations/
  0001_ddns_logs.sql   D1 table for update history
tests/
  helpers.ts           Mock Cloudflare DNS API for tests
  integration/         Integration tests (health, synology, update)
```
