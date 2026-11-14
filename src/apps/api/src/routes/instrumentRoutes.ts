import { Router } from 'express';
import {
  InstrumentService,
  InstrumentServiceError,
  instrumentService as defaultInstrumentService,
} from '../services/instrumentService.js';

/**
 * Rotas HTTP de Configuração de Contratos/Instrumentos B3 (`GET/PUT /api/v1/instruments`).
 *
 * @spec SPEC-06
 * @spec SPEC-10
 * @rnf RNF-11
 * @rnf RNF-20
 */
export function createInstrumentRouter(
  service: InstrumentService = defaultInstrumentService,
): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const items = await service.listUserConfigs();
      res.status(200).json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.put('/', async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const saved = await service.saveUserConfigs(items);
      res.status(200).json({ items: saved });
    } catch (error) {
      if (error instanceof InstrumentServiceError) {
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
