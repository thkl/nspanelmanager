# Security Review: nspanelmanager

This report preserves an earlier audit snapshot and its historical remediation notes. The focused 2026-10-23 revalidation of the four later findings, deployment checks, and local secret-file permissions is recorded in the final section below. Other findings in this historical report were not re-audited during that follow-up.

## Scope

Static security review of the NSPanel Manager TypeScript API, Angular entry points, authentication and session handling, MQTT and configured plugin scripts, local persistence, Docker deployment, and ESPHome panel configuration.

- Scan mode: repository
- Target kind: directory_snapshot
- Target ID: target_sha256_e3c0a350c5cb69322d6fcf0c4fd7e9ff134cb490a4d4a8181f8fb0ee372ab43b
- Snapshot digest: codex-security-snapshot/v1:sha256:104e80bbce7f2f0c8305b74e3b8075e4ef601122a0dfab5fff5b46e6423dd4b1
- Inventory strategy: directory
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: README.md, .gitignore, .dockerignore, Dockerfile, docker-compose.yml, docker-compose.sso.yml, apps/api/src/app.ts, apps/api/src/server.ts, apps/api/src/features/auth/auth.routes.ts, apps/api/src/features/auth/auth-service.ts, apps/api/src/features/auth/user-store.ts, apps/api/src/features/auth/password-hasher.ts, apps/api/src/routes/broker.ts, apps/api/src/services/mqtt-runtime.ts, apps/api/src/services/config-store.ts, apps/api/src/features/runtime/runtime-state-store.ts, apps/api/src/features/plugins/script-runtime.ts, apps/api/src/features/plugins/scripted-mqtt.plugin.ts, apps/web/src/app.component.ts, apps/web/src/app.component.html, apps/web/src/app/features/auth/auth-page.component.ts, apps/web/src/app/features/plugins/script-editor.component.ts, esphome/nsp-livingroom.yaml, esphome/panel3.yaml
- Scan context: The threat model was generated from repository source and configuration. Findings with network or firmware conditions state those conditions explicitly.

Limitations and exclusions:
- The actual public network exposure, TLS proxy, MQTT broker protocol and ACLs, panel provisioning, and firmware deployment were not verified.
- Third-party dependency vulnerability advisories were not assessed.
- Secret values are not reproduced in the findings.
- Excluded \*\*/node_modules/\*\*: Installed third-party dependency trees were not audited.
- Excluded \*\*/dist/\*\*: Generated build artifacts were not audited as source.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 9 |
| Severity mix | high: 1, medium: 4, low: 4 |
| Confidence mix | high: 9 |
| Coverage | partial |
| Validation mode | Source tracing and configuration review; filesystem metadata was checked for the referenced secret files. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

This report records the pre-remediation audit snapshot. Follow-up status: finding 1 was fixed in source on 2026-10-19; the remediation and verification scope are recorded below.

## Threat Model

NSPanel Manager is a single-process Express API with an Angular client. It manages local administrator accounts, optional OIDC, MQTT broker credentials and routes, panels, plugin instances, and administrator-authored JavaScript that can update device state and publish MQTT commands. ESPHome firmware communicates with the broker and separately exposes OTA and native API surfaces. Docker publishes the manager API and persists configuration in a volume.

### Assets

- Administrator credentials, sessions, OIDC client credentials, broker credentials, panel profiles, MQTT routes, plugin scripts, and runtime state.
- Home-device commands and state transported through the manager and MQTT broker.
- Panel firmware update access, exposed native API entities, and display configuration.

### Trust Boundaries

- Browser or network client to the HTTP API: setup and login are public; other management endpoints require an authenticated session.
- Manager process to local configuration, account, and runtime-state files and Docker volumes.
- Manager and ESPHome panels to the configured MQTT broker; broker authentication and per-topic ACLs are external deployment controls.
- ESPHome native API and OTA services to clients on networks that can reach the panel.
- Docker build client to builder and deployment network; TLS termination and builder trust are external.

### Attacker Capabilities

- An unauthenticated network client can reach the manager if its published port is exposed, including before first-account setup.
- An on-path observer can read credentials and messages if manager or panel connections use plaintext transport.
- An MQTT publisher can affect only the topics allowed by the external broker ACL, but matching messages may trigger manager processing and panel flow handling.
- A local host user can read files whose permissions allow access.

### Security Objectives

- Require a trustworthy bootstrap boundary before issuing the first administrator account.
- Protect login credentials, session tokens, broker credentials, and MQTT control data in transit and at rest.
- Authenticate panel control channels and bound untrusted MQTT input and durable processing work.
- Keep secret files restricted to the intended operator and prevent credentials from entering shared build contexts.

### Assumptions

- The operator reports accessing the manager behind Traefik, which terminates HTTPS. The Compose file still publishes the API's HTTP port; proxy routing and direct-port restrictions were not independently verified.
- The operator states that `esphome/` is a reference firmware folder and is not part of the manager deployment. The Docker runtime image copies the API and Angular build, not the ESPHome YAML.
- MQTT broker identity, TLS, ACLs, and network reachability are deployment-specific; the operator identifies broker ACLs as the control for panel event publishers.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [A network caller can claim the first administrator during onboarding — fixed in source](#finding-1) | high | high | inline below |
| [The panel MQTT configuration permits plaintext credentials and commands](#finding-2) | medium | high | inline below |
| [Matching MQTT traffic can create unbounded processing — persistence mitigated; ingress risk accepted](#finding-3) | medium | high | inline below |
| [Plain HTTP can expose login passwords and session cookies — accepted deployment risk](#finding-4) | medium | high | inline below |
| [The ESPHome native API has no configured encryption key — outside manager deployment scope](#finding-5) | medium | high | inline below |
| [MQTT publishers can spoof panel navigation events — broker ACL operational risk](#finding-6) | low | high | inline below |
| [A reverse proxy can make one login lockout affect every user — proxy-aware setting added](#finding-7) | low | high | inline below |
| [Local ESPHome and OIDC secret files are readable by other host users — operator remediation required](#finding-8) | low | high | inline below |
| [The panel OTA password now uses an ESPHome secret — outside manager deployment scope](#finding-9) | low | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] A network caller can claim the first administrator during onboarding

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Static tracing confirms the route is unauthenticated, creates the account, returns a session cookie, and runs before the authenticated API middleware. |
| Category | missing-authentication |
| CWE | CWE-306 |
| Affected lines | apps/api/src/features/auth/auth.routes.ts:19-23, apps/api/src/features/auth/auth.routes.ts:123-136, apps/api/src/app.ts:27-29, apps/api/src/features/auth/auth-service.ts:193-205, docker-compose.yml:4-12 |

#### Summary

The public `/api/auth/setup` route creates the first administrator and immediately issues a session. The Origin check is not an authentication control: a direct HTTP client can supply matching Origin and Host headers. Docker publishes port 3000, so an unauthenticated client that can reach an uninitialized instance can take over manager configuration and control its connected panels and MQTT routes.

#### Root Cause

The onboarding route relies on first-user status and a request-header Origin check, but neither proves that the caller is an authorized local operator. A network-reachable caller can create the account that becomes the administrator.

**Public setup issues the first session** — `apps/api/src/features/auth/auth.routes.ts:19-23`

The setup handler accepts caller-supplied account fields, invokes first-user creation, and returns the resulting session without a user-authentication guard.

```typescript
router.post("/setup", async (request, response, next) => {
  const result = await auth.createInitialUser(stringValue(request.body?.email), stringValue(request.body?.password));
  response.setHeader("Set-Cookie", auth.sessionCookie(result.token));
```

**Origin validation is not an authentication check** — `apps/api/src/features/auth/auth.routes.ts:123-136`

When no fixed origin is configured, the guard compares two request headers. A direct HTTP client can set both; even an exact configured Origin does not authenticate the caller.

```typescript
const allowed = configuredOrigin ? parsedOrigin.origin === configuredOrigin : parsedOrigin.host === request.get("host");
```

**Authentication middleware follows the auth router** — `apps/api/src/app.ts:27-29`

The authentication router, including first-user setup, is mounted before the protected management API middleware.

```typescript
app.use("/api", requireSameOrigin(process.env.APP_PUBLIC_URL?.trim() ?? ""));
app.use("/api/auth", createAuthRouter(authService, logger));
app.use("/api", requireAuthenticatedUser(authService));
```

#### Validation

Reviewed route registration, origin middleware, first-user creation, and Compose port mapping. No live endpoint was called.

Validation method: static source trace

Assertions:
- The setup route has no authentication middleware.
- The first successful setup creates a session for the new account.
- Origin and Host are caller-controlled on direct HTTP requests.

Limitations:
- The actual deployment network and whether setup has already been completed were not verified.

#### Dataflow

HTTP setup request -\> public auth router -\> createInitialUser() -\> persisted first account -\> session cookie

- **Source:** Unauthenticated network client

- **Sink:** First administrator account and session

- **Outcome:** Manager-wide configuration access

#### Reachability

Requires network reachability while no account exists.

- **Attacker:** Unauthenticated network client

- **Entry point:** POST /api/auth/setup

- **Outcome:** Administrator session

Preconditions:
- The manager has no existing local account.
- The service is reachable from the attacker’s network.

#### Severity

**High** — Successful setup grants administrator access to the manager, including broker settings, scripts, routes, and user management. The risk exists only before the first account is created, but the default Compose port is network-published.

Risk is substantially reduced when setup is restricted to loopback or protected by a one-time bootstrap secret and the service is not reachable by untrusted clients before setup.

Impact assessment:
- **Level:** high
- **Why:** The created account can configure MQTT, panels, routes, plugin scripts, and other users.

#### Original remediation recommendation

Restrict first-user setup to loopback or require a one-time bootstrap secret delivered out of band; keep the endpoint closed to network clients until an operator completes setup.

Tests:
- Verify a network request without the bootstrap secret cannot create the first user.
- Verify successful local setup consumes the one-time bootstrap credential and later setup attempts remain rejected.

Preventive controls:
- Keep onboarding authorization separate from Origin/CSRF validation.

#### Follow-up remediation status — 2026-10-19

**Status: Fixed in source.** The API now generates a random 256-bit token at startup when no local users exist, logs it for the operator, and requires it on the first-user setup request. The token is compared in constant time, cleared after the first account is persisted, and is not returned by the status API. Restarting before setup generates a new token.

**Validation:** `pnpm run build` passed. An HTTP security regression check was not run, so the runtime behavior has not been independently exercised against the original attack request.

<a id="finding-2"></a>

### [2] The panel MQTT configuration permits plaintext credentials and commands

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The panel MQTT block omits TLS configuration, and manager source explicitly accepts plaintext schemes and passes credentials to the client; actual broker network placement is unknown. |
| Category | cleartext-transmission |
| CWE | CWE-319 |
| Affected lines | esphome/panel3.yaml:565-568, apps/api/src/routes/broker.ts:20-21, apps/api/src/services/mqtt-runtime.ts:52-62 |

#### Summary

This finding concerns MQTT transport encryption, not the manager API returning the saved password. The API removes `password` from its public broker configuration and returns only `passwordConfigured`. Separately, the included ESPHome MQTT configuration sets a broker, username, and password without TLS settings. The manager also accepts `mqtt://` and `ws://` broker URLs and passes saved credentials directly to MQTT.js. On an untrusted network path, an observer can capture credentials and home-automation messages; a party able to publish under those credentials may also issue device commands.

#### Root Cause

TLS is optional in both manager URL validation and the included panel MQTT settings, leaving credential confidentiality dependent on operator-selected broker transport and network placement.

**Broker validation accepts plaintext MQTT and WebSocket schemes** — `apps/api/src/routes/broker.ts:36-40`

The broker validator permits both encrypted and unencrypted transport schemes.

```typescript
return ["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol) && !url.username && !url.password;
```

**Saved credentials are passed to the MQTT client** — `apps/api/src/services/mqtt-runtime.ts:52-62`

When a plaintext broker URL is configured, the username and password are supplied over that transport.

```typescript
const client = mqtt.connect(broker.url, {
  username: broker.username || undefined,
  password: broker.password || undefined,
  clientId: `nspanel-manager-${Math.random().toString(16).slice(2, 10)}`
});
```

#### Validation

Reviewed the ESPHome MQTT block, broker scheme validator, and MQTT client construction.

Validation method: static source and configuration review

Limitations:
- The actual broker endpoint and whether the broker network is trusted were not verified.

#### Dataflow

MQTT credentials and messages -\> plaintext TCP/WebSocket transport -\> network observer

- **Source:** Configured panel or manager MQTT client

- **Sink:** Unencrypted broker connection

- **Outcome:** Credential and message exposure

#### Reachability

Requires an unencrypted MQTT path that an attacker can observe.

- **Attacker:** On-path network observer

- **Entry point:** MQTT broker connection

- **Outcome:** Captured credentials, state, or commands

Preconditions:
- The deployed panel or manager uses a plaintext scheme.
- The attacker can observe the network path.

#### Severity

**Medium** — MQTT credentials and control messages can be exposed when the configured network is not trusted. The source supports TLS schemes, but does not require them.

Risk is reduced when both panel and manager use a TLS-protected broker endpoint and broker ACLs restrict each identity.

Impact assessment:
- **Level:** medium
- **Why:** Captured MQTT credentials may allow device-state access or command publication subject to broker ACLs.

#### Remediation

Use `mqtts://` or `wss://` for manager connections and configure certificate-validated TLS for ESPHome MQTT; avoid sending broker credentials over plaintext transports.

Tests:
- Verify production broker configuration rejects plaintext schemes when credentials are present.
- Verify the panel establishes a TLS-protected MQTT session using certificate validation.

Preventive controls:
- Use unique broker credentials and topic ACLs for the manager and each panel.

#### Follow-up classification — 2026-10-19

**Classification: Operational deployment risk.** Plain MQTT is commonly used on trusted private smart-home networks, and the manager intentionally supports both plaintext and TLS broker schemes for compatibility. The finding is conditional on network exposure or an attacker able to observe the broker path; it does not indicate that the manager API returns the saved password. Operators may accept plaintext on an isolated, access-controlled LAN. Use network segmentation, unique broker credentials, and topic ACLs to limit the impact; use TLS when MQTT crosses an untrusted network or trust boundary.

<a id="finding-3"></a>

### [3] Matching MQTT traffic can create unbounded processing and disk-write work

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Static tracing confirms unbounded payload conversion, asynchronous dispatch without backpressure, full state persistence for matching messages, and a write queue with no bound. |
| Category | unbounded-resource-consumption |
| CWE | CWE-400 |
| Affected lines | apps/api/src/services/mqtt-runtime.ts:75-92, apps/api/src/services/mqtt-runtime.ts:273-279, apps/api/src/features/plugins/scripted-mqtt.plugin.ts:214-216, apps/api/src/features/runtime/runtime-state-store.ts:121-130, apps/api/src/features/plugins/script-runtime.ts:97-117 |

#### Summary

The MQTT listener converts every packet to a string and starts asynchronous handling without backpressure. For a matching scripted plugin filter, the runtime stores the complete message as plugin state and writes a full runtime-state snapshot for each delivery through an unbounded promise queue. A broker publisher allowed to write to that filter can generate enough traffic or payload volume to exhaust manager memory, CPU, or storage throughput.

#### Root Cause

Inbound packet processing is not bounded before payload conversion, and each matching state message independently serializes and queues a complete runtime-state snapshot.

**Each inbound packet is dispatched without backpressure** — `apps/api/src/services/mqtt-runtime.ts:75-92`

The callback converts the entire payload to a string and schedules processing without limiting message size or the number of concurrent handlers.

```typescript
client.on("message", (topic, payload, packet) => {
  const envelope = { topic, payload: payload.toString(), qos: packet.qos, retain: packet.retain, receivedAt: Date.now() };
  void this.handleMessage(envelope).catch(...);
});
```

**Matched plugin messages persist state** — `apps/api/src/services/mqtt-runtime.ts:273-279`

A matching plugin message becomes persisted device state before the runtime refreshes bound panels.

```typescript
const patch = definition.decodeMessage(instance, message);
if (!patch || Object.keys(patch).length === 0) continue;
const state = { ...this.runtimeState.getPluginState(instance.id), ...patch };
await this.runtimeState.setPluginState(instance.id, state);
```

**Full snapshots are queued without a queue limit** — `apps/api/src/features/runtime/runtime-state-store.ts:121-130`

Each persistence call serializes the full snapshot and appends another write to a promise chain; no queue limit or coalescing is applied.

```typescript
const data = `${JSON.stringify(structuredClone(this.snapshot), null, 2)}\n`;
const write = async (): Promise<void> => { /* write snapshot */ };
this.writeQueue = this.writeQueue.then(write, write);
```

#### Validation

Traced the MQTT message event through matching plugin dispatch to RuntimeStateStore persistence.

Validation method: static source trace

Assertions:
- The MQTT callback does not await or otherwise limit concurrent handleMessage calls.
- Matching plugin messages persist their updated state.
- The persistence queue has no maximum length or coalescing.

Limitations:
- The broker's packet-size and rate limits were not available for review.

#### Dataflow

MQTT payload -\> string conversion and dispatch -\> plugin state update -\> full snapshot serialization and queued disk write

- **Source:** Publisher allowed by broker ACL to write a subscribed topic

- **Sink:** Manager CPU, memory, and storage queue

- **Outcome:** Manager resource exhaustion or degraded operation

#### Reachability

Requires publish permission to an enabled plugin's configured topic filter.

- **Attacker:** MQTT publisher

- **Entry point:** Subscribed MQTT topic

- **Outcome:** Unbounded work and persistence backlog

Preconditions:
- An enabled plugin matches the topic.
- The external broker does not enforce adequate size/rate limits.

#### Severity

**Medium** — The source has no application-level ingress size, concurrency, or persistence-queue bound. The attack requires broker publish permission to a matching topic, and broker-enforced limits are outside this repository.

Risk is reduced if the broker enforces strict message-size and rate limits and the manager coalesces or bounds its own message-processing and persistence work.

Impact assessment:
- **Level:** medium
- **Why:** The manager can become unresponsive or fail to keep up with device state and control messages.

#### Remediation

Reject oversized MQTT packets before string conversion or parsing, bound message-processing concurrency and queue length, and coalesce superseded state snapshots instead of writing every update.

Tests:
- Verify oversized messages are rejected before payload parsing or persistence.
- Verify sustained matching topic traffic cannot grow an unbounded in-memory processing or write queue.

Preventive controls:
- Set explicit MQTT packet, per-topic rate, and state persistence bounds.

#### Follow-up remediation status — 2026-10-19

**Status: Partially mitigated; residual ingress risk accepted.** Normalized plugin state, including the latest MQTT message, stays in memory and does not trigger a runtime-state file write for every matching message. Existing runtime files are migrated to remove the old persisted `pluginStates` field while retaining panel sessions and explicit script storage. Scripts can opt into durable state with `global.set`, `plugin.set` (per instance), or `panel.set`. These writes update memory immediately and coalesce into at most one full snapshot write per second; script storage is capped at 4,096 values, 2 MiB total, and 64 KiB per value.

**Accepted tradeoff at the time of this review:** The operator did not want application-level MQTT packet-size, rate, or concurrency limits because rejecting or dropping legitimate messages could lose device updates. No such limits were planned. Without them, bursts could create many concurrent handlers and consume substantial CPU or memory. Repeated script storage writes can cause at most one full snapshot write per second. Graceful SIGINT/SIGTERM shutdown stops ingress and flushes pending runtime state; forced termination or power loss can lose changes since the last snapshot. `pnpm run build` passed after the persistence changes; no sustained-traffic regression check was run.

#### Follow-up — 2026-10-22

MQTT message dispatch now uses MQTT.js `handleMessage` backpressure: the runtime awaits each asynchronous handler before releasing the next inbound packet. This preserves processing order and avoids spawning an unbounded set of concurrent handlers without rejecting accepted messages. Shutdown and manual broker replacement wait for current dispatch work to finish. Application-level packet-size and rate limits remain absent, and QoS 0 messages still cannot be recovered after a connection loss. The workspace build passed; sustained-load behavior has not been measured.

<a id="finding-4"></a>

### [4] Plain HTTP can expose login passwords and session cookies

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The HTTP listener, Compose port mapping, and conditional Secure cookie behavior are directly visible; the actual deployment path was not verified. |
| Category | cleartext-transmission |
| CWE | CWE-319 |
| Affected lines | apps/api/src/server.ts:53, apps/api/src/features/auth/auth-service.ts:220-224, docker-compose.yml:4-12 |

#### Summary

The API listens on plain HTTP, and the base Compose file publishes port 3000 without requiring an HTTPS proxy. When `APP_PUBLIC_URL` is unset or uses HTTP, the session cookie omits `Secure`. If a user accesses that endpoint over an untrusted network, a network observer can capture login credentials or reuse the session cookie.

#### Root Cause

The deployment exposes HTTP directly and leaves HTTPS optional. Cookie security follows `APP_PUBLIC_URL`, but startup permits the variable to be empty even when the listener is reachable on the network.

**API starts an HTTP listener** — `apps/api/src/server.ts:53`

The server uses Express's plain HTTP listener and does not terminate TLS in this process.

```typescript
createApp(store, mqttRuntime, pluginRegistry, authService, logger).listen(port, ...);
```

**Secure cookie depends on HTTPS public URL configuration** — `apps/api/src/features/auth/auth-service.ts:220-224`

If the public URL is absent or HTTP, the browser receives the session cookie without the Secure attribute.

```typescript
const secure = this.publicUrl.startsWith("https:") ? "; Secure" : "";
return `nspanel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}${secure}`;
```

#### Validation

Reviewed the API listener, cookie construction, Compose port mapping, and README HTTPS guidance.

Validation method: static configuration and source review

Limitations:
- No deployed proxy, firewall, or browser-facing TLS configuration was available for review.

#### Dataflow

Browser credentials/session -\> plain HTTP port -\> network observer

- **Source:** Browser login and session cookie

- **Sink:** Unencrypted network traffic

- **Outcome:** Credential or session theft

#### Reachability

Requires the manager to be accessed over plain HTTP and an attacker able to observe the route.

- **Attacker:** On-path network observer

- **Entry point:** Published HTTP port 3000

- **Outcome:** Captured login or session

Preconditions:
- No TLS terminator protects the browser-facing connection.
- The attacker can observe the connection.

#### Severity

**Medium** — Captured credentials or session tokens permit access to protected manager APIs. Exploitation requires an HTTP deployment and an attacker able to observe its network traffic.

This exposure is reduced when port 3000 is reachable only through a trusted TLS terminator and `APP_PUBLIC_URL` is set to the HTTPS origin.

Impact assessment:
- **Level:** medium
- **Why:** A stolen session provides access to authenticated manager APIs.

#### Remediation

Require an HTTPS public origin for non-loopback deployments and bind the application port only to a trusted TLS proxy; reject insecure remote deployment configuration at startup.

Tests:
- Verify non-loopback deployment configuration fails startup unless `APP_PUBLIC_URL` uses HTTPS.
- Verify all authenticated session cookies include `Secure` in the supported remote deployment.

Preventive controls:
- Keep remote access behind TLS and prevent direct access to the container HTTP port.

#### Follow-up classification — 2026-10-19

**Status: Accepted operational risk for the reported home deployment.** The operator reports that Traefik terminates HTTPS before requests reach the manager. The API's HTTP listener is intentional for this deployment, with certificate lifecycle handled by the reverse proxy; a native HTTPS listener is a possible later option. Set `APP_PUBLIC_URL` to the browser-facing HTTPS origin so session cookies include `Secure`. The base Compose file still publishes port 3000, so restrict direct access to that port if the proxy is the intended ingress. Traefik configuration and host firewall rules were not independently reviewed.

<a id="finding-5"></a>

### [5] The ESPHome native API has no configured encryption key

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The source config enables `api:` without `encryption:` and defines externally visible relay entities; whether this firmware is currently flashed is unknown. |
| Category | missing-authentication |
| CWE | CWE-306 |
| Affected lines | esphome/nsp-livingroom.yaml:21-22, esphome/panel3.yaml:2881-2907 |

#### Summary

The active panel configuration enables the ESPHome native API without an encryption key. The included panel YAML exposes two GPIO relay switches as non-internal entities. A client on a network that can reach the panel API may read exposed state or operate those relays.

#### Root Cause

The panel API is enabled without the encryption-based client authentication configured by ESPHome, while relay entities are exposed to API clients.

**Native API has no encryption configuration** — `esphome/nsp-livingroom.yaml:21-22`

The active entry point enables the native API but supplies no encryption key.

```yaml
api:
  reboot_timeout: 0s
```

**Panel configuration exposes relay controls** — `esphome/panel3.yaml:2881-2907`

The included firmware exposes GPIO relay entities through ESPHome integrations, so unauthenticated native API access can affect device outputs.

```yaml
- platform: gpio
  internal: false
  name: Relay 1
  id: relay_1
  pin:
    number: 22
# A second non-internal GPIO relay is also defined.
```

#### Validation

Reviewed the active YAML entry point and included GPIO relay definitions; no panel connection was attempted.

Validation method: static firmware configuration review

Limitations:
- Firmware deployment and network reachability to the native API port were not verified.

#### Dataflow

Unauthenticated native API client -\> ESPHome API -\> exposed relay entity

- **Source:** Network client

- **Sink:** GPIO relay control

- **Outcome:** Unauthorized relay operation

#### Reachability

Requires the panel API port to be reachable from the attacker's network.

- **Attacker:** Unauthenticated network client

- **Entry point:** ESPHome native API

- **Outcome:** Relay control or device-state access

Preconditions:
- The reviewed firmware is deployed.
- The API is reachable from the attacker’s network.

#### Severity

**Medium** — Unauthorized relay control is a home-automation impact, but exploitation requires network reachability to the panel and deployment of this firmware configuration.

Risk is reduced if the API is not reachable from untrusted networks or if the firmware uses an ESPHome API encryption key.

Impact assessment:
- **Level:** medium
- **Why:** A relay output can control attached equipment, depending on the hardware installation.

#### Remediation

Configure ESPHome API encryption with a secret key and restrict native API reachability to trusted management hosts or networks.

Tests:
- Verify API clients without the configured encryption key cannot connect.
- Verify the key is loaded from an ignored secret file rather than committed firmware YAML.

Preventive controls:
- Keep the native API off untrusted network segments.

#### Follow-up classification — 2026-10-19

**Status: Out of the deployed manager application's scope.** The operator says the `esphome/` files are repository reference material for the agent and are not deployed with the manager. The Docker runtime image copies the API and Angular output, not this firmware configuration. This remains relevant only if the reviewed YAML is separately flashed to a panel; in that case API encryption and network ACLs remain recommended.

<a id="finding-6"></a>

### [6] MQTT publishers can spoof panel navigation events

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | The manager subscribes to panel event wildcards and handles matching topic/payload pairs without an authenticated publisher identity; broker ACLs were not available. |
| Category | insufficient-authenticity-verification |
| CWE | CWE-345 |
| Affected lines | apps/api/src/services/mqtt-runtime.ts:148, apps/api/src/services/mqtt-runtime.ts:240-255, apps/api/src/features/panels/panel-protocol-adapter.ts:38-49 |

#### Summary

The runtime trusts the topic prefix as proof that a panel produced an event. A broker client allowed to publish to a panel's event topics can open a configured favorite page or clear an active plugin page, disrupting panel navigation. The source does not establish that such clients can invoke arbitrary button actions without a current binding identifier.

#### Root Cause

The panel protocol treats MQTT topic and payload as an authenticated device event, but the broker message contains no verified sender identity.

**Runtime subscribes to panel event topics** — `apps/api/src/services/mqtt-runtime.ts:148`

The manager receives all event topics under each configured panel name.

```typescript
for (const panel of config.panels) desiredTopics.add(`${panel.nodeName}/event/#`);
```

**Event handling trusts topic and payload** — `apps/api/src/services/mqtt-runtime.ts:244-255`

The message topic selects a panel, and matching events affect its flow state without any publisher identity check in the MQTT envelope.

```typescript
const eventPanel = config.panels.find((panel) => topic.startsWith(`${panel.nodeName}/event/`));
if (eventPanel && isPanelPageEvent(eventPanel, topic)) await this.clearActivePluginPage(eventPanel);
// Matching display and favorite events are handled as panel input.
```

#### Validation

Reviewed MQTT subscriptions, event-panel selection, page clearing, and panel-event decoding.

Validation method: static source trace

Limitations:
- Broker identities and topic ACLs were not available for review.

#### Dataflow

Forged MQTT event -\> topic-based panel selection -\> flow-state transition -\> panel command

- **Source:** Broker client permitted to publish a panel event

- **Sink:** Panel session state and display command

- **Outcome:** Forced navigation or disruption

#### Reachability

Requires publish permission to a configured panel's event topic.

- **Attacker:** MQTT publisher

- **Entry point:** \<nodeName\>/event/#

- **Outcome:** Panel-flow manipulation

Preconditions:
- The broker permits a non-panel client to publish to the panel event topic.

#### Severity

**Low** — The impact established by source review is limited to panel-flow manipulation; command execution requires additional event/session data and broker permissions.

Risk is reduced when broker ACLs grant each panel exclusive publish access to its own event topics and deny those topics to other clients.

Impact assessment:
- **Level:** low
- **Why:** Source validation establishes navigation and screen disruption; arbitrary action invocation was not established.

#### Remediation

Use per-panel MQTT identities and broker ACLs so only the corresponding panel can publish to its event topics; treat broker authorization as the device-authentication boundary.

Tests:
- Verify a non-panel broker identity cannot publish to any configured panel event topic.

Preventive controls:
- Keep panel event publish rights exclusive to each panel identity.

#### Follow-up classification — 2026-10-19

**Status: Accepted operational risk controlled by broker policy.** The operator accepts that MQTT topic and payload alone do not authenticate a panel publisher and relies on broker access control. Configure broker ACLs so each panel identity can publish only to its own `<nodeName>/event/#` topics and other clients cannot publish there. The broker's actual identities and ACL rules were not independently reviewed.

<a id="finding-7"></a>

### [7] A reverse proxy can make one login lockout affect every user

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | At the initial review, the route keyed the limiter by the socket peer, Express did not configure trusted proxy handling, and the limiter blocked an address after eight failures. |
| Category | uncontrolled-resource-consumption |
| CWE | CWE-400 |
| Affected lines | apps/api/src/features/auth/auth.routes.ts:32-43, apps/api/src/features/auth/auth-service.ts:9-12, apps/api/src/features/auth/auth-service.ts:267-285, apps/api/src/app.ts:22-29 |

#### Summary

Login attempts are throttled by `request.socket.remoteAddress`. Behind a typical reverse proxy, the API sees the proxy as the peer for every browser. Eight bad attempts then block all users sharing that proxy address for 15 minutes, allowing one unauthenticated client to deny service to all manager users.

#### Root Cause

The rate-limit key is the TCP peer address rather than a validated client identity, so proxy deployments collapse all users into one lockout bucket.

**Login limiter uses the direct socket peer** — `apps/api/src/features/auth/auth.routes.ts:32-38`

Every request arriving through the same reverse proxy is keyed to the proxy socket address unless the app is explicitly configured to trust a proxy.

```typescript
const result = await auth.login(email, password, request.socket.remoteAddress ?? "unknown");
```

**Eight failures block the shared address** — `apps/api/src/features/auth/auth-service.ts:9-12`

The threshold and duration make a small number of failed requests block the entire peer address for a fixed period.

```typescript
const loginWindowMs = 15 * 60 * 1000;
const maximumLoginFailures = 8;
```

#### Validation

Reviewed the login route, limiter key and threshold, and Express initialization.

Validation method: static source trace

Limitations:
- The deployed proxy behavior and external rate limits were not verified.

#### Dataflow

Failed login requests -\> proxy peer address -\> shared lockout bucket

- **Source:** Unauthenticated login requests

- **Sink:** Login rate-limit state for the proxy address

- **Outcome:** Temporary denial of login for all users behind the proxy

#### Reachability

Requires a shared reverse proxy and access to its login route.

- **Attacker:** Unauthenticated client

- **Entry point:** POST /api/auth/login

- **Outcome:** 15-minute shared login lockout

Preconditions:
- Manager is deployed behind a shared proxy.
- No proxy-side rate limit blocks the attack first.

#### Severity

**Low** — The issue is a temporary login denial of service and requires a deployment behind a shared reverse proxy; it does not bypass authentication.

This risk is lower for direct connections with distinct client addresses or when the proxy independently rate-limits and protects the login route.

Impact assessment:
- **Level:** low
- **Why:** The attack blocks login temporarily but does not create a session or affect already authenticated sessions.

#### Remediation

Configure a trusted proxy policy to derive client IPs safely, or replace IP-only throttling with account-scoped and proxy-aware controls that prevent one source from locking out every user.

Tests:
- Verify requests from distinct forwarded client addresses use distinct rate-limit buckets only when the forwarding proxy is explicitly trusted.
- Verify repeated failures from one client do not block unrelated users sharing the proxy.

Preventive controls:
- Apply rate limiting at both the trusted edge proxy and application login boundary.

#### Follow-up remediation status — 2026-10-19

**Status: Proxy-aware support added; deployment configuration required.** Express now accepts `TRUST_PROXY` and defaults to `false`. The login route keys throttling from `request.ip`, which uses the socket peer by default and forwarded client addresses only through the configured Express trust policy. Set the value to the exact Traefik IP/CIDR or trusted proxy subnet to avoid a shared lockout bucket. Express also supports hop counts and `true`; use those only when the proxy topology is fixed, the proxy overwrites forwarded headers, and direct API access is blocked, because untrusted forwarded headers can otherwise spoof client addresses. Compose passes the setting from `.env`, and `.env.example` documents it.

**Validation:** `pnpm --filter @nspanel/api build` passed. No request-level proxy spoofing or lockout integration check was run; the actual Traefik network and header configuration remain deployment proof gaps.

<a id="finding-8"></a>

### [8] Local ESPHome and OIDC secret files are readable by other host users

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Filesystem metadata confirms mode 0644 for both files and traversable parent directories; file contents are intentionally omitted. |
| Category | insufficiently-protected-credentials |
| CWE | CWE-522, CWE-732 |
| Affected lines | esphome/secrets.yaml:1, secrets/oidc_client_secret:1 |

#### Summary

Filesystem metadata shows `esphome/secrets.yaml` and `secrets/oidc_client_secret` are mode 0644, with parent directories traversable by other users. These are secret-source files used by the ESPHome and OIDC configuration. A local user with an account on the same host can read any credentials stored in them. Secret values are not included in this report.

#### Root Cause

Secret files are created with world-readable permissions rather than owner-only access. Ignore rules reduce source-control exposure but do not restrict other local users.

#### Validation

Checked permissions using filesystem metadata only; no secret values are reproduced.

Validation method: filesystem metadata inspection

Assertions:
- Both secret files have mode 0644.
- The containing directories allow traversal by other users.

#### Dataflow

World-readable secret file -\> local user or workspace recipient

- **Source:** Secret file on the host

- **Sink:** Local filesystem read

- **Outcome:** Credential disclosure

#### Reachability

Requires a local account or access to a copy of the workspace.

- **Attacker:** Local user or workspace recipient

- **Entry point:** Readable file path

- **Outcome:** Read access to stored credentials

Preconditions:
- The files contain active credentials.
- The attacker can access the same host or workspace copy.

#### Severity

**Low** — The exposure is limited to local users or recipients of the workspace, and the files are ignored by Git; it does not establish network access by itself.

Severity increases on a shared host or if these files are synchronized, backed up, or included in a workspace archive accessible to other users.

Impact assessment:
- **Level:** low
- **Why:** Credentials may be reused against local network services or the configured OIDC client, depending on their scope.

#### Remediation

Change both secret files to owner-only permissions (for example, mode 0600), verify ownership, and rotate their contents if another host user or workspace recipient may have read them.

Tests:
- Verify secret-source files are mode 0600 and inaccessible to other local users.

Preventive controls:
- Create secret files with restrictive permissions and keep values outside synchronized or shared workspaces.

#### Follow-up classification — 2026-10-19

**Status: Operations remediation required.** The operator confirms this must be fixed on the host. Set owner-only permissions (for example, `chmod 600 esphome/secrets.yaml secrets/oidc_client_secret`), verify the files are owned by the intended operator, and restrict parent directories where appropriate. Rotate any credential if another host user or workspace recipient may have accessed it. No secret files were modified; verify permissions and record the result after the operational change.

<a id="finding-9"></a>

### [9] The panel firmware source contains a hardcoded OTA password

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | The active YAML contains a literal OTA password field; the actual credential validity and deployed firmware version were not tested. |
| Category | hard-coded-credentials |
| CWE | CWE-798 |
| Affected lines | esphome/nsp-livingroom.yaml:17-19 |

#### Summary

The active ESPHome entry point sets the OTA password as a literal in `esphome/nsp-livingroom.yaml`. Anyone who receives this source and can reach a panel running the corresponding firmware may use the credential to install unauthorized firmware. The credential value is intentionally redacted from this report; deployment and source-sharing status are unknown.

#### Root Cause

The active firmware configuration embeds a reusable OTA credential directly in a source file that is not excluded by the repository's ignore rules.

**Inline OTA password field (value redacted)** — `esphome/nsp-livingroom.yaml:17-19`

The firmware entry point contains a literal OTA password rather than a secret-file reference. The value is withheld from this report.

```yaml
ota:
  - platform: esphome
    password: "[REDACTED]"
```

#### Validation

Reviewed the active ESPHome OTA stanza; the credential value was not included in the finding.

Validation method: static configuration review

Limitations:
- The source repository's sharing history and the device's installed firmware were not verified.

#### Dataflow

Firmware source -\> OTA password disclosure -\> panel OTA service

- **Source:** Reader of the firmware source

- **Sink:** ESPHome OTA update service

- **Outcome:** Unauthorized firmware installation

#### Reachability

Requires source access and network reachability to a panel running this firmware.

- **Attacker:** Source reader with network access to the panel

- **Entry point:** ESPHome OTA service

- **Outcome:** Firmware modification

Preconditions:
- The configuration is shared with the attacker.
- The panel runs firmware using this credential.
- The OTA service is network-reachable.

#### Severity

**Low** — A reusable device-update credential is embedded in source, but exploitation also requires access to the source and network reachability to a panel using that firmware.

Severity increases if this file has been distributed or committed to a shared/public repository and the same credential remains active on a reachable device.

Impact assessment:
- **Level:** medium
- **Why:** An unauthorized firmware update could alter the panel's behavior or expose its network credentials.

#### Remediation

Rotate the OTA credential if it has been used, then replace the literal with an ESPHome `!secret` reference stored in an ignored file and keep it out of shared build artifacts.

Tests:
- Verify the source entry point contains only a `!secret` reference for OTA authentication.
- Verify an old credential cannot authenticate to a panel after firmware rotation.

Preventive controls:
- Keep all firmware credentials in protected secret files and scan active entry points for literals.

#### Follow-up remediation status — 2026-10-19

**Status: Fixed in the local firmware source; outside the deployed manager application's scope.** The operator reports moving the OTA password to `esphome/secrets.yaml`. A value-redacting check confirms the active YAML now uses an ESPHome `!secret` reference; the secret value was not displayed. The `esphome/` folder is development/reference material and is not deployed with the manager. Protect the secret file and its parent directory as described in finding 8. The panel's installed firmware and whether the previous password was rotated on-device were not verified.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Docker build context and builder handling | build secrets | Needs follow-up | The root secrets directory is not excluded by .dockerignore; whether the builder is local or remote is unknown. |
| Third-party dependency advisories | supply chain | Needs follow-up | Package advisories and runtime dependency behavior were not assessed. |
| First-run setup, local authentication, and session handling | authentication and session security | Reported | No additional canonical notes were recorded. |
| OIDC flow and account authorization | identity and access control | No issue found | Source review found PKCE, state, nonce, verified-email linking, hashed session tokens, and Argon2id password hashing; deployment configuration remains unverified. |
| HTTP exposure and session-cookie transport | transport security | Accepted operational risk | Operator reports Traefik terminates HTTPS; direct access to the published API port and proxy configuration were not reviewed. |
| MQTT transport, event handling, and message ingestion | message authenticity and resource exhaustion | Accepted availability tradeoff / operational ACL risk | The operator does not want application traffic limits that may drop legitimate updates; burst resource exhaustion remains an accepted risk. Panel spoofing is controlled by broker ACLs per operator; actual ACLs remain unverified. |
| Scripted plugin execution and browser rendering sinks | code execution and XSS | No issue found | Focused source review found phase-limited QuickJS effects and no unsafe Angular HTML sink; full dependency behavior was not assessed. |
| ESPHome OTA, native API, and MQTT configuration | device access and firmware configuration | Outside deployed manager scope | Operator says the ESPHome folder is reference material and not part of the manager deployment; the active YAML now uses `!secret`, but installed firmware was not checked. |
| Local secret-file permissions | credential storage | Operations remediation required | Set owner-only permissions, verify ownership and parent-directory access, then record the host-side result; see finding 8. |

## Open Questions And Follow Up

- Verify Traefik sends the browser-facing HTTPS origin through `APP_PUBLIC_URL`, and restrict direct access to the published API port if Traefik is the intended ingress. Configure `TRUST_PROXY` to Traefik's exact IP/CIDR or trusted subnet.
- Verify the MQTT broker enforces per-client topic ACLs for panel event topics and plugin subscriptions; review TLS separately according to the home network's trust boundaries.
- Does the Docker build use a remote or shared builder that receives root secrets in the build context?
- Compose builds from the repository root and .dockerignore does not exclude root secrets/. The Dockerfile does not copy that directory into image layers, but the builder receives included context files; builder locality and trust are unknown.
  - Follow-up prompt: Review deferred unit docker-build-context and close its stated proof gap. Paths: .dockerignore, docker-compose.yml, docker-compose.sso.yml, Dockerfile.
- Confirm actual Traefik routing, direct API-port exposure, the configured trusted proxy range, and broker topic ACLs.
  - Follow-up prompt: Review deferred unit deployment-verification and close its stated proof gap. Paths: docker-compose.yml, apps/api/src/app.ts, apps/api/src/features/auth/auth.routes.ts, apps/api/src/services/mqtt-runtime.ts.
- Third-party dependency advisory status and underlying MQTT/QuickJS implementation behavior were not assessed in this static source review.
  - Follow-up prompt: Review deferred unit dependency-review and close its stated proof gap. Paths: pnpm-lock.yaml, apps/api/package.json, apps/web/package.json.

## Focused Revalidation — 2026-10-23

This follow-up rechecked the four findings and deployment questions in `security-review-2026-10-21.md` against the current source. It supersedes their earlier status for those items only. This was a focused static review, not a repository-wide re-audit or deployment inspection.

| Original item | Current status | Evidence and disposition |
| --- | --- | --- |
| Docker build context | Resolved in the current tree | `.dockerignore:12-13` excludes nested `data/` directories and `secrets/`. The Dockerfile copies `apps/` into its build stage and only the API build output and Angular browser bundle into the runtime image (`Dockerfile:3-14`). |
| Concurrent login attempts | Patch applied; validation pending | `AuthService.login()` now reserves a per-address attempt and a global verification slot before awaiting the password hasher (`apps/api/src/features/auth/auth-service.ts`). A maximum of two password verifications can run at once; requests rejected by the global cap receive HTTP 429 with a one-second retry hint. No build or tests were run for this patch. |
| Invalid OIDC callback writes | Patch applied; validation pending | `consumeOidcTransaction()` now persists only when a matching OIDC transaction exists (`apps/api/src/features/auth/user-store.ts`). Unknown tokens no longer serialize or rewrite the user store; expired stored transactions are still removed durably. No build or tests were run for this patch. |
| Concurrent MQTT processing | Not supported by the current processing path | `MqttRuntime` calls its MQTT completion callback only after `handleMessage()` completes (`apps/api/src/services/mqtt-runtime.ts:212-249`). The installed and locked MQTT.js 5.16.1 packet pump waits for that callback before advancing to the next packet (`apps/api/node_modules/mqtt/build/lib/handlers/publish.js:111-123`; `apps/api/node_modules/mqtt/build/lib/client.js:330-359`). `pendingMessages` is a shutdown tracker, not evidence of parallel handlers. |

### Current deployment and host checks

- Compose publishes `3000:3000` (`docker-compose.yml:3-5`). The deployed `APP_PUBLIC_URL`, direct-port firewalling, Traefik route, and exact `TRUST_PROXY` value cannot be established from repository source. Verify HTTPS origin, restrict direct access to port 3000 if Traefik is intended as the only ingress, and trust only the actual proxy address or subnet.
- Broker topic ACLs, TLS, and QoS are deployment-owned and remain unverified. Prior operator notes identify broker ACLs as the intended panel identity control.
- Secret-file contents were not opened. Local permission metadata was checked; `esphome/secrets.yaml`, `secrets/oidc_client_secret`, and `secrets/manager_encryption_key` now have mode `0600`.
- The generated Codex Security report is pinned to the pre-fix source snapshot. These two patches are present in the working tree but remain unverified until the API build and focused concurrency/OIDC checks are run.
- No tests, load tests, Docker build, runtime probe, dependency advisory scan, or deployment inspection was run. The rest of this historical report was not re-audited.
