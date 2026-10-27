# Web UI translations

The web client uses ngx-translate with its HTTP loader. Translation resources are JSON files served from `/assets/i18n/`; they are fetched at runtime instead of being bundled into Angular code.

## Add a language

1. Add `apps/web/public/assets/i18n/<language-code>.json`, using the same key structure as `en.json`.
2. Add the language code and its native display name to `apps/web/public/assets/i18n/languages.json`.
3. Deploy the JSON files at `WEB_ROOT/assets/i18n/` with the web app. The language selector reads the catalog at startup and loads each language file when selected.

English is the fallback language. Missing keys in another language use the matching English translation. The selected language is saved in browser local storage and is independent for each browser.

The app shell and sign-in/setup screens are the first migrated views. Feature pages, validation messages, confirmations, empty states, and contextual help still need translation keys and resources; track that remaining coverage in `docs/MVP-PLAN.md`.
