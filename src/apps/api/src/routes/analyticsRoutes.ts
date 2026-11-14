import { Router } from 'express';
import {
  AnalyticsService,
  analyticsService as defaultAnalyticsService,
} from '../services/analyticsService.js';

/**
 * Rotas HTTP do Motor de Trading Analytics Determinístico (`SPEC-14` a `SPEC-17`, `SPEC-20`).
 *
 * @spec SPEC-14
 * @spec SPEC-15
 * @spec SPEC-16
 * @spec SPEC-17
 * @spec SPEC-20
 * @rf RF-M2-1
 * @rf RF-M2-2
 * @rf RF-M2-3
 * @rf RF-M2-4
 * @rnf RNF-11
 * @rnf RNF-29
 */
export function createAnalyticsRouter(
  service: AnalyticsService = defaultAnalyticsService,
): Router {
  const router = Router();

  router.get('/summary', async (req, res, next) => {
    try {
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const summary = await service.getSummary(from, to);
      res.status(200).json(summary);
    } catch (error) {
      next(error);
    }
  });

  router.get('/equity-curve', async (req, res, next) => {
    try {
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const curve = await service.getEquityCurve(from, to);
      res.status(200).json(curve);
    } catch (error) {
      next(error);
    }
  });

  router.get('/breakdown', async (req, res, next) => {
    try {
      const rawDim =
        typeof req.query.dimension === 'string' ? req.query.dimension : 'setup_id';
      const dimension =
        rawDim === 'hour_bucket' ||
        rawDim === 'day_of_week' ||
        rawDim === 'ticker' ||
        rawDim === 'setup_id'
          ? rawDim
          : 'setup_id';
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const result = await service.getBreakdown(dimension, from, to);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
