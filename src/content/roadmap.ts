/**
 * Spare roadmap — stages, not dates.
 *
 * S1 is live on Robinhood Chain mainnet; everything after it is planned. A
 * stage is marked `completed` (LIVE) only once it is on mainnet, and `q`
 * shows the stage (S1…S4), never a date.
 *
 * Read by the desktop Roadmap app. Every text field is an i18n key in the
 * apps-b namespace ("apps-b:roadmap.…"): translate it where it renders,
 * t(phase.title). English and Chinese copy live in src/i18n/locales/{lang}/apps-b.json.
 */
import { tKey } from '@/i18n';

export type RoadmapStatus = 'completed' | 'in-progress' | 'upcoming';

export interface RoadmapItem {
  /** i18n key (apps-b). */
  text: string;
  done: boolean;
}

export interface RoadmapPhase {
  id: string;
  /** Stage label shown instead of a date: S1…S4. */
  q: 'S1' | 'S2' | 'S3' | 'S4';
  /** i18n key (apps-b). */
  title: string;
  status: RoadmapStatus;
  /** i18n key (apps-b). */
  summary: string;
  items: RoadmapItem[];
}

const done = (text: string): RoadmapItem => ({ text, done: true });
const todo = (text: string): RoadmapItem => ({ text, done: false });

export const roadmapPhases: RoadmapPhase[] = [
  {
    id: 's1',
    q: 'S1',
    title: tKey('apps-b:roadmap.phases.s1.title'),
    status: 'completed',
    summary: tKey('apps-b:roadmap.phases.s1.summary'),
    items: [
      done(tKey('apps-b:roadmap.phases.s1.link')),
      done(tKey('apps-b:roadmap.phases.s1.rules')),
      done(tKey('apps-b:roadmap.phases.s1.mix')),
      done(tKey('apps-b:roadmap.phases.s1.cashPark')),
      done(tKey('apps-b:roadmap.phases.s1.keeper')),
      done(tKey('apps-b:roadmap.phases.s1.pools')),
      done(tKey('apps-b:roadmap.phases.s1.stocks')),
      done(tKey('apps-b:roadmap.phases.s1.fund')),
      done(tKey('apps-b:roadmap.phases.s1.fee')),
    ],
  },
  {
    id: 's1-hardening',
    q: 'S1',
    title: tKey('apps-b:roadmap.phases.hardening.title'),
    status: 'in-progress',
    summary: tKey('apps-b:roadmap.phases.hardening.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.hardening.multisig')),
      todo(tKey('apps-b:roadmap.phases.hardening.audit')),
      todo(tKey('apps-b:roadmap.phases.hardening.standby')),
      todo(tKey('apps-b:roadmap.phases.hardening.treasuryPark')),
      todo(tKey('apps-b:roadmap.phases.hardening.gate')),
    ],
  },
  {
    id: 's2',
    q: 'S2',
    title: tKey('apps-b:roadmap.phases.s2.title'),
    status: 'upcoming',
    summary: tKey('apps-b:roadmap.phases.s2.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.s2.balance')),
      todo(tKey('apps-b:roadmap.phases.s2.stealth')),
      todo(tKey('apps-b:roadmap.phases.s2.confidential')),
      todo(tKey('apps-b:roadmap.phases.s2.viewingKey')),
      todo(tKey('apps-b:roadmap.phases.s2.proofs')),
    ],
  },
  {
    id: 's3',
    q: 'S3',
    title: tKey('apps-b:roadmap.phases.s3.title'),
    status: 'upcoming',
    summary: tKey('apps-b:roadmap.phases.s3.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.s3.boosts')),
      todo(tKey('apps-b:roadmap.phases.s3.streaks')),
      todo(tKey('apps-b:roadmap.phases.s3.match')),
      todo(tKey('apps-b:roadmap.phases.s3.kids')),
      todo(tKey('apps-b:roadmap.phases.s3.recap')),
      todo(tKey('apps-b:roadmap.phases.s3.token')),
    ],
  },
  {
    id: 's4',
    q: 'S4',
    title: tKey('apps-b:roadmap.phases.s4.title'),
    status: 'upcoming',
    summary: tKey('apps-b:roadmap.phases.s4.summary'),
    items: [
      todo(tKey('apps-b:roadmap.phases.s4.hook')),
      todo(tKey('apps-b:roadmap.phases.s4.chains')),
    ],
  },
];

/** "How we ship" (i18n key). */
export const ROADMAP_PRINCIPLES = tKey('apps-b:roadmap.principles');

/** "What we won't ship" (i18n keys). */
export const WONT_SHIP: readonly string[] = [
  tKey('apps-b:roadmap.wont.subscription'),
  tKey('apps-b:roadmap.wont.projections'),
  tKey('apps-b:roadmap.wont.card'),
  tKey('apps-b:roadmap.wont.pausableExit'),
  tKey('apps-b:roadmap.wont.earlyAddress'),
];
