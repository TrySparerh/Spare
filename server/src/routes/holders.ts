/**
 * /api/spare/token/holders — $SPARE holder tier distribution (empty until the
 * token launches). All reads are server-cached (15 min snapshot, refreshed in
 * the background), so this is cheap to poll.
 */
import { Router, Request, Response } from 'express';
import { getTierDistribution } from '../services/holderSnapshot.js';
import { safeErrorMessage } from '../redact.js';

const router = Router();

router.get('/distribution', async (_req: Request, res: Response) => {
  try {
    const dist = await getTierDistribution();
    // Short cache header — client polls 60s but other tabs in the same browser
    // get a cheap hit. Server-side snapshot is 15min so the underlying data
    // doesn't actually move faster than that anyway.
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({ ok: true, distribution: dist });
  } catch (err) {
    console.error('[spare-token/holders]', safeErrorMessage(err, 'snapshot failed'));
    return res.status(500).json({ ok: false, error: 'snapshot failed' });
  }
});

export default router;
