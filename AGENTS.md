# Repository Guidelines

## Project Structure

This pnpm workspace has an Express/TypeScript API and MQTT runtime in `apps/api`, and an Angular 22 standalone UI in `apps/web`. API files are grouped by feature (`routes/`, `services/`, `domain/`). Angular pages live under `src/app/features/` with separate `.ts`, `.html`, and `.css` files; shared contracts and state are in `models.ts` and `manager-store.service.ts`. Use signal state, signal-based `viewChild()`, and built-in `@if`/`@for` control flow. `docker-compose.yml` runs both together and persists configuration in a Docker volume. ESPHome firmware remains in `esphome/`: `nspanel-unified.yaml` loads the separate `panel-unified.yaml` package; `nsp-livingroom.yaml` and `panel5.yaml` remain the legacy installation.

## Development Commands

- `pnpm install` installs workspace dependencies.
- `pnpm security:keygen` creates the local credential-encryption key once; it refuses to replace an existing key.
- `pnpm dev` starts the API on port 3000 and Angular on port 4200; the UI proxies `/api` to the API.
- `pnpm build` builds the Angular app and TypeScript API.
- `pnpm firmware:compile` increments the unified firmware patch version, compiles `esphome/nspanel-unified.yaml`, and copies the OTA binary to `esphome/nspanel-unified.bin`.
- `docker compose up --build` builds and runs the manager on port 3000; first create `secrets/manager_encryption_key` with the key-generation command.

The first run needs an MQTT broker URL and credentials configured in the UI. Local manager data is written to `apps/api/data/manager.json`; Docker stores it in the `manager-data` volume. Keep the credential-encryption key in `secrets/`, outside the data volume, and back it up separately. Do not commit local secrets or manager data.

## Code Style

Use TypeScript strict mode, two-space indentation, semicolons, and descriptive camelCase identifiers. Document classes and their public methods with JSDoc that explains their responsibility, lifecycle, and interactions. Keep API contracts in `apps/api/src/types.ts`. Preserve ESPHome YAML’s two-space nesting and existing device substitutions. Both firmware variants use `<nodeName>/cmnd/...` and `<nodeName>/event/...` for normal traffic; unified firmware uses `nspanel/nspanel-<last-6-MAC>/event/init` and `/cmnd/settings` for its MAC-based identity and settings handshake.

## Validation

There is no automated test suite yet. Use `pnpm build` to catch TypeScript and Angular compilation errors. Validate unified firmware configuration with `esphome config esphome/nspanel-unified.yaml`; compile or upload only when firmware changes require it. For MQTT behavior, use a broker and panel or MQTT client with the documented topic patterns.

## Security & Changes

Broker passwords are encrypted in the manager’s local persisted config; keep the encryption key outside the data volume. Keep ESPHome credentials in `esphome/secrets.yaml`. Never add real credentials to examples or commits. Git history is unavailable in this workspace, so use concise imperative commit subjects. Pull requests should describe affected flows, validation performed, and hardware observations when relevant.
