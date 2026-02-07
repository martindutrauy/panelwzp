# WhatsApp Panel Multi-Dispositivo

Panel web/desktop para administrar múltiples sesiones de WhatsApp (sucursales), con chat, plantillas, archivos y estadísticas.

## Estructura

- `backend/`: API + Socket.IO + Baileys (WhatsApp)
- `frontend/`: Vite + React + Ant Design
- `desktop/`: Electron (empaqueta frontend y levanta backend local)

## Requisitos

- Node.js (LTS recomendado)
- WhatsApp en el teléfono para vincular dispositivos

## Configuración (seguridad)

El acceso al panel está protegido por un modelo **OWNER + ADMINS** (control total preservado).

- Backend:
  - `OWNER_USERNAME` (ej: `admin`)
  - `OWNER_PASSWORD` (obligatoria, no se cambia desde la UI)
  - `APP_AUTH_SECRET` (default dev: `dev-secret-change-me`)
- Los usuarios/sesiones/logs se guardan en `db/security/*` (la carpeta `db/` está ignorada por git).

## Desarrollo (web)

### 1) Backend

```bash
cd backend
npm install
npm run start
```

Levanta en `http://127.0.0.1:5000`.

### 2) Frontend

```bash
cd frontend
npm install
npm run dev
```

El frontend usa proxy a `http://127.0.0.1:5000` (según `vite.config.ts`) o variables:

- `VITE_API_BASE`
- `VITE_SOCKET_URL`

## Desktop (Electron)

```bash
cd desktop
npm install
npm run dev
```

Para empaquetar:

```bash
cd desktop
npm run build
```

## Notas

- No subir la carpeta `db/` ni archivos `.env*`.
- Si perdés la contraseña del OWNER, se recupera únicamente por acceso al servidor (variables de entorno).
