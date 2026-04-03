# Security model

This worker gives Synology DSM and simple scripts a way to update Cloudflare DNS records without storing your Cloudflare API token on every client. That is the main security win: clients only know a DDNS-specific shared secret, while the worker keeps the real Cloudflare credentials on the server side.

The tradeoff is that the current design uses bearer-secret authentication, not per-client identity. If a caller knows the shared secret and asks to update an allowed hostname, the worker treats that caller as authorized.

This document explains what the current implementation protects, and where its limits are, and what hardening steps make sense if you need a tighter security model.

## What the worker protects today

The current design is meant for a small number of clients you control, such as one Synology NAS and a few scripts. It narrows the blast radius compared to giving those clients direct Cloudflare DNS credentials.

At a high level, each update request flows through these checks:

```text
Client
  |
  |  shared secret + hostname + optional IP override
  v
Worker
  |
  |  1. authenticate shared secret
  |  2. require hostname in DDNS_ALLOWED_HOSTNAMES
  |  3. apply per-client-IP rate limit
  |  4. update only the matching DNS records in this zone
  v
Cloudflare DNS API

Optional side path:
Worker -> D1 audit log / rate-limit state
```

Those checks give you a few concrete protections:

- Clients never receive your Cloudflare API token or zone-wide DNS permissions.
- The hostname allowlist limits updates to names you explicitly approved in `DDNS_ALLOWED_HOSTNAMES`.
- The built-in fixed-window rate limit slows down password guessing and runaway retry loops from a single client IP.
- The optional D1 audit log gives you a record of update attempts and outcomes for later review.

## Where the current design is intentionally weak

The main limit is that `DDNS_SHARED_SECRET` is a bearer secret. Possession is enough. There is no second factor, no per-device secret, and no policy tied to the Synology `username` field.

That leads to a few practical consequences:

- All clients share the same trust level. If one client leaks the secret, every allowed hostname protected by that secret is at risk.
- The Synology-compatible `GET /nic/update` endpoint carries the secret in the `password` query parameter because DSM expects a DynDNS2-style URL. Query-string secrets are easier to leak through screenshots, copied URLs, client-side logs, proxy logs, and similar tooling than header-based secrets.
- The worker accepts a valid caller-supplied IP override: `myip` on `GET /nic/update` and `ip` on `POST /update`. If the secret leaks, an attacker can point an allowed hostname at another IP address. The worker falls back to `CF-Connecting-IP` only when the supplied override is missing or invalid.
- The DSM `username` field is currently ignored. It exists for compatibility, not authorization, so it does not contain or scope access.

This means the worker is a good fit for trusted clients under one operator, but it is not the same thing as strong client identity.

## What the current controls are good at

For the intended use case, the current controls still solve real problems.

- Shared-secret auth is simple enough for Synology DSM and other basic HTTP clients.
- Hostname allowlisting prevents a compromised client from editing arbitrary records across the zone.
- Rate limiting reduces the speed of abuse when the secret is guessed or leaked.
- Secret rotation is simple: change `DDNS_SHARED_SECRET`, update the clients you control, and test again.

For many home-lab and small-operator setups, that is an acceptable balance between compatibility and containment.

## What to do if the secret is exposed

Treat a leaked `DDNS_SHARED_SECRET` like a leaked password with zone-specific impact.

1. Generate a new long random secret.
2. Update `DDNS_SHARED_SECRET` in Cloudflare.
3. Update every client that stores it, including DSM and any scripts using `X-DDNS-Secret`.
4. Review recent DDNS activity if you enabled D1 logging.
5. Run a manual update and confirm the worker returns a normal success response again.

The built-in rate limit helps slow abuse, but it does not remove the need to rotate the secret.

## Hardening options if you need more than this

If your threat model is stronger than "trusted clients I control," the next improvements are fairly clear.

### Safer default for non-Synology clients: use the JSON API

If you control the caller and do not need Synology's legacy DynDNS2 shape, prefer `POST /update` with `X-DDNS-Secret`. A header-based secret is still a bearer secret, but it avoids putting the secret in the URL.

### Stronger operator controls

Depending on the client, you can also add more layers around the worker:

- richer audit logging such as caller IP, user agent, or Cloudflare Ray ID
- Cloudflare WAF or custom rules in front of the worker
- a separate stronger-auth path for non-Synology automation clients
- mutual TLS (mTLS) or client certificates for environments that can support them

These are useful additions, but they are not drop-in replacements for Synology DSM compatibility.

## Bottom line

This project currently offers constrained shared-secret authentication, hostname scoping, rate limiting, and optional audit logging. That is a meaningful improvement over handing every DDNS client full Cloudflare DNS credentials.

It does not offer strong per-device identity, and it does not guarantee that updates always reflect the caller's own network IP. If you need those guarantees, treat the current worker as a compatibility-focused base and plan for stronger client-specific authentication on top.