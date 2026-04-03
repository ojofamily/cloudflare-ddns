# Cloudflare Setup

This guide is for people who want the easiest path to a working Cloudflare DDNS Worker, especially new or non-technical Synology NAS users.

You will use Cloudflare's Deploy to Cloudflare flow, enter a few values, wait for the Worker to deploy, and then move to the DSM guide.

You do not need Node.js, pnpm, or Wrangler for this guide.

## What you will have at the end

When you finish this guide, you should have:

- a deployed Worker URL, for example `https://cloudflare-ddns.your-name.workers.dev`
- a shared secret you will paste into Synology DSM as the password
- one or more hostnames the Worker is allowed to update

After that, continue to [synology-setup.md](./synology-setup.md) to finish the NAS side.

## Before you click Deploy to Cloudflare

Have these ready first:

| Item | What it means | Example |
|---|---|---|
| Hostname | The DNS name you want your NAS to keep updated. | `nas.example.com` |
| Cloudflare API token | A token with permission to edit DNS records for your zone. The easiest option is Cloudflare's `Edit Zone DNS` template. | `CF_API_TOKEN` |
| Zone ID | The Cloudflare zone ID for your domain. | `CF_ZONE_ID` |
| Shared secret | A long random password that your NAS will send to the Worker. | `DDNS_SHARED_SECRET` |
| Allowed hostnames | A comma-separated list of names this Worker may update. | `nas.example.com` |

These helper links are the fastest way to gather the Cloudflare values:

- [API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/) for the `Edit Zone DNS` template
- [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) if you want Cloudflare's step-by-step token flow
- [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) if you do not know where the zone ID is shown
- [1Password password generator](https://1password.com/password-generator/) or [Bitwarden password generator](https://bitwarden.com/password-generator/) if you want a browser-based way to generate the shared secret

If you want one update to refresh both `nas.example.com` and `*.nas.example.com`, set `DDNS_ALLOWED_HOSTNAMES` to `nas.example.com,*.nas.example.com`.

## Step 1: Open the deploy flow

Use the button in [README.md](../README.md) or open the direct deploy URL:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/okikio/cloudflare-ddns)

Cloudflare's deploy flow creates a copy of the repository in your GitHub or GitLab account and deploys the Worker from there.

## Step 2: Fill in the required values

When Cloudflare asks for variables and secrets, use the values you gathered earlier:

| Name | What to enter |
|---|---|
| `CF_API_TOKEN` | Your Cloudflare API token for this zone |
| `CF_ZONE_ID` | Your Cloudflare zone ID |
| `DDNS_SHARED_SECRET` | Your shared secret |
| `DDNS_ALLOWED_HOSTNAMES` | Your hostname list, for example `nas.example.com` |

For most NAS setups, leave the other settings at their defaults.

The important default is `DDNS_PROXIED=false`, because direct NAS access usually needs DNS-only mode rather than Cloudflare proxying.

## Step 3: Finish the deployment

Submit the form and wait for Cloudflare to finish building and deploying the Worker.

When the deploy finishes, copy the Worker URL. It usually looks like `https://<worker-name>.<subdomain>.workers.dev`.

## Step 4: Continue to Synology DSM

Once you have the Worker URL and shared secret, continue to [synology-setup.md](./synology-setup.md).

That guide shows the exact DSM fields to fill in and what success should look like.

## Common questions

### Do I need to create the DNS record first?

No. The Worker can create the record when the NAS sends its first successful update.

### Do I need local development tools for this path?

No. The Deploy to Cloudflare flow handles the build and deployment for you.

### What if I want to manage the project from my own machine?

Use the advanced local setup in [README.md](../README.md#advanced-local-setup).