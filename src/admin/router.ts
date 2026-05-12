import { Hono } from "hono";
import crypto from "node:crypto";
import { config } from "../config.js";
import {
  createApiKey,
  dailyUsage,
  deleteApiKey,
  listApiKeys,
  setApiKeyEnabled,
  summarizeUsage,
} from "../keys.js";
import {
  clearSession,
  isAuthenticated,
  issueSession,
  requireAdmin,
} from "./session.js";
import { dashboardPage, loginPage } from "./views.js";

export const adminRouter = new Hono();

adminRouter.get("/", async (c) => {
  if (!isAuthenticated(c)) return c.redirect("/admin/login");
  return c.redirect("/admin/dashboard");
});

adminRouter.get("/login", (c) => {
  if (isAuthenticated(c)) return c.redirect("/admin/dashboard");
  return c.html(loginPage());
});

adminRouter.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const password = typeof form.password === "string" ? form.password : "";
  const expected = Buffer.from(config.admin.password);
  const given = Buffer.from(password);
  const ok =
    expected.length === given.length &&
    crypto.timingSafeEqual(expected, given);
  if (!ok) {
    return c.html(loginPage({ error: "Incorrect password." }), 401);
  }
  issueSession(c);
  return c.redirect("/admin/dashboard");
});

adminRouter.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/admin/login");
});

adminRouter.use("/dashboard", requireAdmin);
adminRouter.use("/keys/*", requireAdmin);

adminRouter.get("/dashboard", async (c) => {
  const url = new URL(c.req.url);
  const newKey = url.searchParams.get("new_key") ?? undefined;
  const [summaries, daily] = await Promise.all([summarizeUsage(30), dailyUsage(14)]);
  return c.html(
    dashboardPage({
      summaries,
      daily,
      newlyCreatedKey: newKey,
    }),
  );
});

adminRouter.post("/keys/create", async (c) => {
  const form = await c.req.parseBody();
  const name = typeof form.name === "string" ? form.name.trim() : "";
  const row = await createApiKey(name);
  return c.redirect(`/admin/dashboard?new_key=${encodeURIComponent(row.key)}`);
});

adminRouter.post("/keys/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.redirect("/admin/dashboard");
  const keys = await listApiKeys();
  const target = keys.find((k) => k.id === id);
  if (target) await setApiKeyEnabled(id, !target.enabled);
  return c.redirect("/admin/dashboard");
});

adminRouter.post("/keys/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isFinite(id)) await deleteApiKey(id);
  return c.redirect("/admin/dashboard");
});
