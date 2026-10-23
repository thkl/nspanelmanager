# NSPanel Manager

NSPanel Manager is a TypeScript application for configuring and operating NSPanel firmware through MQTT. It replaces hand-edited Node-RED flows for panel settings and simple device topic mappings. It can upload and deliver ESPHome firmware binaries and Nextion HMI files to configured panels. The Angular 22 UI uses standalone feature pages with separate TypeScript, HTML, and CSS files; the Express API is divided into feature routers, domain helpers, and services.

## Features in this MVP

- Manage multiple NSPanel profiles, including the title, brightness, screensaver, night mode, four home-screen buttons, twelve favorites, and physical button relay behavior.
- Publish the profile to `<nodeName>/cmnd/settings` or automatically resend it when firmware publishes `booted` to `<nodeName>/event/display`.
- Configure MQTT routes from external state topics to a panel and from panel event topics to device command topics.
- Store broker credentials and manager configuration locally or in the Docker named volume.
- Sign in with a local email/password account; optionally use a generic OIDC provider to sign in as an existing local account.

## Run locally

Install Node.js 24.22.1 or newer in the Node 24 line, plus pnpm, then run:

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

`USER_STORE_SET_PERMISSIONS` defaults to `true` and makes the API set private permissions on the user-store directory and file. If a NAS filesystem rejects `chmod`, set it to `false` in `.env`; then restrict access to `users.json` through the NAS or host filesystem configuration.

When Traefik or another reverse proxy is the only browser-facing entry point, set `TRUST_PROXY` in `.env` to the proxy's exact IP address or trusted Docker subnet (for example, `172.20.0.0/16`). Login throttling uses Express's `request.ip`, which trusts forwarded addresses only according to this setting. It defaults to `false`; avoid `true` or a hop count unless the proxy path is fixed, forwarded headers are overwritten by the proxy, and direct access to port 3000 is blocked. See the [Express guide to running behind proxies](https://expressjs.com/en/5x/guide/behind-proxies/) for the trust rules.

```sh
docker compose up --build
```

Open `http://localhost:3000`. Copy the one-time setup token from the API startup output, or retrieve it with `docker compose logs manager`, and enter it in the first-run setup form. Treat container logs as sensitive until setup is complete. The token is generated at runtime, is not included in the image, and is invalidated after the first account is created. Restarting before setup generates a new token. Manager profiles and broker credentials persist in the `manager-data` volume. The image expects the MQTT broker to be reachable from the container; configure the broker URL accordingly (for example, a Docker host name or LAN address rather than `localhost`).

The container data directory defaults to `/data`. Set `DATA_DIR` in `.env` to another absolute path inside the container; Compose mounts the persistent `manager-data` volume at that path. Local `pnpm dev` and `pnpm start:debug` keep using `apps/api/data`.

## Application logs

The authenticated workspace includes a **Logs** page with category and severity filters, plus paging at 50, 100, or 200 records per page. The API bounds each read to 20,000 scanned lines; narrow the filters when older entries are needed. It writes structured JSON log records to `DATA_DIR/logs` by default (`/data/logs` in Docker). Set `LOG_DIR` to use another directory; if you do, make sure it is writable by the manager and mounted persistently in Docker. Winston rotates files daily or at 10 MB and retains the latest 20 files. The manager creates the log directory with owner-only access and log files with owner read/write access. Treat logs as sensitive: configured scripts can write their own values through `debug.log(...)`.

## Firmware and HMI updates

The authenticated **Panel updates** page accepts an ESPHome OTA `.bin` file up to 8 MB and sends a six-hour manager download link to one configured panel over MQTT. Before migrating a legacy panel, assign its discovered MAC address on the **Panels** page so the manager can identify the panel after reboot. Build the unified panel firmware with `pnpm firmware:compile`; it compiles `esphome/nspanel-unified.yaml`, increments `panel-unified.yaml`'s firmware version, and copies the OTA image to `esphome/nspanel-unified.bin`. Enter that exact compiled version when uploading the binary. The panel asks for on-screen confirmation unless **Force update** is selected. Unified firmware announces its MAC at `nspanel/nspanel-<last-6-MAC>/event/init`; the manager returns settings, including the configured node name, on the same bootstrap root. Once configured, normal commands and events use the existing `<nodeName>/cmnd/...` and `<nodeName>/event/...` topics. The manager confirms success after the panel reports the requested firmware version. Firmware files are stored in `DATA_DIR/firmware`.

The same page accepts a Nextion `.tft` file up to 32 MB, stores it in `DATA_DIR/hmi`, and sends a six-hour download link and update job ID to one configured panel over MQTT. Its SHA-256 checksum is the HMI version ID. The current firmware reports confirmation, update start, cancellation, or transfer failure; a matching heartbeat checksum confirms success. The manager retains up to 200 update jobs in runtime state and streams panel and job changes to signed-in browsers over an authenticated same-origin WebSocket. The panel keeps its existing on-screen confirmation; press **UPDATE** on the panel to begin. The unified entry point is `esphome/nspanel-unified.yaml`; legacy `panel5.yaml` remains available for existing installations. The configured `APP_PUBLIC_URL` must be reachable from the panel. Set `HMI_PUBLIC_URL` to a panel-network address if the manager's browser-facing URL is not reachable there; local development may use the API host and port `3000`. The `.tft` file is included in manager data backups.

## Backups and manual restore

Signed-in administrators can open **Backup** and download a ZIP of the complete configured `DATA_DIR`. The archive streams directly to the browser and includes regular files under that directory, including logs when `LOG_DIR` is inside it. Treat the downloaded ZIP as sensitive because it contains user records, configuration, and saved script state.

The credential-encryption key (`MANAGER_ENCRYPTION_KEY_FILE`) and optional OIDC client secret are outside `DATA_DIR`; back them up separately and keep them protected. Losing the encryption key makes stored MQTT credentials unreadable. To restore manually, stop the manager, extract the ZIP so its `data/` contents replace or populate the configured `DATA_DIR`, restore deployment secrets and configuration separately, then restart the manager. If `LOG_DIR` is outside `DATA_DIR`, back it up separately if those logs are needed. Restore is an operator procedure; the UI does not import archives.

## MQTT routes

Use an external topic as a source and a panel command topic as the target for state updates. For example:

| Direction | Source | Target | Payload |
| --- | --- | --- | --- |
| External → panel | `home/thermostat/current` | `{nodeName}/cmnd/thermostate/current` | `{{payload}}` |
| Panel → external | `nsp-livingroom/event/thermostate/settemp` | `home/thermostat/target/set` | `{{payload}}` |

Source topics accept MQTT `+` and `#` wildcards. Payload templates support `{{payload}}`, `{{topic}}`, `{{nodeName}}`, and JSON paths such as `{{json.temperature}}`. For external-to-panel routes, choose a panel; `{nodeName}` is replaced with its configured MQTT node name.

Authentication protects manager APIs; the panel MQTT runtime remains available to firmware independently. Keep the manager behind HTTPS when accessed beyond the local development machine. See [AGENTS.md](AGENTS.md) for contributor commands and conventions.

## Built-in thermostat page

Create an **MQTT thermostat** profile under **Plugins**, then create an instance for each thermostat. The profile is reusable; each instance can use its own topic variables. For a Homematic device, set the instance variable `channel` to a value such as `LEQ0999385:2`. The default profile fields then resolve to:

| Setting | Value |
| --- | --- |
| Status topic filter | `ccu/status/{{channel}}/+` |
| Current topic suffix | `ACTUAL_TEMPERATURE` |
| Target topic suffix | `SET_TEMPERATURE` |
| Current request topic | `ccu/get/{{channel}}/ACTUAL_TEMPERATURE` |
| Set topic | `ccu/set/{{channel}}/SET_TEMPERATURE` |
| Temperature value path | `val` |

The default request payload is `{}`. Set temperature publishes the numeric value from `{{value}}`; panel `up` and `dn` events add or subtract the configured delta from the latest target, clamped to the configured minimum and maximum. Auto and Boost use `mode:{{mode}}`, producing `mode:auto` or `mode:boost`. The profile also exposes an optional target request topic and configurable minimum, maximum, Up/Down delta, and all three payload templates. Change the value path or templates to match another MQTT thermostat's payload contract.

On the panel's **Panels** page, assign the thermostat instance in **Thermostat page**. The manager requests state when the built-in thermostat page opens, translates its temperature and mode events to MQTT, and sends current/target updates only while that page is open. When the assigned thermostat's actual temperature changes, it also publishes the numeric reading to `<nodeName>/cmnd/temperature/current` for the panel's home-screen temperature. Flash compatible firmware from `esphome/panel5.yaml`: it publishes `event/page/thermostat` on entry and `event/page/page0` on Back so the manager knows when to stop thermostat-page updates. Other `/event/page/#` navigation and display sleep also clear the active page.

## Built-in weather screen

Create an **Open-Meteo weather** profile under **Plugins** and choose a refresh interval from 5 to 360 minutes. Create an instance with `latitude` and `longitude` variables; `timezone` is optional and defaults to automatic detection (for example, `Europe/Berlin`). Assign that instance to **Weather screen** under **Panels → Built-in panel pages**. The manager fetches current conditions and a five-day forecast, caches changed results, and sends `<nodeName>/cmnd/weather` only while that panel's weather page is open. The cached forecast is replayed when the page opens. Open-Meteo's public forecast endpoint needs no API key for this use. The payload uses numeric rain and wind values, a `min/max` temperature string per forecast day, and panel font glyphs for `condition` and `cond`. WMO condition codes are translated through OpenWeatherMap icon categories into the panel glyph map (for example, partly cloudy → `C`, rain → `I`).

See the [MVP plan](docs/MVP-PLAN.md) for the proposed plugin system, entity model, custom flows, and delivery milestones.
