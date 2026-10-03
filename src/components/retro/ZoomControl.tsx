/**
 * ZoomControl — Win98 taskbar-tray widget for global UI zoom.
 * [ − ] 100% [ + ] — click to scale the whole desktop, or use Ctrl +/-/0.
 */
import { useEffect, useState } from 'react';
import { getZoom, nudgeZoom, resetZoom, ZOOM_STEP } from '@/lib/uiZoom';
import { BEVEL_SUNKEN, FONT_CHROME, FONT_TEXT, HOLO } from './holo/tokens';
import { useTranslation } from '@/i18n';

export function ZoomControl() {
  const { t } = useTranslation('shell');
  const [zoom, setZoom] = useState(getZoom());

  useEffect(() => {
    const onZoom = (e: Event) => setZoom((e as CustomEvent<number>).detail);
    window.addEventListener('ui-zoom', onZoom);
    return () => window.removeEventListener('ui-zoom', onZoom);
  }, []);

  const btn: React.CSSProperties = {
    fontFamily: FONT_CHROME,
    fontWeight: 400,
    fontSize: 18,
    lineHeight: '14px',
    color: HOLO.ink,
  };

  return (
    <div
      data-zoom-control
      title={t('zoom.title')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '0 4px',
        boxShadow: BEVEL_SUNKEN,
        background: 'rgba(255,255,255,.55)',
        height: 26,
      }}
    >
      <button className="holo-winbtn" style={btn} onClick={() => nudgeZoom(-ZOOM_STEP)} aria-label={t('zoom.out')}>−</button>
      <button
        onClick={() => resetZoom()}
        aria-label={t('zoom.reset')}
        style={{
          minWidth: 40,
          height: 18,
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          fontFamily: FONT_TEXT,
          fontWeight: 700,
          fontSize: 11,
          color: HOLO.ink,
          textAlign: 'center',
        }}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button className="holo-winbtn" style={btn} onClick={() => nudgeZoom(ZOOM_STEP)} aria-label={t('zoom.in')}>+</button>
    </div>
  );
}

export default ZoomControl;
