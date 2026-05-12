import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config.js";

const COOKIE_NAME = "admin_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", config.admin.sessionSecret)
    .update(payload)
    .digest("base64url");
}

function makeToken(): string {
  const expires = Date.now() + TTL_MS;
  const payload = `${expires}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const idx = token.indexOf(".");
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(payload);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return false;
  }
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return true;
}

export function issueSession(c: Context): void {
  setCookie(c, COOKIE_NAME, makeToken(), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(TTL_MS / 1000),
    secure: true,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export function isAuthenticated(c: Context): boolean {
  return verifyToken(getCookie(c, COOKIE_NAME));
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!isAuthenticated(c)) {
    return c.redirect("/admin/login");
  }
  await next();
};
