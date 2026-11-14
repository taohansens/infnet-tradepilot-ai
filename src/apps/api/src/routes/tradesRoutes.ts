import { Router } from 'express';
import {
  TradesService,
  TradesServiceError,
  tradesService as defaultTradesService,
} from '../services/tradesService.js';

/**
 * Rotas HTTP do Diário de Trade (`SPEC-10`, `SPEC-12`, `SPEC-13`).
 *
 * @spec SPEC-10
 * @spec SPEC-12
 * @spec SPEC-13
 * @rf RF-M1-1
 * @rf RF-M1-3
 * @rf RF-M1-4
 * @rnf RNF-1
 * @rnf RNF-11
 */
export function createTradesRouter(
  service: TradesService = defaultTradesService,
): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const from = typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const limitParam = Number(req.query.limit ?? 200);
      const items = await service.listTrades({
        from,
        to,
        limit: Number.isFinite(limitParam) ? limitParam : 200,
      });
      res.status(200).json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const created = await service.createManualTrade(req.body ?? {});
      res.status(201).json(created);
    } catch (error) {
      if (error instanceof TradesServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  router.patch('/:tradeId/context', async (req, res, next) => {
    try {
      const updated = await service.updateTradeContext(
        req.params.tradeId,
        req.body ?? {},
      );
      res.status(200).json(updated);
    } catch (error) {
      if (error instanceof TradesServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  return router;
}
