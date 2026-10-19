# NSPanel Manager

NSPanel Manager is a TypeScript application for configuring and operating NSPanel firmware through MQTT. It replaces hand-edited Node-RED flows for panel settings and simple device topic mappings. It does not flash or update firmware. The Angular 22 UI uses standalone feature pages with separate TypeScript, HTML, and CSS files; the Express API is divided into feature routers, domain helpers, and services.

## Features in this MVP

- Manage multiple NSPanel profiles, including the title, brightness, screensaver, night mode, four home-screen buttons, twelve favorites, and physical button relay behavior.
- Publish the profile to `<nodeName>/cmnd/settings` or automatically resend it when firmware publishes `booted` to `<nodeName>/event/display`.
- Configure MQTT routes from external state topics to a panel and from panel event topics to device command topics.
- Store broker credentials and manager configuration locally or in the Docker named volume.
- Sign in with a local email/password account; optionally use a generic OIDC provider to sign in as an existing local account.

## Run locally

Install Node.js 22.22.3 or newer in the Node 22 line and pnpm, then run:

```sh
pnpm install
pnpm security:keygen
pnpm dev
```

Run `pnpm security:keygen` once for a new data store; it creates `secrets/manager_encryption_key` and refuses to overwrite an existing key. Keep the key safe and available on every restart. `pnpm dev` runs Angular with live reload at `http://localhost:4200` and the API on port `3000`. `pnpm start:debug` builds Angular once and serves the static client and API together at `http://localhost:3000`. Re-run it after client changes. When the API starts with no local users, it generates a random one-time setup token and prints it to the API console. Protect access to that console output until setup is complete. Enter the token on the first-run setup screen with an email and password of at least 12 characters. The wizard signs you in when the account is saved. Restarting before setup rotates the token, so use the latest startup log. Complete setup from a trusted local network before exposing the manager elsewhere. Configure the MQTT broker under **Connection**. A panel must already be flashed with the compatible firmware, use the same broker, and have a unique `node_name` matching the profile.

For local SSO with `pnpm start:debug`, use `APP_PUBLIC_URL=http://localhost:3000`; register `http://localhost:3000/api/auth/sso/callback` with the identity provider. With `pnpm dev`, the API uses the Angular origin at port `4200`, so the callback is `http://localhost:4200/api/auth/sso/callback`. For Docker, use the browser-facing origin of the deployed app.

## Sign in and accounts

After setup, use **Users** to add, disable, remove, or reset local accounts. Each user is a manager administrator. Password hashes, linked OIDC issuer/subject identifiers, and hashed session tokens are stored in the private `users.json` file under the data directory. The MQTT broker password in `manager.json` is encrypted with AES-256-GCM; the key is kept in `secrets/manager_encryption_key`, outside the data directory. Existing plaintext broker passwords are encrypted automatically on the first startup after this update. An earlier prototype stored scrypt hashes; those accounts are upgraded to Argon2id after their next successful local sign-in. OIDC sign-in only links an identity when the provider returns a verified email matching an enabled local account; unknown SSO users are not added automatically. After linking, sign-in uses the stable issuer and subject pair.

To enable OIDC with Docker Compose, create `secrets/oidc_client_secret` with the provider's client secret and set these non-secret values in the ignored `.env` file. These values are the manager's SSO settings:

```dotenv
APP_PUBLIC_URL=https://manager.example.com
OIDC_ISSUER_URL=https://login.example.com/application/o/nspanel/
OIDC_CLIENT_ID=nspanel-manager
```

Register `https://manager.example.com/api/auth/sso/callback` with the identity provider. The API derives this callback from `APP_PUBLIC_URL` and the fixed `/api/auth/sso/callback` path. Then start the manager with the SSO override:

```sh
docker compose -f docker-compose.yml -f docker-compose.sso.yml up --build
```

The issuer URL must expose OIDC discovery metadata. The client secret is mounted into the API container as a Compose secret and is never returned by the API. The manager URL and issuer must use HTTPS except for loopback development hosts. SSO settings are deployment configuration, not stored in `users.json`.

When running the API directly with `pnpm start:debug`, set `OIDC_CLIENT_SECRET_FILE=../../secrets/oidc_client_secret` in the repository-root `.env`. That path is relative to `apps/api`; Docker Compose mounts the host secret at `/run/secrets/oidc_client_secret` and sets the container path automatically.

## Run with Docker

Copy the environment template before starting Compose:

```sh
cp .env.example .env
```

Install the workspace dependencies and generate the encryption key once if `secrets/manager_encryption_key` does not already exist:

```sh
pnpm install
pnpm security:keygen
```

Protect host-side secret files from other local users. From the repository root, run this after creating the encryption key and any OIDC or ESPHome secret files:

```sh
chmod 700 secrets
chmod 600 secrets/manager_encryption_key
[ ! -f secrets/oidc_client_secret ] || chmod 600 secrets/oidc_client_secret
if [ -f esphome/secrets.yaml ]; then chmod 700 esphome; chmod 600 esphome/secrets.yaml; fi
```

Confirm the files are owned by the intended operator or deployment account and that their parent directories are not accessible to unintended users. Check directory permissions with `ls -ld secrets esphome`, secret-file permissions with `ls -l secrets`, and (if present) `ls -l esphome/secrets.yaml`. Rotate a credential if another local user or workspace recipient may have read it. For firmware development, keep OTA credentials in `esphome/secrets.yaml` and reference them with ESPHome `!secret`; Git ignores this file. It is not used by or included in the manager runtime image.

Edit `APP_PUBLIC_URL` if the manager will be reached at a different origin. For SSO, uncomment and configure the OIDC values in `.env`, create `secrets/oidc_client_secret`, and use the SSO Compose override described above. Compose mounts the encryption key as a read-only secret at `/run/secrets/manager_encryption_key`; keep its source file outside the `manager-data` volume and back it up separately. Losing or replacing the key makes encrypted broker credentials unreadable.

When Traefik or another reverse proxy is the only browser-facing entry point, set `TRUST_PROXY` in `.env` to the proxy's exact IP address or trusted Docker subnet (for example, `172.20.0.0/16`). Login throttling uses Express's `request.ip`, which trusts forwarded addresses only according to this setting. It defaults to `false`; avoid `true` or a hop count unless the proxy path is fixed, forwarded headers are overwritten by the proxy, and direct access to port 3000 is blocked. See the [Express guide to running behind proxies](https://expressjs.com/en/5x/guide/behind-proxies/) for the trust rules.

```sh
docker compose up --build
```

Open `http://localhost:3000`. Copy the one-time setup token from the API startup output, or retrieve it with `docker compose logs manager`, and enter it in the first-run setup form. Treat container logs as sensitive until setup is complete. The token is generated at runtime, is not included in the image, and is invalidated after the first account is created. Restarting before setup generates a new token. Manager profiles and broker credentials persist in the `manager-data` volume. The image expects the MQTT broker to be reachable from the container; configure the broker URL accordingly (for example, a Docker host name or LAN address rather than `localhost`).

The container data directory defaults to `/data`. Set `DATA_DIR` in `.env` to another absolute path inside the container; Compose mounts the persistent `manager-data` volume at that path. Local `pnpm dev` and `pnpm start:debug` keep using `apps/api/data`.

## MQTT routes

Use an external topic as a source and a panel command topic as the target for state updates. For example:

| Direction | Source | Target | Payload |
| --- | --- | --- | --- |
| External → panel | `home/thermostat/current` | `{nodeName}/cmnd/thermostate/current` | `{{payload}}` |
| Panel → external | `nsp-livingroom/event/thermostate/settemp` | `home/thermostat/target/set` | `{{payload}}` |

Source topics accept MQTT `+` and `#` wildcards. Payload templates support `{{payload}}`, `{{topic}}`, `{{nodeName}}`, and JSON paths such as `{{json.temperature}}`. For external-to-panel routes, choose a panel; `{nodeName}` is replaced with its configured MQTT node name.

Authentication protects manager APIs; the panel MQTT runtime remains available to firmware independently. Keep the manager behind HTTPS when accessed beyond the local development machine. See [AGENTS.md](AGENTS.md) for contributor commands and conventions.

See the [MVP plan](docs/MVP-PLAN.md) for the proposed plugin system, entity model, custom flows, and delivery milestones.
