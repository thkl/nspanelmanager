# Home Assistant plugin

This integration keeps the plugin contract and domain behavior separate. The
manager's plugin registry loads `HomeAssistantPlugin`; that class selects a
controller based on the configured entity domain and returns state updates or
MQTT commands to the existing runtime.

## File map

| File | Responsibility |
| --- | --- |
| `home-assistant.plugin.ts` | Plugin metadata, profile validation, polling, and dispatch to a domain controller. Start here to understand the full flow. |
| `home-assistant.api.ts` | Home Assistant REST and WebSocket calls, entity/area lookup, and normalization of HA state. |
| `home-assistant.switch.ts` | Shared one-tap toggle for switches, fans, input booleans, media players, and light favorites. |
| `home-assistant.light.ts` | Light tile input, color page, brightness, and configurable color presets. |
| `home-assistant.cover.ts` | Cover open/close, stop, position control, and the panel's native level page. |
| `home-assistant.vacuum.ts` | Vacuum info screen and its start/pause, dock, and locate actions. |

## How a panel action travels

1. `MqttRuntime` receives a panel event and calls a plugin hook.
2. `HomeAssistantPlugin` reads the entity domain from the instance's `entityId`.
3. The matching controller calls a Home Assistant service through
   `home-assistant.api.ts`.
4. The controller reads the entity again and returns a normalized `statePatch`.
5. `MqttRuntime` stores that patch and publishes any panel commands returned by
   the controller.

The plugin polls the selected entity using the profile's `pollSeconds` value.
`entityStatePatch()` is the shared mapping from Home Assistant attributes to
manager state. Add a field there when another controller needs a new piece of
entity state.

## Panel events by device type

### Switch-like entities

Tap the favorite to call `homeassistant.toggle`. This shared flow handles
`switch`, `fan`, `input_boolean`, and `media_player` entities.

### Lights

The light controller handles home-tile `item/{index}` events, native
`level/set/{index}` events, and color-page events. A light can use the panel's
native level page or open its color page on a long press. Both brightness
controls call `light.turn_on` or `light.turn_off`, then read state back from
Home Assistant. A tap turns the light on at the configured `lightOnBrightness`
when the light is off or reports zero brightness. The two color presets and
their brightness come from the plugin profile config.

### Covers and blinds

The cover controller handles favorite and home-tile events. The firmware's
level page asks for configuration with `event/level/{index}` and reports slider
changes with `event/level/set/{index}`. The controller replies with the
`cmnd/level/config` and `cmnd/level/status` messages and calls the Home
Assistant cover services.

### Vacuum robots

A favorite tap opens the generic plugin info screen. Its buttons call
`vacuum.start_pause`, `vacuum.return_to_base`, and `vacuum.locate`. A hardware
button uses Start/Pause directly because it has no screen to open.

## Adding another Home Assistant domain

1. Add the domain to the supported-domain set in `home-assistant.api.ts`.
2. Extend `entityStatePatch()` if the controller needs domain-specific state.
3. Add a focused controller file for the new panel behavior.
4. Route its favorite, screen, or home-tile hooks from `home-assistant.plugin.ts`.
5. Keep panel protocol details in that controller and HA HTTP/WebSocket details
   in `home-assistant.api.ts`.
6. Build with `pnpm --filter @nspanel/api build` and
   `pnpm --filter @nspanel/web build`.
