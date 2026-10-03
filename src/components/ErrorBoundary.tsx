import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { BEVEL_WINDOW, FONT_CHROME, FONT_TEXT, GRADIENT, HOLO, SHADOW, TEXTURE } from '@/components/retro/holo/tokens';
import { t } from '@/i18n';

interface State {
  hasError: boolean;
  error: Error | null;
  isChunkLoadError: boolean;
}

const RELOADED_FLAG = 'spare:chunk-reload-attempted';

/**
 * Returns true when the error looks like a stale-deploy chunk-load failure.
 * Covers:
 *   · Vite's "Failed to fetch dynamically imported module"
 *   · Webpack's "ChunkLoadError" / "Loading chunk N failed"
 *   · CSS chunk failures ("Loading CSS chunk N failed")
 *   · 404 on hashed asset (MIME mismatch: server returns index.html)
 */
function isChunkLoadError(err: Error | null): boolean {
  if (!err) return false;
  const name = err.name ?? '';
  const msg = err.message ?? '';
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk \S+ failed/i.test(msg) ||
    /Loading CSS chunk \S+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /import\(\) error/i.test(msg) ||
    // Common signal of a stale index.html serving HTML for a missing .js chunk
    /Unexpected token '<'/i.test(msg)
  );
}

/**
 * Catches any rendering error in the React tree and shows a recovery card
 * instead of letting the page go fully blank.
 *
 * Special-case: if the error looks like a stale-deploy chunk-load failure
 * (common right after a deploy, when a cached index.html points at old
 * hashed chunk names), we auto-reload once with a cache-bust query param. The reload flag is stored in
 * sessionStorage so we don't infinite-loop if it's a real bug.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false, error: null, isChunkLoadError: false };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      isChunkLoadError: isChunkLoadError(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const chunk = isChunkLoadError(error);
    console.error(`[ErrorBoundary] ${chunk ? 'chunk-load' : 'render'} crash:`, error);
    console.error('[ErrorBoundary] component stack:', info.componentStack);

    // Auto-reload once on chunk-load failure to bust the stale index.html.
    if (chunk && typeof window !== 'undefined') {
      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem(RELOADED_FLAG) === '1';
      } catch {
        // sessionStorage can throw in some sandboxed contexts; fall through to manual recovery
      }
      if (!alreadyReloaded) {
        try {
          sessionStorage.setItem(RELOADED_FLAG, '1');
        } catch {
          /* ignore */
        }
        // Bust any cached HTML/asset by appending a unique query param.
        const url = new URL(window.location.href);
        url.searchParams.set('cb', String(Date.now()));
        window.location.replace(url.toString());
      }
    }
  }

  reset = () => {
    try {
      sessionStorage.removeItem(RELOADED_FLAG);
    } catch {
      /* ignore */
    }
    this.setState({ hasError: false, error: null, isChunkLoadError: false });
  };

  hardReload = () => {
    try {
      sessionStorage.removeItem(RELOADED_FLAG);
    } catch {
      /* ignore */
    }
    const url = new URL(window.location.href);
    url.searchParams.set('cb', String(Date.now()));
    window.location.replace(url.toString());
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    // Chunk load failures auto-reload above; if we're still rendering this UI
    // after that, the auto-reload was suppressed (already tried this session)
    // — show a tailored message inviting a manual hard refresh.
    const chunk = this.state.isChunkLoadError;
    // Plain t (class component): read once per crash render, in the live language.
    const title = chunk ? t('errorScreen.updateTitle') : t('errorScreen.crashTitle');

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.sky}`,
        }}
      >
        <div role="alertdialog" aria-label={title} style={{ width: 440, maxWidth: '100%', background: GRADIENT.face, boxShadow: `${BEVEL_WINDOW}, ${SHADOW.window}` }}>
          <div
            style={{
              height: 26,
              margin: '3px 3px 0',
              padding: '0 8px',
              display: 'flex',
              alignItems: 'center',
              background: `${TEXTURE.ditherLight} 0 0 / 4px 4px, ${GRADIENT.titleBar}`,
              boxShadow: `inset 0 -1px 0 0 ${HOLO.ink}`,
              fontFamily: FONT_CHROME,
              fontSize: 20,
              color: '#fff',
              textShadow: SHADOW.titleText,
            }}
          >
            {title}
          </div>
          <div style={{ margin: '0 3px 3px', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, background: `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card}` }}>
            <p style={{ margin: 0, fontFamily: FONT_TEXT, fontSize: 12.5, lineHeight: 1.55, color: HOLO.ink }}>
              {chunk ? t('errorScreen.updateBody') : t('errorScreen.crashBody')}
            </p>

            {this.state.error?.message && !chunk && (
              <pre
                style={{
                  margin: 0,
                  maxHeight: 128,
                  overflow: 'auto',
                  padding: '8px 10px',
                  fontFamily: FONT_TEXT,
                  fontSize: 10.5,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  color: HOLO.onScreenMuted,
                  background: GRADIENT.screen,
                  boxShadow: `0 0 0 1px ${HOLO.ink}`,
                }}
              >
                {this.state.error.message}
              </pre>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={this.hardReload} style={btn(true)}>
                {chunk ? t('errorScreen.hardRefresh') : t('errorScreen.reload')}
              </button>
              {!chunk && (
                <button onClick={this.reset} style={btn(false)}>
                  {t('errorScreen.retry')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

/** Pastel bevel key; styled inline so the crash screen never depends on anything that might have failed. */
function btn(primary: boolean): CSSProperties {
  return {
    minWidth: 96,
    height: 30,
    padding: '0 14px',
    border: 0,
    cursor: 'pointer',
    fontFamily: FONT_CHROME,
    fontSize: 18,
    color: HOLO.ink,
    background: primary ? GRADIENT.chrome : GRADIENT.face,
    boxShadow: `0 0 0 1px ${HOLO.ink}, inset 1px 1px 0 0 #fff, inset -1px -1px 0 0 ${HOLO.bevelLo}`,
  };
}

export default ErrorBoundary;
