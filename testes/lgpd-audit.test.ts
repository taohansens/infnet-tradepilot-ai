import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { Decimal } from 'decimal.js';
import express from 'express';
import JSZip from 'jszip';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_DELETE_CONFIRMATION_PHRASE } from '@tradepilot/shared';
import { createAuthRlsMiddleware } from '../src/apps/api/src/middlewares/authRls.js';
import {
  AuthService,
  type AuthRepository,
  type AuthUserLookup,
} from '../src/apps/api/src/services/authService.js';
import { createAuthRouter } from '../src/apps/api/src/routes/authRoutes.js';
import {
  AuditService,
  type AuditLogRecord,
  type AuditLogRepository,
} from '../src/apps/api/src/services/auditService.js';
import {
  PrivacyService,
  type PrivacyDataSnapshot,
  type PrivacyRepository,
} from '../src/apps/api/src/services/privacyService.js';
import { createPrivacyRouter } from '../src/apps/api/src/routes/privacyRoutes.js';

/**
 * Suíte Gherkin de Autenticação (SPEC-01), Soberania LGPD (SPEC-03) e
 * Trilha de Auditoria Imutável Append-Only (SPEC-04).
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-1
 * @rf RF-T-4
 * @rnf RNF-11
 * @rnf RNF-12
 * @rnf RNF-13
 * @rnf RNF-15
 * @rnf RNF-30
 */

const TEST_JWT_SECRET = 'segredo-testes-lgpd-auditoria-append-only-32';

function createLgpdTestStack() {
  const usersByEmail = new Map<string, AuthUserLookup & { name: string; lgpdConsentAt: Date }>();
  const usersById = new Map<string, AuthUserLookup & { name: string; lgpdConsentAt: Date }>();
  const auditLogs: AuditLogRecord[] = [];
  const auditService = new AuditService();

  const auditRepo: AuditLogRepository = {
    auditLog: {
      async create({ data }) {
        const record: AuditLogRecord = {
          id: randomUUID(),
          userId: data.userId,
          actorId: data.actorId,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          beforeSnapshot: data.beforeSnapshot as AuditLogRecord['beforeSnapshot'],
          afterSnapshot: data.afterSnapshot as AuditLogRecord['afterSnapshot'],
          requestId: data.requestId,
          ipHash: data.ipHash,
          createdAtUtc: new Date(),
        };
        auditLogs.push(record);
        return record;
      },
      async findMany() {
        return [...auditLogs];
      },
    },
  };

  const authRepo: AuthRepository = {
    async findUserByEmail(email) {
      return usersByEmail.get(email.toLowerCase()) ?? null;
    },
    async createUserWithRls(input) {
      const record = {
        id: input.id,
        name: input.name,
        email: input.email,
        passwordHash: input.passwordHash,
        totpEnabled: false,
        planStatus: 'trial' as const,
        onboardingCompleted: false,
        lgpdConsentAt: input.lgpdConsentAt,
      };
      usersByEmail.set(record.email.toLowerCase(), record);
      usersById.set(record.id, record);
      return record;
    },
  };

  const privacyRepo: PrivacyRepository = {
    async collectUserData(userId): Promise<PrivacyDataSnapshot | null> {
      const u = usersById.get(userId);
      if (!u) return null;
      return {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          passwordHash: u.passwordHash,
          totpEnabled: u.totpEnabled,
          lgpdConsentAt: u.lgpdConsentAt,
          onboardingCompleted: u.onboardingCompleted,
          planCode: 'trial',
          planStatus: u.planStatus,
          createdAt: u.lgpdConsentAt,
        },
        trades: [
          {
            id: randomUUID(),
            ticker: 'PETR4',
            marketType: 'ACOES',
            side: 'LONG',
            taxSilo: 'SWING_TRADE',
            source: 'MANUAL',
            isDemo: false,
            entryAt: new Date('2026-10-01T13:00:00Z'),
            exitAt: new Date('2026-10-05T16:00:00Z'),
            qty: new Decimal('100'),
            entryPrice: new Decimal('38.0000'),
            exitPrice: new Decimal('40.5000'),
            stopPrice: null,
            targetPrice: null,
            fees: new Decimal('2.5000'),
            irrf: new Decimal('0.2000'),
            grossPnl: new Decimal('250.0000'),
            netPnl: new Decimal('247.3000'),
            pnlPct: new Decimal('6.5079'),
            broker: 'XP',
            setupName: 'Pullback M9',
            followedPlan: true,
            notes: null,
            createdAt: new Date('2026-10-05T16:05:00Z'),
          },
        ],
        ingestionJobs: [],
        stagingItems: [],
        auditLogs: auditLogs
          .filter((l) => l.userId === userId)
          .map((l) => ({
            id: l.id,
            action: l.action,
            entityType: l.entityType,
            entityId: l.entityId,
            beforeSnapshot: l.beforeSnapshot,
            afterSnapshot: l.afterSnapshot,
            createdAtUtc: l.createdAtUtc,
          })),
      };
    },
    async recordExportAudit(params) {
      await auditService.recordAuditEvent(
        {
          action: 'DATA_EXPORT',
          entityType: 'PRIVACY_EXPORT',
          entityId: params.jobId,
          userId: params.userId,
          actorId: params.actorId,
          afterSnapshot: { trades_exported: params.tradesCount },
        },
        auditRepo,
      );
    },
    async deleteUserAccountAtomic(params) {
      const record = await auditService.recordAuditEvent(
        {
          action: 'ACCOUNT_DELETE',
          entityType: 'USER',
          entityId: params.userId,
          userId: params.userId,
          actorId: params.actorId,
          beforeSnapshot: params.beforeSnapshot,
          afterSnapshot: params.afterSnapshot,
        },
        auditRepo,
      );
      const u = usersById.get(params.userId);
      if (u) {
        usersByEmail.delete(u.email.toLowerCase());
        usersById.delete(params.userId);
      }
      return { auditId: record.id };
    },
  };

  const authService = new AuthService({
    repository: authRepo,
    jwtSecret: TEST_JWT_SECRET,
    bcryptCost: 4,
  });
  const privacyService = new PrivacyService(privacyRepo);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter(authService));
  app.use(
    '/api/v1/privacy',
    createAuthRlsMiddleware({ jwtSecret: TEST_JWT_SECRET }),
    createPrivacyRouter(privacyService),
  );

  return { app, usersById, usersByEmail, auditLogs, auditService, auditRepo };
}

describe('[SPEC-01][SPEC-03][SPEC-04] Autenticação, LGPD (Exportação ZIP + Exclusão Dupla) e Auditoria Imutável', () => {
  it('[SPEC-01] Dado visitante com e-mail válido, senha >= 10 caracteres e lgpd_consent=true, Quando cadastrar via POST /api/v1/auth/register, Então cria conta com hash bcrypt e requires_onboarding=true', async () => {
    const { app, usersByEmail } = createLgpdTestStack();

    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Rafael Trader',
      email: 'rafael.lgpd@exemplo.com',
      password: 'senha-segura-lgpd-2026',
      lgpd_consent: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.requires_onboarding).toBe(true);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();

    const saved = usersByEmail.get('rafael.lgpd@exemplo.com');
    expect(saved?.passwordHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare('senha-segura-lgpd-2026', saved!.passwordHash)).toBe(
      true,
    );
  });

  it('[SPEC-03] Dado usuário autenticado, Quando clicar em Exportar Meus Dados (POST /api/v1/privacy/export), Então gera .zip contendo JSON e CSV com precisão decimal e registra DATA_EXPORT na audit_logs', async () => {
    const { app, auditLogs } = createLgpdTestStack();

    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Maria Investidora',
        email: 'maria@exemplo.com',
        password: 'senha-forte-maria-2026',
        lgpd_consent: true,
      })
      .expect(201);

    const token = reg.body.access_token as string;

    const exportRes = await request(app)
      .post('/api/v1/privacy/export')
      .set('Authorization', `Bearer ${token}`)
      .expect(202);

    expect(exportRes.body.job_id).toBeTruthy();
    expect(exportRes.body.download_url).toContain('/download');

    const zipRes = await request(app)
      .get(exportRes.body.download_url as string)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const zip = await JSZip.loadAsync(zipRes.body as Buffer);
    expect(zip.file('user.json')).toBeTruthy();
    expect(zip.file('trades.json')).toBeTruthy();
    expect(zip.file('trades.csv')).toBeTruthy();
    expect(zip.file('audit_logs.json')).toBeTruthy();
    expect(zip.file('audit_logs.csv')).toBeTruthy();

    const tradesCsv = await zip.file('trades.csv')!.async('string');
    expect(tradesCsv).toContain('PETR4');
    expect(tradesCsv).toContain('247.3000');

    expect(auditLogs.some((l) => l.action === 'DATA_EXPORT')).toBe(true);
  });

  it('[SPEC-03] Dado usuário confirmando exclusão no modal duplo, Quando submeter frase "EXCLUIR MINHA CONTA" e senha correta em DELETE /api/v1/privacy/account, Então elimina dados do titular e audita ACCOUNT_DELETE', async () => {
    const { app, usersById, auditLogs } = createLgpdTestStack();

    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Carlos Trader',
        email: 'carlos@exemplo.com',
        password: 'senha-carlos-segura-99',
        lgpd_consent: true,
      })
      .expect(201);

    const token = reg.body.access_token as string;
    const userId = reg.body.user_id as string;

    // Frase errada -> 400
    await request(app)
      .delete('/api/v1/privacy/account')
      .set('Authorization', `Bearer ${token}`)
      .send({
        confirmation_phrase: 'QUERO SAIR',
        password: 'senha-carlos-segura-99',
      })
      .expect(400);

    // Senha errada -> 401
    await request(app)
      .delete('/api/v1/privacy/account')
      .set('Authorization', `Bearer ${token}`)
      .send({
        confirmation_phrase: ACCOUNT_DELETE_CONFIRMATION_PHRASE,
        password: 'senha-incorreta-000',
      })
      .expect(401);

    // Frase exata + senha correta -> 200, dados eliminados e evento ACCOUNT_DELETE preservado
    const delRes = await request(app)
      .delete('/api/v1/privacy/account')
      .set('Authorization', `Bearer ${token}`)
      .send({
        confirmation_phrase: ACCOUNT_DELETE_CONFIRMATION_PHRASE,
        password: 'senha-carlos-segura-99',
      })
      .expect(200);

    expect(delRes.body.deleted).toBe(true);
    expect(delRes.body.audit_id).toBeTruthy();
    expect(usersById.has(userId)).toBe(false);

    const deleteAudit = auditLogs.find((l) => l.action === 'ACCOUNT_DELETE');
    expect(deleteAudit).toBeDefined();
    expect(deleteAudit?.afterSnapshot).toMatchObject({
      anonymized: true,
      personal_data_removed: true,
    });
  });

  it('[SPEC-04] Dado uma alteração fiscal ou operacional, Quando gravada na audit_logs, Então persiste before/after imutavelmente e bloqueia UPDATE/DELETE na aplicação e no banco (RNF-30)', async () => {
    const { auditService, auditRepo } = createLgpdTestStack();
    const userId = randomUUID();
    const entityId = randomUUID();

    const created = await auditService.recordAuditEvent(
      {
        action: 'FISCAL_PRIOR_LOSS_SET',
        entityType: 'FISCAL_ADJUSTMENT',
        entityId,
        userId,
        actorId: userId,
        beforeSnapshot: { day_trade: new Decimal('0') },
        afterSnapshot: { day_trade: new Decimal('1500.00') },
      },
      auditRepo,
    );

    expect(created.beforeSnapshot).toEqual({ day_trade: '0.0000' });
    expect(created.afterSnapshot).toEqual({ day_trade: '1500.0000' });

    // Camada de serviço estritamente append-only
    expect('update' in auditService).toBe(false);
    expect('delete' in auditService).toBe(false);

    // Camada PostgreSQL (migration 001): REVOKE UPDATE/DELETE + Trigger defensivo
    const sqlPath = resolve(
      process.cwd(),
      'apps/api/src/db/migrations/001_init_rls_audit.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    expect(sql).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM tradepilot_app;',
    );
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE audit_logs TO tradepilot_app;');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON audit_logs');
  });
});
