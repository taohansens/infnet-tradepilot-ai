import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthRlsMiddleware } from '../src/apps/api/src/middlewares/authRls.js';
import { getRequiredRlsContext } from '../src/apps/api/src/db/rlsContext.js';
import { applyRlsSessionConfig } from '../src/apps/api/src/db/prismaRls.js';
import {
  IngestionService,
  type IngestionRepository,
  type StoredIngestionJob,
} from '../src/apps/api/src/services/ingestionService.js';
import { createIngestionRouter } from '../src/apps/api/src/routes/ingestionRoutes.js';
import {
  PrivacyService,
  type PrivacyDataSnapshot,
  type PrivacyRepository,
} from '../src/apps/api/src/services/privacyService.js';
import { createPrivacyRouter } from '../src/apps/api/src/routes/privacyRoutes.js';
import {
  OnboardingService,
  type OnboardingRepository,
  type SyntheticDemoTradeInput,
} from '../src/apps/api/src/services/onboardingService.js';
import { createOnboardingRouter } from '../src/apps/api/src/routes/onboardingRoutes.js';

/**
 * Suíte de Isolamento Multi-Tenant e Row-Level Security (`RNF-11`, `SPEC-01`, `SPEC-03`, `SPEC-05`, `SPEC-06`).
 *
 * Valida cenários Gherkin (Dado / Quando / Então) garantindo que o Usuário A
 * nunca lê, baixa, limpa ou altera dados pertencentes ao Usuário B.
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-05
 * @spec SPEC-06
 * @rf RF-T-1
 * @rnf RNF-11
 */

const TEST_JWT_SECRET = 'segredo-rls-isolamento-multi-tenant-32-chars';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '99999999-9999-4999-8999-999999999999';

function signTokenFor(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email, plan_status: 'active' }, TEST_JWT_SECRET, {
    issuer: 'tradepilot-ai',
    audience: 'tradepilot-ai-web',
    expiresIn: 900,
  });
}

describe('[RNF-11] Isolamento Multi-Tenant (RLS) entre Usuário A e Usuário B', () => {
  it('[SPEC-01][RNF-11] Dado uma requisição sem JWT ou com token forjado, Quando acessar rota protegida, Então o acesso é negado (401 fail-closed)', async () => {
    const app = express();
    const authRls = createAuthRlsMiddleware({ jwtSecret: TEST_JWT_SECRET });
    app.get('/api/v1/protected', authRls, (_req, res) => {
      res.status(200).json({ userId: getRequiredRlsContext().userId });
    });

    const withoutToken = await request(app).get('/api/v1/protected');
    expect(withoutToken.status).toBe(401);

    const forgedToken = jwt.sign({ sub: USER_A }, 'segredo-errado-invasor', {
      issuer: 'tradepilot-ai',
      audience: 'tradepilot-ai-web',
    });
    const withForged = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${forgedToken}`);
    expect(withForged.status).toBe(401);
  });

  it('[SPEC-06][RNF-11] Dado um job de ingestão do Usuário B, Quando Usuário A tentar consultar ou efetivar o job do Usuário B, Então recebe 404 sem vazar ou alterar dados', async () => {
    const jobsById = new Map<string, StoredIngestionJob>();

    // Repositório que aplica a mesma regra da política RLS: user_id = app.current_user_id
    const rlsIngestionRepo: IngestionRepository = {
      async createQueuedJob(params) {
        const ctx = getRequiredRlsContext();
        const id = randomUUID();
        jobsById.set(id, {
          id,
          userId: ctx.userId,
          sourceHint: params.sourceHint,
          fileName: params.fileName,
          fileSha256: params.fileSha256,
          status: 'AWAITING_REVIEW',
          totalRows: 1,
          processedRows: 1,
          conflictCount: 0,
          errorMessagePtbr: null,
          createdAt: new Date(),
          completedAt: null,
          stagingItems: [],
        });
        return { id, fileName: params.fileName };
      },
      async markJobProcessing() {},
      async findExistingTradesByHashes() {
        return [];
      },
      async saveStagingAndMarkReview() {},
      async markJobFailed() {},
      async getJobWithItems(jobId) {
        const ctx = getRequiredRlsContext();
        const job = jobsById.get(jobId);
        // Política RLS: USING (user_id = app_current_user_id())
        if (!job || job.userId !== ctx.userId) return null;
        return job;
      },
      async commitJobAtomic({ job }) {
        const ctx = getRequiredRlsContext();
        if (job.userId !== ctx.userId) {
          throw new Error('RLS violation');
        }
        job.status = 'COMMITTED';
        return {
          job_id: job.id,
          inserted: 1,
          merged: 0,
          overwritten: 0,
          ignored: 0,
        };
      },
    };

    const ingestionService = new IngestionService({
      repository: rlsIngestionRepo,
      scheduleWorker: () => {},
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/ingestion',
      createAuthRlsMiddleware({ jwtSecret: TEST_JWT_SECRET }),
      createIngestionRouter(ingestionService),
    );

    const tokenA = signTokenFor(USER_A, 'user-a@exemplo.com');
    const tokenB = signTokenFor(USER_B, 'user-b@exemplo.com');

    // Dado que Usuário B cria um job de importação
    const csvB = 'Data;Lado;Ativo;Quantidade;Preço\n09/10/2026;C;WINZ26;2;131200';
    const createdByB = await request(app)
      .post('/api/v1/ingestion/jobs')
      .set('Authorization', `Bearer ${tokenB}`)
      .field('source_hint', 'B3_CSV')
      .attach('file', Buffer.from(csvB, 'utf8'), 'extrato_b.csv');

    expect(createdByB.status).toBe(202);
    const jobIdOfB = createdByB.body.job_id as string;

    // Quando Usuário A tenta LER o job do Usuário B -> 404 (RLS bloqueia)
    const readAttemptByA = await request(app)
      .get(`/api/v1/ingestion/jobs/${jobIdOfB}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(readAttemptByA.status).toBe(404);

    // Quando Usuário A tenta ALTERAR/EFETIVAR o job do Usuário B -> 404 (RLS bloqueia)
    const commitAttemptByA = await request(app)
      .post(`/api/v1/ingestion/jobs/${jobIdOfB}/commit`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ resolutions: [] });
    expect(commitAttemptByA.status).toBe(404);

    // Então o job do Usuário B continua intacto e acessível apenas para o Usuário B
    const readByB = await request(app)
      .get(`/api/v1/ingestion/jobs/${jobIdOfB}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(readByB.status).toBe(200);
    expect(readByB.body.status).toBe('AWAITING_REVIEW');
  });

  it('[SPEC-03][RNF-11] Dado uma exportação ZIP LGPD do Usuário B, Quando Usuário A tentar baixar pelo job_id do Usuário B, Então o download é bloqueado (404)', async () => {
    const hashB = await bcrypt.hash('senha-usuario-b-10', 4);
    const snapshots = new Map<string, PrivacyDataSnapshot>([
      [
        USER_B,
        {
          user: {
            id: USER_B,
            name: 'Usuário B',
            email: 'b@exemplo.com',
            passwordHash: hashB,
            totpEnabled: false,
            lgpdConsentAt: new Date('2026-10-01T10:00:00Z'),
            onboardingCompleted: true,
            planCode: 'pro_monthly',
            planStatus: 'active',
            createdAt: new Date('2026-10-01T10:00:00Z'),
          },
          trades: [],
          ingestionJobs: [],
          stagingItems: [],
          auditLogs: [],
        },
      ],
    ]);

    const rlsPrivacyRepo: PrivacyRepository = {
      async collectUserData(userId) {
        const ctx = getRequiredRlsContext();
        if (ctx.userId !== userId) return null;
        return snapshots.get(ctx.userId) ?? null;
      },
      async recordExportAudit() {},
      async deleteUserAccountAtomic() {
        return { auditId: randomUUID() };
      },
    };

    const privacyService = new PrivacyService(rlsPrivacyRepo);
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/privacy',
      createAuthRlsMiddleware({ jwtSecret: TEST_JWT_SECRET }),
      createPrivacyRouter(privacyService),
    );

    const tokenA = signTokenFor(USER_A, 'a@exemplo.com');
    const tokenB = signTokenFor(USER_B, 'b@exemplo.com');

    // Usuário B solicita exportação LGPD
    const exportByB = await request(app)
      .post('/api/v1/privacy/export')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(exportByB.status).toBe(202);

    // Usuário A tenta baixar o ZIP do Usuário B
    const stealAttemptByA = await request(app)
      .get(exportByB.body.download_url as string)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(stealAttemptByA.status).toBe(404);

    // Usuário B consegue baixar seu próprio ZIP
    const downloadByB = await request(app)
      .get(exportByB.body.download_url as string)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(downloadByB.status).toBe(200);
    expect(downloadByB.headers['content-type']).toContain('application/zip');
  });

  it('[SPEC-05][RNF-11] Dado trades demonstrativos do Usuário B, Quando Usuário A limpar sua própria base demo, Então os 45 trades do Usuário B permanecem intocados', async () => {
    const tradesByTenant = new Map<string, SyntheticDemoTradeInput[]>();

    const rlsOnboardingRepo: OnboardingRepository = {
      async seedDemoTradesAtomic(_userId, trades) {
        const ctx = getRequiredRlsContext();
        tradesByTenant.set(ctx.userId, trades);
        return trades.length;
      },
      async clearDemoTradesAtomic() {
        const ctx = getRequiredRlsContext();
        const removed = tradesByTenant.get(ctx.userId)?.length ?? 0;
        tradesByTenant.set(ctx.userId, []);
        return removed;
      },
      async markOnboardingCompleted() {},
      async getStatus() {
        const ctx = getRequiredRlsContext();
        const count = tradesByTenant.get(ctx.userId)?.length ?? 0;
        return {
          onboarding_completed: count > 0,
          has_demo_trades: count > 0,
          demo_trades_count: count,
          real_trades_count: 0,
        };
      },
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/onboarding',
      createAuthRlsMiddleware({ jwtSecret: TEST_JWT_SECRET }),
      createOnboardingRouter(new OnboardingService(rlsOnboardingRepo)),
    );

    const tokenA = signTokenFor(USER_A, 'a@exemplo.com');
    const tokenB = signTokenFor(USER_B, 'b@exemplo.com');

    await request(app)
      .post('/api/v1/onboarding/demo-seed')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(201);

    // Usuário A executa DELETE /demo-seed
    const clearByA = await request(app)
      .delete('/api/v1/onboarding/demo-seed')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(clearByA.body.removed_demo_trades).toBe(0);

    // Trades do Usuário B continuam intactos (45)
    const statusB = await request(app)
      .get('/api/v1/onboarding/status')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(statusB.body.demo_trades_count).toBe(45);
  });

  it('[RNF-11] Deve injetar app.current_user_id via set_config(..., true) na transação PostgreSQL e impor FORCE ROW LEVEL SECURITY no DDL', async () => {
    const executeRawMock = vi.fn(async () => 1);
    await applyRlsSessionConfig(
      { $executeRaw: executeRawMock } as never,
      USER_A,
    );
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const callArgs = executeRawMock.mock.calls[0] as unknown[];
    expect(String(callArgs[0])).toContain("set_config('app.current_user_id'");
    expect(callArgs[1]).toBe(USER_A);

    const sqlPath = resolve(
      process.cwd(),
      'apps/api/src/db/migrations/001_init_rls_audit.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    expect(sql).toContain('NOBYPASSRLS');
    expect(sql).toContain('USING (user_id = app_current_user_id())');
    expect(sql).toContain('WITH CHECK (user_id = app_current_user_id())');
  });
});
