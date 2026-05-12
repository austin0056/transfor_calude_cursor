import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { config } from "./config.js";
import { initSchema } from "./db.js";
import { adminRouter } from "./admin/router.js";
import { v1Router } from "./routes/v1.js";

const app = new Hono();
app.use("*", logger());

app.get("/", (c) =>
  c.json({
    service: "anthropic-openai-bridge",
    status: "ok",
    model: config.exposedModel,
    docs: "/admin for management panel; POST /v1/chat/completions for OpenAI-compatible endpoint",
  }),
);

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/v1", v1Router);
app.route("/admin", adminRouter);

app.notFound((c) => c.json({ error: { message: "not found", type: "not_found" } }, 404));

app.onError((err, c) => {
  console.error("[error]", err);
  return c.json(
    { error: { message: err.message, type: "internal_error" } },
    500,
  );
});

async function main() {
  await initSchema();
  serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(`[bridge] listening on :${info.port}`);
    console.log(`[bridge] upstream=${config.upstream.baseUrl} model=${config.upstream.model}`);
    console.log(`[bridge] exposed model=${config.exposedModel}`);
    console.log(`[bridge] admin panel: /admin`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
