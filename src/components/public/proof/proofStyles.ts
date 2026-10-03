/**
 * /proof's own CSS (pf-*). Lives next to the page so nothing shared changes:
 * every rule is scoped to a pf- class, and the narrow layouts come from
 * container queries on the page's own wrappers (they follow the column the
 * page actually gets, sidebar or not) plus one ≤767px media block.
 */
import { GRADIENT, HOLO, TEXTURE, pixelPath, sparkleUrl } from '@/components/retro/holo';

/** A 7x7 pixel arrow pointing right, as a CSS background. */
const ARROW = (() => {
  const d = pixelPath(['0001000', '0001100', '1111110', '1111111', '1111110', '0001100', '0001000']);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 7 7' shape-rendering='crispEdges'><path d='${d}' fill='${HOLO.ink}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

export const PROOF_CSS = `
.pf-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pf-muted { color: ${HOLO.inkMuted}; }
.pf-small { font-family: var(--holo-font-text); font-size: 11.5px; line-height: 1.6; color: ${HOLO.inkMuted}; margin: 0; max-width: 82ch; }
.pf-row { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; min-width: 0; }
.pf-stack { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pf-mono { font-family: var(--holo-font-text); font-size: 12px; color: ${HOLO.ink}; overflow-wrap: anywhere; }
.pf-ext { font-family: var(--holo-font-text); font-size: 12px; font-weight: 700; color: ${HOLO.link}; text-decoration: underline dotted; text-underline-offset: 3px; overflow-wrap: anywhere; }
.pf-ext:hover { text-decoration-style: solid; }
.pf-badgelink { display: inline-flex; text-decoration: none !important; }
.pf-badgelink:focus-visible { outline: 1px dotted ${HOLO.ink}; outline-offset: 2px; }
.pf-tag { vertical-align: middle; }
.pf-kv { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 4px 12px; align-items: baseline; margin: 0; min-width: 0; }
.pf-kv dt { font-family: var(--holo-font-chrome); font-weight: 400; font-size: 17px; line-height: 1.15; color: ${HOLO.inkSoft}; }
.pf-kv dd { margin: 0; min-width: 0; font-family: var(--holo-font-text); font-size: 12.5px; line-height: 1.55; color: ${HOLO.ink}; overflow-wrap: anywhere; }

/* hero badges */
.pf-herobadges { display: flex; flex-wrap: wrap; gap: 6px; }

/* architecture parts */
.pf-parts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.pf-part {
  min-width: 0; padding: 8px 10px 9px;
  background: rgba(255,255,255,.66); box-shadow: inset 0 0 0 1px ${HOLO.bevelLo};
  display: flex; flex-direction: column; gap: 3px;
}
.pf-part__name { font-family: var(--holo-font-text); font-weight: 700; font-size: 12.5px; color: ${HOLO.ink}; overflow-wrap: anywhere; }
.pf-part__body { font-family: var(--holo-font-text); font-size: 12px; line-height: 1.55; color: ${HOLO.ink}; }

/* money path diagram */
.pf-pathwrap { container-type: inline-size; min-width: 0; }
.pf-path { margin: 0; display: flex; flex-direction: column; gap: 14px; }
.pf-path__steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 24px; }
.pf-path__step {
  position: relative; min-width: 0;
  display: flex; flex-direction: column; gap: 5px;
  padding: 9px 9px 10px;
  border: 2px solid ${HOLO.ink};
  background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card};
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.2);
}
.pf-path__step:not(:last-child)::after {
  content: ''; position: absolute; top: 50%; right: -21px; width: 16px; height: 16px; margin-top: -8px;
  background: ${ARROW} center / contain no-repeat;
}
.pf-path__head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.pf-path__n {
  flex-shrink: 0; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  background: ${TEXTURE.ditherLight} 0 0 / 4px 4px, linear-gradient(180deg, #4B36B8 0%, #2A1B6E 100%);
  box-shadow: inset 1px 1px 0 #7B63E0, 0 0 0 1px ${HOLO.ink};
  color: ${HOLO.onScreen}; font-family: var(--holo-font-display); font-size: 9px; line-height: 1;
}
.pf-path__title { font-family: var(--holo-font-chrome); font-weight: 400; font-size: 19px; line-height: 1.05; color: ${HOLO.ink}; min-width: 0; }
.pf-path__code {
  align-self: flex-start; max-width: 100%;
  font-family: var(--holo-font-text); font-size: 10.5px; line-height: 1.4; padding: 1px 5px;
  background: rgba(201,182,255,.3); box-shadow: inset 0 0 0 1px ${HOLO.bevelLo}; color: ${HOLO.ink};
  overflow-wrap: anywhere;
}
.pf-path__body { margin: 0; font-family: var(--holo-font-text); font-size: 11.5px; line-height: 1.55; color: ${HOLO.ink}; }
.pf-path__branches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pf-path__branch {
  min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 2px dashed ${HOLO.ink}; background: rgba(255,255,255,.6);
}
.pf-path__branch--exit { background: linear-gradient(160deg, #F2FFF9 0%, #E3FBF1 100%); }
.pf-path__branch--defer { background: linear-gradient(160deg, #FFF8EC 0%, #FFF1DC 100%); }
.pf-path__from { font-family: var(--holo-font-pixel); font-weight: 700; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: ${HOLO.inkSoft}; }
@container (max-width: 760px) {
  .pf-path__steps { grid-template-columns: minmax(0, 1fr); gap: 22px; }
  .pf-path__step:not(:last-child)::after { top: auto; right: auto; left: 50%; bottom: -20px; margin: 0 0 0 -8px; transform: rotate(90deg); }
  .pf-path__branches { grid-template-columns: minmax(0, 1fr); }
}

/* rails */
.pf-rails { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 10px; }
.pf-rail {
  min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 11px;
  border: 2px solid ${HOLO.ink};
  background: ${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card};
  box-shadow: inset 0 0 0 1px #FFFFFF, 3px 3px 0 0 rgba(42,27,110,.18);
}
.pf-rail__top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.pf-rail__name { font-family: var(--holo-font-chrome); font-weight: 400; font-size: 20px; line-height: 1.05; color: ${HOLO.ink}; }
.pf-rail__value { font-family: var(--holo-font-text); font-weight: 700; font-size: 15px; line-height: 1.3; color: ${HOLO.ink}; overflow-wrap: anywhere; }
.pf-rail__bound { font-family: var(--holo-font-pixel); font-weight: 700; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: ${HOLO.inkSoft}; }
.pf-rail__body { margin: 0; font-family: var(--holo-font-text); font-size: 12px; line-height: 1.6; color: ${HOLO.ink}; }
.pf-rail__src { font-family: var(--holo-font-text); font-size: 11px; color: ${HOLO.inkMuted}; overflow-wrap: anywhere; }

/* status chips */
.pf-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.pf-chip {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px;
  font-family: var(--holo-font-text); font-weight: 700; font-size: 11px; color: ${HOLO.ink};
  background: #FFFFFF; box-shadow: inset 0 0 0 1px ${HOLO.bevelLo};
}
.pf-chip__dot { width: 7px; height: 7px; flex-shrink: 0; box-shadow: 0 0 0 1px ${HOLO.ink}; }
.pf-chip--ok .pf-chip__dot { background: ${HOLO.goodFill}; }
.pf-chip--warn .pf-chip__dot { background: ${HOLO.warnFill}; }
.pf-chip--bad .pf-chip__dot { background: ${HOLO.badFill}; }
.pf-chip--muted { color: ${HOLO.inkMuted}; background: rgba(255,255,255,.55); }
.pf-chip--muted .pf-chip__dot { background: ${HOLO.lilac}; }

/* audit numbers */
.pf-checklist { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.pf-checklist li { position: relative; padding-left: 20px; font-family: var(--holo-font-text); font-size: 12.5px; line-height: 1.6; color: ${HOLO.ink}; }
.pf-checklist li::before { content: ''; position: absolute; left: 1px; top: .42em; width: 11px; height: 11px; background: ${sparkleUrl(HOLO.ink, HOLO.pink)} center / contain no-repeat; }

@media (max-width: 767px) {
  .pf-kv { grid-template-columns: minmax(0, 1fr); gap: 0 0; }
  .pf-kv dd { margin-bottom: 6px; }
  .pf-rail__name { font-size: 19px; }
}
`;
