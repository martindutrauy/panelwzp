import { defineConfig } from 'prisma/config';

export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations'
    },
    // Prisma ORM v7: la URL va acá (no en schema.prisma)
    // No usamos env() para no romper comandos que no requieren DB en entornos sin DATABASE_URL.
    datasource: {
        // Prisma (v7) exige un string no-vacío para algunos comandos (p.ej. migrate diff).
        // En Railway siempre debe setearse DATABASE_URL. Este fallback es solo para dev/local.
        url: process.env.DATABASE_URL ?? 'mysql://root:root@localhost:3306/panelwzp'
    }
});

