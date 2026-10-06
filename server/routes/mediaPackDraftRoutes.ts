import type { Express, RequestHandler } from 'express';
import {
  PackDraftError,
  getPackDraft,
  listPackDrafts,
  upsertPackDraft,
  isValidClientItemId,
  MAX_PACK_BYTES,
} from '../services/mediaPackDraftService';

export function registerMediaPackDraftRoutes(app: Express, auth: RequestHandler): void {
  const fail = (res: any, err: any) => {
    if (err instanceof PackDraftError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    }
    return res.status(500).json({ error: err?.message || 'Media pack draft error' });
  };

  app.get('/api/media-pack-drafts', auth, (_req, res) => {
    try {
      res.json({ drafts: listPackDrafts(), limitBytes: MAX_PACK_BYTES });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/media-pack-drafts/:clientItemId', auth, (req, res) => {
    try {
      if (!isValidClientItemId(req.params.clientItemId)) {
        return res.status(400).json({ error: 'Invalid clientItemId', code: 'INVALID_CLIENT_ITEM_ID' });
      }
      const draft = getPackDraft(req.params.clientItemId);
      if (!draft) return res.status(404).json({ error: 'No media pack draft stored for this item', code: 'NOT_FOUND' });
      res.json({ draft });
    } catch (err) { fail(res, err); }
  });

  app.put('/api/media-pack-drafts/:clientItemId', auth, (req, res) => {
    try {
      const { pack, sku, itemId } = req.body || {};
      const out = upsertPackDraft(req.params.clientItemId, pack, { sku, itemId });
      res.status(out.created ? 201 : 200).json({
        draft: out.record,
        created: out.created,
        changed: out.changed,
        convertedDataUrls: out.convertedDataUrls,
        droppedRefs: out.droppedRefs,
      });
    } catch (err) { fail(res, err); }
  });
}
