# Web UI translations

The web client uses ngx-translate with its HTTP loader. Translation resources are JSON files served from `/assets/i18n/`; they are fetched at runtime instead of being bundled into Angular code.

## Add a language

1. Add `apps/web/public/assets/i18n/<language-code>.json`, using the same key structure as `en.json`.
2. Add the language code and its native display name to `apps/web/public/assets/i18n/languages.json`.
3. Deploy the JSON files at `WEB_ROOT/assets/i18n/` with the web app. The language selector reads the catalog at startup and loads each language file when selected.

English is the fallback language. Missing keys in another language use the matching English translation. The selected language is saved in browser local storage and is independent for each browser.

The app shell, sign-in/setup flow, and feature pages use the English and German resources, including form guidance, confirmations, empty states, and operation notices. Plugin names, schema labels/help, user-authored text, and raw errors returned by integrations are supplied dynamically and remain in their source language. When adding static UI copy, add matching keys to both language files and use `TranslatePipe` in templates or `ManagerStore.translateText()` in component logic.
