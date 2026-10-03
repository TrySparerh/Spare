/**
 * Error text that is safe to send to a client or write to a log line.
 *
 * A viem error's message carries the RPC URL (which can embed a provider key,
 * e.g. `URL: https://…alchemy.com/v2/<key>`), the request body and the
 * upstream reply on the lines after the first; Node errors carry a stack. What
 * leaves this module is one line: viem's `shortMessage` (its fixed summary,
 * never the upstream reply) or else the message's first line, with anything
 * URL-shaped replaced and the length capped. Never `details`, never a stack.
 */

/** scheme://… up to the next whitespace or quote: host, path, query and userinfo included. */
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*/gi;
/** host.tld/… with no scheme: the path is where provider keys live. */
const HOST_PATH = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?\/[^\s"'`<>]*/gi;

export const REDACTED_URL = '[url]';
export const MAX_ERROR_CHARS = 200;

/** `text` with every URL-shaped run replaced by REDACTED_URL. */
export function redactUrls(text: string): string {
  return text.replace(SCHEME_URL, REDACTED_URL).replace(HOST_PATH, REDACTED_URL);
}

/** One redacted line describing `err`, or `fallback` when there is nothing to say. */
export function safeErrorMessage(err: unknown, fallback = 'request failed'): string {
  const e = (err && typeof err === 'object' ? err : {}) as { shortMessage?: unknown; message?: unknown };
  const raw =
    typeof e.shortMessage === 'string' && e.shortMessage.trim()
      ? e.shortMessage
      : typeof e.message === 'string'
        ? e.message
        : typeof err === 'string'
          ? err
          : '';
  const line = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  const clean = line ? redactUrls(line).replace(/\s+/g, ' ').trim() : '';
  if (!clean) return fallback;
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS - 1)}…` : clean;
}
