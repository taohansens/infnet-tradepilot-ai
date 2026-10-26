import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { createAuthRlsMiddleware } from '../middlewares/authRls.js';
import { getRequiredRlsContext, RlsContextError } from '../db/rlsContext.js';
import {
  AuditService,
  sanitizeAuditSnapshot,
  type AuditLogRepository,
} from '../services/auditService.js';

const USER_A_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';
const TEST_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-123456';

function createMockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

/**
 * Testes unitários de isolamento RLS, middleware authRls, serviço append-only
 * e verificação estrutural da migration 001_init_rls_audit.sql.
 *
 * @spec SPEC-01
 * @spec SPEC-04
 * @rf RF-T-1
 * @rnf RNF-11
 * @rnf RNF-30
 */
describe('AuthRlsMiddleware & RlsContext (SPEC-01, RNF-11)', () => {
  const middleware = createAuthRlsMiddleware({
    jwtSecret: TEST_SECRET,
    jwtIssuer: 'tradepilot-ai',
    jwtAudience: 'tradepilot-ai-web',
  });

  it('rejeita requisição sem Bearer token com 401', () => {
    const req = { headers: {}, ip: '127.0.0.1' } as unknown as Request;
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejeita token com subject não-UUID (fail-closed)', () => {
    const token = jwt.sign({ sub: 'not-a-uuid' }, TEST_SECRET, {
      issuer: 'tradepilot-ai',
      audience: 'tradepilot-ai-web',
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      ip: '127.0.0.1',
    } as unknown as Request;
    const res = createMockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('valida JWT, popula req.auth e propaga userId via AsyncLocalStorage', () => {
    const token = jwt.sign(
      { sub: USER_A_ID, email: 'trader@exemplo.com', plan_status: 'active' },
      TEST_SECRET,
      {
        issuer: 'tradepilot-ai',
        audience: 'tradepilot-ai-web',
        expiresIn: 900,
      },
    );

    const req = {
      headers: { authorization: `Bearer ${token}`, 'x-request-id': 'req-123' },
      ip: '127.0.0.1',
    } as unknown as Request;
    const res = createMockRes();

    let capturedUserId: string | undefined;
    const next = vi.fn(() => {
      const ctx = getRequiredRlsContext();
      capturedUserId = ctx.userId;
    });

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth?.userId).toBe(USER_A_ID);
    expect(req.auth?.requestId).toBe('req-123');
    expect(typeof req.runInRlsTransaction).toBe('function');
    expect(capturedUserId).toBe(USER_A_ID);
    // Fora do escopo da requisição, o contexto não vaza (fail-closed)
    expect(() => getRequiredRlsContext()).toThrow(RlsContextError);
  });
});

describe('AuditService append-only (SPEC-04, RNF-30)', () => {
  it('não expõe métodos update ou delete na camada de serviço', () => {
    const service = new AuditService();
    expect('update' in service).toBe(false);
    expect('delete' in service).toBe(false);
    expect('remove' in service).toBe(false);
  });

  it('serializa valores Decimal com 4 casas exatas sem perda de precisão', () => {
    const sanitized = sanitizeAuditSnapshot({
      exitPrice: new Decimal('5450.5'),
      fees: new Decimal('2.4'),
      nested: { irrf: new Decimal('0.005') },
    });

    expect(sanitized).toEqual({
      exitPrice: '5450.5000',
      fees: '2.4000',
      nested: { irrf: '0.0050' },
    });
  });

  it('grava evento imutável via transação injetada preservando before/after', async () => {
    const createMock = vi.fn(async ({ data }) => ({
      id: '33333333-3333-4333-8333-333333333333',
      ...data,
      createdAtUtc: new Date('2026-11-22T19:00:00Z'),
    }));

    const fakeTx: AuditLogRepository = {
      auditLog: {
        create: createMock,
        findMany: vi.fn(async () => []),
      },
    };

    const service = new AuditService();
    const created = await service.recordAuditEvent(
      {
        action: 'FISCAL_PRIOR_LOSS_SET',
        entityType: 'FISCAL_ADJUSTMENT',
        entityId: ENTITY_ID,
        userId: USER_A_ID,
        actorId: USER_A_ID,
        beforeSnapshot: { day_trade: new Decimal('0') },
        afterSnapshot: { day_trade: new Decimal('1500.00') },
      },
      fakeTx,
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(created.action).toBe('FISCAL_PRIOR_LOSS_SET');
    expect(created.beforeSnapshot).toEqual({ day_trade: '0.0000' });
    expect(created.afterSnapshot).toEqual({ day_trade: '1500.0000' });
  });
});

describe('Verificação estrutural da migration 001_init_rls_audit.sql', () => {
  const sqlPath = resolve(
    process.cwd(),
    'src/db/migrations/001_init_rls_audit.sql',
  );
  const sql = readFileSync(sqlPath, 'utf8');

  it('ativa ENABLE e FORCE ROW LEVEL SECURITY nas 5 tabelas obrigatórias', () => {
    for (const table of [
      'users',
      'audit_logs',
      'trades',
      'ingestion_jobs',
      'staging_items',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('garante audit_logs estritamente append-only com REVOKE e trigger', () => {
    expect(sql).toContain('NOBYPASSRLS');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM tradepilot_app;');
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE audit_logs TO tradepilot_app;');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON audit_logs');
  });

  it('usa NUMERIC(18, 4) e não usa FLOAT/REAL/DOUBLE PRECISION no DDL', () => {
    const ddlWithoutComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(ddlWithoutComments).toContain('NUMERIC(18, 4)');
    expect(ddlWithoutComments).not.toMatch(/\b(FLOAT|DOUBLE PRECISION|REAL)\b/i);
  });
});
