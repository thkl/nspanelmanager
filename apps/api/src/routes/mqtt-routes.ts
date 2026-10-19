import { Router } from "express";
import { randomUUID } from "node:crypto";
import { normalizeRoute, validateRoute } from "../domain/mqtt-route.js";
import type { ConfigStore } from "../services/config-store.js";
import type { MqttRuntime } from "../services/mqtt-runtime.js";
import type { MqttRoute } from "../types.js";

/**
 * Creates the HTTP endpoints for MQTT state and command mappings.
 *
 * Routes are persisted before the runtime refreshes its source subscriptions.
 * Validation and placeholder rules are kept in the domain module so this
 * feature router remains responsible for HTTP status codes and storage calls.
 */
export function createMqttRouteRouter(store: ConfigStore, mqttRuntime: MqttRuntime): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    const route = normalizeRoute(request.body);
    const error = validateRoute(route, store.get());
    if (error) return response.status(400).json({ error });
    route.id = randomUUID();
    await store.update((config) => { config.routes.push(route); });
    mqttRuntime.syncSubscriptions();
    response.status(201).json({ route });
  });

  router.put("/:id", async (request, response) => {
    const id = request.params.id;
    if (!store.get().routes.some((route) => route.id === id)) return response.status(404).json({ error: "Route not found." });
    const route: MqttRoute = normalizeRoute(request.body, id);
    const error = validateRoute(route, store.get());
    if (error) return response.status(400).json({ error });
    await store.update((config) => { config.routes = config.routes.map((item) => item.id === id ? route : item); });
    mqttRuntime.syncSubscriptions();
    response.json({ route });
  });

  router.delete("/:id", async (request, response) => {
    const id = request.params.id;
    if (!store.get().routes.some((route) => route.id === id)) return response.status(404).json({ error: "Route not found." });
    await store.update((config) => { config.routes = config.routes.filter((route) => route.id !== id); });
    mqttRuntime.syncSubscriptions();
    response.status(204).end();
  });

  return router;
}
