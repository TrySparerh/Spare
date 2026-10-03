import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

/** The same phone breakpoint as the CSS `@media (max-width: 767px)` blocks. */
export const PHONE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/** Synchronous read of the phone breakpoint (false where matchMedia is unavailable). */
export function isPhoneViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * useIsMobile(), but correct on the very first render.
 *
 * useIsMobile() starts at `false` and only learns the real answer in an
 * effect, so a phone would paint (and start fetching) the desktop branch for
 * one frame first. This reads matchMedia synchronously and stays live across
 * rotation / resize. On desktop and tablet it is `false` from the start, the
 * same answer useIsMobile() gives there.
 */
export function useIsMobileNow(): boolean {
  return React.useSyncExternalStore(subscribePhone, isPhoneViewport, () => false);
}
