import express, { type Router } from 'express';
import type { CampaignStore } from '../campaignStore';
import { safeEqual } from '../crypto';
import type { ProviderStore } from '../providerStore';

/**
 * Public delivery-receipt endpoint: /webhooks/:providerId/:token
 * The random per-gateway token in the URL authenticates the caller.
 */
export function webhookRoutes(deps: { providers: ProviderStore; campaigns: CampaignStore; log?: (msg: string) => void }): Router {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use(express.urlencoded({ extended: false, limit: '1mb' }));

  router.all('/:providerId/:token', (req, res) => {
    const provider = deps.providers.resolve(req.params.providerId);
    if (!provider || !safeEqual(provider.webhookToken, req.params.token)) {
      res.status(404).send('Not found');
      return;
    }
    if (!provider.def.parseWebhook) {
      res.status(200).send('OK');
      return;
    }
    try {
      const updates = provider.def.parseWebhook({ method: req.method, body: req.body ?? {}, query: req.query as Record<string, unknown> }, provider.config);
      for (const update of updates) deps.campaigns.applyStatus(provider.id, update);
    } catch (err) {
      deps.log?.(`webhook for ${provider.id} failed: ${(err as Error).message}`);
    }
    // Always acknowledge so gateways don't keep retrying receipts we can't match.
    res.status(200).send('OK');
  });
  return router;
}
