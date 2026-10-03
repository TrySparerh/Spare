/**
 * The keeper's /health. It is public by necessity (the hosting platform's deploy
 * healthcheck calls it without credentials), so it answers liveness only:
 * `{ ok }` plus the loop's liveness (started, uptime, newest tick time — what
 * an external monitor needs to see a stuck loop), HTTP 200, or 503 with
 * ?strict=1 when not ok. The detail — keeper
 * address, gas, backoffs, recent ticks — is served only to a caller holding
 * HEALTH_TOKEN as a bearer token, and to nobody when HEALTH_TOKEN is unset.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const NO_STORE = { "cache-control": "no-store" };

/** Whether an Authorization header carries `token` as its bearer token (constant time). */
export function bearerMatches(header: string | null | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  // Hash both sides: equal lengths for timingSafeEqual, and no early exit on length.
  const got = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const want = createHash("sha256").update(token).digest();
  return timingSafeEqual(got, want);
}

export function healthResponse(
  req: Request,
  p: { ok: boolean; token?: string; liveness?: () => Record<string, unknown>; detail: () => Record<string, unknown> },
): Response {
  const strict = new URL(req.url).searchParams.get("strict") === "1";
  const status = strict && !p.ok ? 503 : 200;
  if (p.token && bearerMatches(req.headers.get("authorization"), p.token)) {
    return Response.json({ ...p.detail(), ok: p.ok }, { status, headers: NO_STORE });
  }
  return Response.json({ ...p.liveness?.(), ok: p.ok }, { status, headers: NO_STORE });
}
