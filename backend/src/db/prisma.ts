import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

const isProdLike = () => {
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    if (env === 'production') return true;
    // Railway suele inyectar varias env vars; cualquiera de estas indica “prod-like”.
    if (process.env.RAILWAY_ENVIRONMENT) return true;
    if (process.env.RAILWAY_PROJECT_ID) return true;
    return false;
};

export function assertDatabaseConfigured() {
    const url = String(process.env.DATABASE_URL || '').trim();
    if (!url && isProdLike()) {
        throw new Error(
            'DATABASE_URL no está configurada. En producción (Railway) la base de datos es requerida para estabilidad. ' +
            'Configura la variable DATABASE_URL en el service del backend.'
        );
    }
}

export function getPrisma(): PrismaClient | null {
    const url = String(process.env.DATABASE_URL || '').trim();
    if (!url) {
        if (isProdLike()) {
            // Fail-fast en producción: mejor fallar claro que seguir “medio vivo”.
            throw new Error(
                'DATABASE_URL no está configurada. El backend no puede inicializar Prisma en producción.'
            );
        }
        return null;
    }
    if (!prisma) {
        // Prisma v7 con engineType=binary: podemos inyectar la URL en runtime de forma explícita.
        prisma = new PrismaClient({
            datasources: {
                db: { url }
            }
        });
    }
    return prisma;
}

