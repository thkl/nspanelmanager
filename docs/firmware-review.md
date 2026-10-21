# ESPHome Firmware Review

## Scope and summary

This is a static review of `esphome/nsp-livingroom.yaml`, the shared display implementation in `esphome/panel3.yaml`, and the manager's MQTT runtime and panel adapter. No firmware or application code was changed, and no ESPHome validation or hardware test was run.

The firmware already has a useful separation between reusable scripts and MQTT/UI event handlers, and it tracks the active page for several updates. There is still room to improve display-update behavior, input handling, configuration refreshes, and maintainability. The recommendations below preserve the current MQTT protocol unless a later firmware change is chosen.

## Firmware follow-up review (2026-10-21)

I rechecked the current `esphome/nsp-livingroom.yaml` and `esphome/panel3.yaml`. This was a static source review only; I did not run ESPHome validation or test on hardware.

### Highest-priority current finding

The music settings lambda previously used `player_id` before its per-entry declaration. This is fixed in the current working tree: the parser now reads the ID before assigning `musicPlayer[i]` and checking the `current` boolean (`panel3.yaml:852-856`). ESPHome validation has not been run, so the firmware still needs a build check.

### Other current improvement candidates

- A live `cmnd/settings` update sends the awake display to `page 0` (`panel3.yaml:871-875`). Preserve the current page when applying settings so updates do not interrupt the user.
- The `cmnd/weather` handler writes current values to the hidden weather page on every message, while it only writes the forecast when `currentPage` is `pageWeather` (`605-646`). Cache the complete latest weather snapshot and render it on page entry; send Nextion commands only when needed.
- MQTT strings are interpolated into Nextion commands without a common escape/length check. This includes weather fields, page labels, names, and message text (`605-665`, `781-827`). Add a bounded text helper for display strings. The `cmnd/nextion` handler passes the MQTT value directly to Nextion (`panel3.yaml:2876-2883`), so keep that topic restricted to trusted publishers.
- Settings arrays update only the entries provided (`781-827`), leaving previous button labels/modes in omitted slots. Clear defaults before applying a new config or reject payloads that do not have the expected shape and count.
- `cmnd/goto` changes the Nextion page without updating `currentPage` or reporting a page event (`584-590`); the `handle_pageShow` script is defined but has no call site. Use one page-transition helper for all navigation so screen gating and manager state stay aligned.
- Split `panel3.yaml` by feature after correctness fixes. It is now about 3,000 lines, so separating MQTT commands, display scripts, touch events, and hardware setup would make changes easier to review.

### Performance review

The likely optimization target is Nextion UART traffic, rather than CPU work. The loops in the handlers are small and bounded (typically 4-12 entries), so there is no obvious CPU-heavy algorithm in this configuration. I did not profile runtime behavior or measure UART throughput.

- `update_time` sends eight home-page updates every minute even when another page is active or the panel is asleep (`panel3.yaml:213-230`). `cmnd/weather` also writes current values to the weather page while it is hidden (`605-630`), and `update_music` writes the home-page song field on every invocation (`429-445`). Gate writes by page and sleep state, cache the latest values, and render them when that page opens.
- Several update scripts resend all fields on each trigger. Keep the last rendered values and send only fields that changed. This reduces serial work during repeated status updates while keeping the display in sync after page entry.
- The main-page refresh waits 10 seconds before asking the manager for home data (`1355-1370`). If the intent is to allow the HMI to initialize, prefer an immediate render from cached values followed by a short, explicit retry. This mainly improves perceived responsiveness.
- Fixed loops, `std::string` conversions, and the 12-iteration `pow()` loop in favorite rendering are unlikely to matter before display traffic is reduced. Optimize these only if ESPHome runtime metrics show CPU or heap pressure.

The opt-in `esphome/panel4.yaml` variant applies the low-risk changes above: it limits home and weather writes to their active pages, refreshes the home cache on page entry, skips unchanged home fields, avoids the duplicate air-quality write, gates the home song field, and uses an integer bit shift for favorite-state rendering. `esphome/nsp-livingroom.yaml` still includes `panel3.yaml`; switch that include to `panel4.yaml` to build the variant. The new YAML has not been compiled or tested on hardware.

## Recommended improvements

### 1. Guard all display updates by page and sleep state

The weather handler writes current temperature, rain, wind, and condition to the Nextion on every `cmnd/weather` message (`panel3.yaml:615-640`), while it checks `currentPage` only for forecast fields (`642-656`). This means an update can still generate UART traffic when the weather page is closed or the panel is asleep. Put the whole screen-rendering portion behind the page/sleep check. If background values must be retained, cache them in ESPHome state and render them when the weather page opens.

The settings handler also sends `page 0` whenever it receives configuration while `sleeping` is false (`876-880`). That can take the user away from the current page after a settings refresh. Consider separating boot-time initialization from live settings updates, or preserve the active page for live updates.

### 2. Escape text before building Nextion commands

Many MQTT-provided strings are interpolated directly into Nextion commands with `%s`, including page labels, titles, messages, weather conditions, and song names (for example `panel3.yaml:623-638`, `797-808`, `928-960`, and `1097-1101`). Quotes, backslashes, or control characters can break the intended text assignment. Add one helper that escapes or rejects unsupported characters and enforces the display’s text-length limits before sending any string to the panel.

The `cmnd/nextion` handler forwards its payload directly to `send_command_printf` (`2900-2906`). Keep that topic limited to trusted publishers with MQTT ACLs; it bypasses the safer, typed command handlers.

### 3. Make partial configuration updates deterministic

The `cmnd/settings` handler only overwrites button entries present in the incoming arrays (`795-810`, `819-830`). If a shorter configuration is accepted, omitted buttons can retain labels, modes, values, or favorites from the previous configuration. The info page similarly shows provided buttons but does not explicitly hide the remaining ones (`1103-1120`). Clear defaults for all supported slots first, then apply the supplied entries, or reject incomplete arrays if the manager always promises fixed lengths.

### 4. Validate MQTT payload types and ranges at the boundary

Most JSON handlers check for a key but then cast values directly. Examples include brightness (`727-736`), message timeout (`685-691`), page selection (`590-596`), and music player IDs (`854-873`). Add small parsing helpers that check types, clamp numeric values to firmware-supported ranges, bound array sizes, and reject invalid page/player identifiers before updating state or issuing display commands. This makes firmware behavior predictable even when a stale or malformed publisher sends a payload.

### 5. Split the shared YAML by feature

`panel3.yaml` is nearly 3,000 lines and contains boot setup, MQTT commands, display scripts, touch bindings, sensors, relays, and UART/display setup. Split it into ESPHome packages/includes by responsibility—for example `mqtt_commands.yaml`, `display_scripts.yaml`, `touch_events.yaml`, and `hardware.yaml`—while keeping `panel3.yaml` as the shared composition point. Keep topic names, page identifiers, and button mappings centralized so the split does not create duplicate protocol definitions.

## Operational notes

- The entry configuration enables `logger: DEBUG` (`nsp-livingroom.yaml:24-25`). For normal deployments, make the log level configurable or use `INFO` to reduce serial log volume; retain `DEBUG` for troubleshooting.
- Commands such as reboot, HMI update, and raw Nextion pass-through are intentionally powerful. Restrict their MQTT publish permissions to the manager or an administrator.
- The scripts already use `currentPage` for some selective updates (`update_display`, `update_level`, and brightness). Extending this pattern is a low-risk first firmware improvement.

## Display–manager interaction

The current path is: the panel publishes `<node>/event/display` with `booted`; the manager sends `<node>/cmnd/settings` and cached device state; page events select which plugin may send screen updates; button events return through `<node>/event/...`. The manager already caches plugin state and limits weather and thermostat page updates to an open page (`open-meteo-weather.plugin.ts:132-142`, `mqtt-runtime.ts:731-747`). The following gaps are worth addressing together with firmware changes:

### Reconnect needs an explicit resynchronization path

The manager calls `restoreAllPanels()` on every MQTT connection (`mqtt-runtime.ts:74-80`, `1117-1125`), but `publishPanelSettings()` skips an unchanged cached value (`228-246`), and the restore does not replay the favorite-state mask. Those caches survive a broker reconnect. The shared `publish()` uses MQTT.js defaults and records only that the publish call was issued (`1296-1299`); it does not confirm the panel applied the payload. If the panel restarted while the manager was disconnected, a missed `booted` event can leave it without settings until another request arrives. Conversely, retained page/session state can cause the restore to publish an old screen after a missed sleep event (`mqtt-runtime.ts:350-364`, `1104-1125`). Add a panel-ready/request acknowledgment and rebuild visibility from the panel's response before replaying state. Make that refresh page-neutral first, since firmware currently sends `page 0` on settings receipt.

### Report every real page transition

The manager clears its active native page when it receives an `event/page/...` topic (`mqtt-runtime.ts:388-409`). Firmware reports some pages, but the level, list, and universal page handlers mainly update `currentPage` locally or rely on a query/event specific to that feature (`panel3.yaml:1895-1908`, `2033-2056`). The generic `handle_pageShow` event script is defined at `325-334` but has no call site. Direct `cmnd/goto` and raw Nextion navigation also lack a consistent page acknowledgment. Emit one canonical page event for every actual page entry, including manager-initiated navigation, so page visibility, plugin updates, and dimmer rules agree.

### Avoid restarting the info page for state changes

The manager sends `page pageList` before every `cmnd/info` (`panel-protocol-adapter.ts:20-32`). Firmware's `cmnd/info` handler can already open that page when needed (`panel3.yaml:1057-1064`). Active plugin state changes call `showScreen()` again (`mqtt-runtime.ts:855-868`), so each update can resend the page command, reset page UI state, and add unnecessary MQTT/Nextion traffic. Let firmware own navigation for `cmnd/info`; distinguish opening a screen from updating its content, and skip an update when its rendered payload is unchanged.

### Refresh home tiles on page entry

Firmware publishes `event/page/page0` immediately but delays `event/query` with `main` by 10 seconds (`panel3.yaml:1371-1378`). The manager marks home active on the page event, yet refreshes all home tiles on the later query (`mqtt-runtime.ts:409-413`, `673-696`). Cached labels can therefore remain stale for that interval. Refresh from cached plugin state on `event/page/page0`, then keep a delayed query only if the panel needs a retry after its HMI initializes.

### Standardize event payloads and ordering

Music button events are built with single quotes, which are not JSON (`panel3.yaml:1630-1633`); the Sonos plugin needs a regex fallback (`mqtt-sonos.plugin.ts:175-189`). Favorite actions use one-based topic numbers while home tiles use zero-based numbers, and the manager still compensates for a favorite level-page offset (`panel-protocol-adapter.ts:50-52`, `mqtt-runtime.ts:941-947`). Document one versioned event schema with valid JSON payloads and explicit zero-based indices, then keep legacy decoding only during migration.

MQTT packet handlers also start without waiting for earlier handlers to finish (`mqtt-runtime.ts:85-105`). Page changes and device updates can therefore interleave across asynchronous plugin work. A per-panel event queue or a page-generation check before publishing would make the page state authoritative when messages arrive close together.

## Validation before firmware changes

After implementing changes, validate the merged configuration with `esphome config esphome/nsp-livingroom.yaml`, then test the affected page transitions and MQTT payloads on hardware. In particular, verify sleep/wakeup behavior, quote-containing labels, shorter configuration arrays, broker reconnect with a panel restart, rapid navigation, music controls, and live settings refreshes while a non-home page is open.
