import { Router } from 'express';
import {
  AuthService,
  AuthServiceError,
  authService as defaultAuthService,
} from '../services/authService.js';

/**
 * Rotas HTTP de Autenticação (Cadastro, Login, Refresh Token e Recuperação de Senha).
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-10
 * @rnf RNF-11
 * @rnf RNF-12
 */
export function createAuthRouter(service: AuthService = defaultAuthService): Router {
  const router = Router();

  /**
   * POST /api/v1/auth/register
   * @spec SPEC-01
   * @rf RF-T-1
   */
  router.post('/register', async (req, res, next) => {
    try {
      const result = await service.register(req.body ?? {});
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof AuthServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  /**
   * POST /api/v1/auth/login
   * @spec SPEC-01
   * @rf RF-T-1
   */
  router.post('/login', async (req, res, next) => {
    try {
      const result = await service.login(req.body ?? {});
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof AuthServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  /**
   * POST /api/v1/auth/refresh
   * @spec SPEC-01
   * @rf RF-T-1
   */
  router.post('/refresh', async (req, res, next) => {
    try {
      const token =
        typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
      const result = await service.refresh(token);
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof AuthServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  /**
   * POST /api/v1/auth/recover-password
   * Resposta genérica para impedir enumeração de contas.
   * @spec SPEC-01
   * @rf RF-T-1
   */
  router.post('/recover-password', (_req, res) => {
    res.status(200).json({
      message:
        'Se o e-mail informado estiver cadastrado, enviaremos as instruções de recuperação.',
    });
  });

  return router;
}
