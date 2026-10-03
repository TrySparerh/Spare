/**
 * /api/spare/token — $SPARE token status.
 *
 *   GET /           token status: launched=false, no CA, official channels
 *   GET /stats      buyback ledger totals — all zero while the token is not launched
 *   GET /ledger     buyback events — empty while not launched
 *   GET /pending    queued ledger entries — empty while not launched
 *
 * $SPARE is coming soon. Nothing here reports a price, supply, holder count or
 * buyback that does not exist.
 */
import { Router, type Request, type Response } from 'express';
import { getSpareTokenStatus, getTokenLedgerEvents, getTokenLedgerStats } from '../services/spareToken.js';

const router = Router();

const clampLimit = (v: unknown) => Math.min(200, Math.max(1, parseInt(String(v ?? '50'), 10) || 50));

router.get('/', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(getSpareTokenStatus());
});

router.get('/stats', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(getTokenLedgerStats());
});

router.get('/ledger', (req: Request, res: Response) => {
  const events = getTokenLedgerEvents(clampLimit(req.query.limit));
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ count: events.length, events, token: getSpareTokenStatus() });
});

router.get('/pending', (req: Request, res: Response) => {
  const pending = getTokenLedgerEvents(clampLimit(req.query.limit));
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ count: pending.length, pending, token: getSpareTokenStatus() });
});

export default router;
