/**
 * Cliente Prisma do Postgres principal (fonte de verdade).
 * `pool` (`./pool.ts`) mantém-se em paralelo até as rotas migrarem para Prisma.
 *
 * Migrado de legacy/backend/config/prisma.ts (sem mudança de comportamento).
 */
import { PrismaClient } from '@prisma/client';

const logLevels: ('warn' | 'error')[] = ['warn', 'error'];

function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? logLevels : ['error'],
  });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Instância única do processo. Fora de produção, cacheada em `globalThis`
 *  pra sobreviver a hot-reload sem abrir uma conexão nova a cada reload. */
export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/** Conecta explicitamente no boot (Prisma conecta lazy na 1ª query por
 *  padrão; chamar isso cedo faz o processo falhar rápido se o banco estiver
 *  fora, em vez de só falhar na primeira request de um usuário). */
export async function connectPrisma(): Promise<void> {
  await prisma.$connect();
}

/** Fecha a conexão — chamado no shutdown gracioso do processo. */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
