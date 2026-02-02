import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient | null {
    const url = String(process.env.DATABASE_URL || '').trim();
    if (!url) return null;
    if (!prisma) {
        prisma = new PrismaClient();
    }
    return prisma;
}

