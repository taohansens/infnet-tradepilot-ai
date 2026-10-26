import bcrypt from 'bcryptjs';
import JSZip from 'jszip';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETE_CONFIRMATION_PHRASE,
} from '@tradepilot/shared';
import {
  AuthService,
  AuthServiceError,
  type AuthRepository,
  type AuthUserLookup,
} from '../services/authService.js';
import {
  PrivacyService,
  PrivacyServiceError,
  type PrivacyDataSnapshot,
  type PrivacyRepository,
} from '../services/privacyService.js';
import { runWithRlsContext } from '../db/rlsContext.js';

const TEST_SECRET = 'segredo-jwt-para-testes-automatizados-32chars';
const USER_A_ID = '11111111-1111-4111-8111-111111111111';
const USER_B_ID = '99999999-9999-4999-8999-999999999999';

function createInMemoryAuthRepo(): AuthRepository {
  const usersByEmail = new Map<string, AuthUserLookup>();
  return {
    async findUserByEmail(email: string) {
      return usersByEmail.get(email.toLowerCase()) ?? null;
    },
    async createUserWithRls(input) {
      const created: AuthUserLookup = {
        id: input.id,
        email: input.email,
        passwordHash: input.passwordHash,
        totpEnabled: false,
        planStatus: 'trial',
        onboardingCompleted: false,
      };
      usersByEmail.set(created.email.toLowerCase(), created);
      return created;
    },
  };
}

/**
 * Testes automatizados dos requisitos SPEC-01, SPEC-03 e SPEC-04.
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-1
 * @rf RF-T-4
 * @rnf RNF-11
 * @rnf RNF-12
 * @rnf RNF-13
 * @rnf RNF-30
 */
describe('AuthService (SPEC-01 — Register, Login, Refresh, 2FA)', () => {
  it('rejeita cadastro com senha menor que 10 caracteres ou sem lgpd_consent=true', async () => {
    const service = new AuthService({
      repository: createInMemoryAuthRepo(),
      jwtSecret: TEST_SECRET,
      bcryptCost: 4,
    });

    await expect(
      service.register({
        name: 'Rafael',
        email: 'rafael@exemplo.com',
        password: 'curta',
        lgpd_consent: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'WEAK_PASSWORD' });

    await expect(
      service.register({
        name: 'Rafael',
        email: 'rafael@exemplo.com',
        password: 'senha-forte-1234',
        lgpd_consent: false,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'LGPD_CONSENT_REQUIRED' });
  });

  it('cadastra com hash bcrypt, emite JWT + refresh token e faz login e rotação', async () => {
    const repo = createInMemoryAuthRepo();
    const service = new AuthService({
      repository: repo,
      jwtSecret: TEST_SECRET,
      bcryptCost: 4,
    });

    const registered = await service.register({
      name: 'Rafael Trader',
      email: 'rafael@exemplo.com',
      password: 'senha-super-segura-2026',
      lgpd_consent: true,
    });

    expect(registered.user_id).toBeTruthy();
    expect(registered.access_token).toBeTruthy();
    expect(registered.refresh_token).toBeTruthy();
    expect(registered.expires_in).toBe(900);
    expect(registered.requires_onboarding).toBe(true);

    // Hash armazenado não é texto claro
    const stored = await repo.findUserByEmail('rafael@exemplo.com');
    expect(stored?.passwordHash.startsWith('$2')).toBe(true);

    // Login válido
    const loggedIn = await service.login({
      email: 'rafael@exemplo.com',
      password: 'senha-super-segura-2026',
    });
    expect('access_token' in loggedIn).toBe(true);

    // Rotação de refresh token e bloqueio de reuso
    const rotated = await service.refresh(registered.refresh_token);
    expect(rotated.access_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(registered.refresh_token);

    await expect(service.refresh(registered.refresh_token)).rejects.toThrow(
      AuthServiceError,
    );
  });

  it('solicita código TOTP de 6 dígitos quando 2FA está habilitado', async () => {
    const passwordHash = await bcrypt.hash('senha-segura-123', 4);
    const repo: AuthRepository = {
      async findUserByEmail() {
        return {
          id: USER_A_ID,
          email: '2fa@exemplo.com',
          passwordHash,
          totpEnabled: true,
          totpSecret: 'segredo-totp-teste',
          planStatus: 'active',
          onboardingCompleted: true,
        };
      },
      async createUserWithRls() {
        throw new Error('not used');
      },
    };

    const service = new AuthService({
      repository: repo,
      jwtSecret: TEST_SECRET,
      bcryptCost: 4,
    });

    const step1 = await service.login({
      email: '2fa@exemplo.com',
      password: 'senha-segura-123',
    });
    expect('requires_2fa' in step1 && step1.requires_2fa).toBe(true);
  });
});

describe('PrivacyService (SPEC-03 & SPEC-04 — Exportação ZIP e Exclusão LGPD)', () => {
  async function createSnapshot(): Promise<PrivacyDataSnapshot> {
    const passwordHash = await bcrypt.hash('minha-senha-segura-10', 4);
    return {
      user: {
        id: USER_A_ID,
        name: 'Titular Teste',
        email: 'titular@exemplo.com',
        passwordHash,
        totpEnabled: false,
        lgpdConsentAt: new Date('2026-10-01T10:00:00Z'),
        onboardingCompleted: true,
        planCode: 'pro_monthly',
        planStatus: 'active',
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      trades: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          ticker: 'WINZ26',
          marketType: 'WIN',
          side: 'LONG',
          taxSilo: 'DAY_TRADE',
          source: 'MANUAL',
          isDemo: false,
          entryAt: new Date('2026-10-09T13:05:00Z'),
          exitAt: new Date('2026-10-09T13:22:00Z'),
          qty: new Decimal('2'),
          entryPrice: new Decimal('131200.0000'),
          exitPrice: new Decimal('131450.0000'),
          stopPrice: new Decimal('131050.0000'),
          targetPrice: new Decimal('131500.0000'),
          fees: new Decimal('1.8000'),
          irrf: new Decimal('1.0000'),
          grossPnl: new Decimal('100.0000'),
          netPnl: new Decimal('97.2000'),
          pnlPct: new Decimal('0.1900'),
          broker: 'XP',
          setupName: 'Rompimento VWAP',
          followedPlan: true,
          notes: 'Execução disciplinada',
          createdAt: new Date('2026-10-09T13:25:00Z'),
        },
      ],
      ingestionJobs: [],
      stagingItems: [],
      auditLogs: [],
    };
  }

  it('gera arquivo ZIP válido (JSON + CSV), registra DATA_EXPORT e isola download por tenant', async () => {
    const snapshot = await createSnapshot();
    const recordExportAudit = vi.fn(async () => undefined);
    const repo: PrivacyRepository = {
      collectUserData: vi.fn(async () => snapshot),
      recordExportAudit,
      deleteUserAccountAtomic: vi.fn(async () => ({ auditId: 'audit-1' })),
    };

    const service = new PrivacyService(repo);

    const job = await runWithRlsContext(
      { userId: USER_A_ID, requestId: 'req-export-1' },
      () => service.createDataExport(),
    );

    expect(job.status).toBe('ready');
    expect(job.download_url).toContain(job.job_id);
    expect(recordExportAudit).toHaveBeenCalledTimes(1);

    // Download autorizado para o mesmo titular
    const downloaded = runWithRlsContext(
      { userId: USER_A_ID, requestId: 'req-dl-1' },
      () => service.getExportDownload(job.job_id),
    );
    const zip = await JSZip.loadAsync(downloaded.buffer);
    expect(zip.file('user.json')).toBeTruthy();
    expect(zip.file('trades.json')).toBeTruthy();
    expect(zip.file('trades.csv')).toBeTruthy();
    expect(zip.file('audit_logs.json')).toBeTruthy();
    expect(zip.file('audit_logs.csv')).toBeTruthy();

    const userJson = JSON.parse(await zip.file('user.json')!.async('string'));
    expect(userJson.email).toBe('titular@exemplo.com');
    expect(userJson.passwordHash).toBeUndefined();

    const tradesCsv = await zip.file('trades.csv')!.async('string');
    expect(tradesCsv).toContain('WINZ26');
    expect(tradesCsv).toContain('97.2000');

    // Outro usuário (USER_B) NÃO pode baixar o ZIP do USER_A (RNF-11)
    expect(() =>
      runWithRlsContext({ userId: USER_B_ID, requestId: 'req-dl-2' }, () =>
        service.getExportDownload(job.job_id),
      ),
    ).toThrow(PrivacyServiceError);
  });

  it('exige frase "EXCLUIR MINHA CONTA" + senha correta e audita ACCOUNT_DELETE atomicamente', async () => {
    const snapshot = await createSnapshot();
    const deleteAtomic = vi.fn(async () => ({
      auditId: '44444444-4444-4444-8444-444444444444',
    }));
    const repo: PrivacyRepository = {
      collectUserData: vi.fn(async () => snapshot),
      recordExportAudit: vi.fn(async () => undefined),
      deleteUserAccountAtomic: deleteAtomic,
    };

    const service = new PrivacyService(repo);

    // Frase incorreta -> 400
    await expect(
      runWithRlsContext({ userId: USER_A_ID, requestId: 'req-del-1' }, () =>
        service.deleteAccount({
          confirmation_phrase: 'apagar conta',
          password: 'minha-senha-segura-10',
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_CONFIRMATION_PHRASE',
    });

    // Senha incorreta -> 401
    await expect(
      runWithRlsContext({ userId: USER_A_ID, requestId: 'req-del-2' }, () =>
        service.deleteAccount({
          confirmation_phrase: ACCOUNT_DELETE_CONFIRMATION_PHRASE,
          password: 'senha-errada-12345',
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_PASSWORD' });

    // Frase e senha corretas -> exclusão + auditoria ACCOUNT_DELETE
    const result = await runWithRlsContext(
      { userId: USER_A_ID, requestId: 'req-del-3' },
      () =>
        service.deleteAccount({
          confirmation_phrase: ACCOUNT_DELETE_CONFIRMATION_PHRASE,
          password: 'minha-senha-segura-10',
        }),
    );

    expect(result.deleted).toBe(true);
    expect(result.audit_id).toBe('44444444-4444-4444-8444-444444444444');
    expect(deleteAtomic).toHaveBeenCalledTimes(1);
  });
});
