# Despliegue en Railway (Backend + Frontend) — Instructivo

Este documento describe el proceso completo para desplegar este proyecto en Railway usando GitHub como fuente.

## Qué se despliega

- **Backend (API + Socket.IO + Baileys)**: expone endpoints `/api/*` y el websocket `/socket.io`.
- **Frontend (Vite + React)**: sirve la UI y se conecta al backend por HTTP y Socket.IO.
- **Volumen persistente (Railway Volume)**: mantiene sesiones de WhatsApp, archivos y credenciales aun con redeploy.

## Requisitos

- Repo en GitHub con este código.
- Cuenta Railway con acceso a **Volumes**.
- Un teléfono con WhatsApp para vincular.

## Variables importantes

### Backend (service del backend)

- `OWNER_USERNAME`: usuario del propietario (ej: `admin`)
- `OWNER_PASSWORD`: contraseña del propietario (fuerte). No se cambia desde la UI
- `OWNER_EMAIL` (opcional): email del propietario (para referencia)
- `OWNER_TOTP_SECRET` (opcional): secreto TOTP del propietario (si se gestiona por env)
- `APP_AUTH_SECRET`: secreto largo (32+ chars)
- `APP_TOKEN_TTL_MS` (opcional): expiración del token (default 8h)
- `APP_SESSION_IDLE_TTL_MS` (opcional): expiración por inactividad (default 24h)
- `APP_PASSWORD_MIN_LEN` (opcional): mínimo de contraseña para usuarios (default 10)
- `APP_BCRYPT_ROUNDS` (opcional): costo de bcrypt (default 12)
- `APP_CORS_ORIGINS` (opcional): allowlist de orígenes (comma-separated) o `*`
  - Ej: `https://TU_FRONTEND.up.railway.app`
- `DB_ROOT` (opcional): si no se setea, el backend usa el volumen automáticamente si existe
- `PORT`: lo setea Railway (no tocar)

Persistencia:
- El backend guarda datos bajo `DB_ROOT` (por defecto en volumen si está montado).
- Dentro se guardan:
  - `devices.json` (sucursales/dispositivos)
  - `storage/` (archivos)
  - `auth/<deviceId>/` (sesiones Baileys)
  - `messages/` (base propia del panel: backup de mensajes por sucursal)
  - `security/owner.json` (estado OWNER: 2FA/emergency lock/token version)
  - `security/users.json` (usuarios ADMIN/USER)
  - `security/sessions.json` (sesiones del panel)
  - `security/audit.log` (logs inmutables de seguridad)

### Frontend (service del frontend)

- `VITE_API_BASE`: URL pública del backend (ej: `https://TU_BACKEND.up.railway.app`)
- `VITE_SOCKET_URL`: URL pública del backend (misma que arriba)

Nota: en Vite las variables `VITE_*` se “pegan” al compilar. Si las cambiás, tenés que redeployar el frontend.

## Paso a paso

### 1) Crear proyecto en Railway desde GitHub

1. Railway → **New Project** → **Deploy from GitHub Repo**.
2. Elegí el repo.

### 2) Backend: crear service apuntando a `backend/`

1. Crear/seleccionar el **service del backend**.
2. En **Settings → Source** (o similar), configurar:
   - **Root Directory / Service Path**: `backend`
3. En **Settings** configurar comandos:
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm run start:prod`
4. En **Variables** del backend, agregar:
   - `OWNER_USERNAME`
   - `OWNER_PASSWORD`
   - `APP_AUTH_SECRET`
5. En **Settings → Networking**:
   - **Generate Domain** para obtener `https://TU_BACKEND.up.railway.app`

### 3) Backend: volumen persistente (recomendado/obligatorio)

Objetivo: que la sesión de WhatsApp y los archivos no se pierdan al redeploy.

1. En el canvas del proyecto (Architecture), crear/adjuntar un **Volume** al backend.
2. **Mount path** recomendado: `/data`
3. Verificar que el backend siga funcionando y que la sesión persista tras redeploy.

Notas:
- Si existe volumen, Railway inyecta `RAILWAY_VOLUME_MOUNT_PATH` y el backend lo usa automáticamente.
- En la práctica, la sesión debe permanecer `CONNECTED` después de redeploy.

### 4) Frontend: crear service apuntando a `frontend/`

1. Crear un nuevo service desde el mismo repo.
2. En **Settings → Source** del frontend:
   - **Root Directory / Service Path**: `frontend`
3. En **Variables** del frontend, agregar:
   - `VITE_API_BASE=https://TU_BACKEND.up.railway.app`
   - `VITE_SOCKET_URL=https://TU_BACKEND.up.railway.app`
4. En **Settings** configurar comandos:
   - **Build Command**: `npm ci --include=dev && npm run build`
   - **Start Command**: `npm run preview -- --host 0.0.0.0 --port $PORT`
5. Hacer **Redeploy** del frontend.
6. En **Settings → Networking** del frontend:
   - **Generate Domain**
   - Si pide puerto y no se habilita: revisar logs del frontend y usar el puerto que esté escuchando (comúnmente `8080` en Railway).

### 5) Login y vinculación WhatsApp (QR)

1. Abrir la URL del frontend.
2. Loguear con `OWNER_USERNAME`/`OWNER_PASSWORD`.
3. Ir a **🔒 Seguridad** y configurar 2FA (obligatorio para OWNER y ADMINS).
3. Crear una sucursal/dispositivo (o usar uno existente).
4. Iniciar dispositivo → ver QR → escanear desde WhatsApp:
   - WhatsApp → Dispositivos vinculados → Vincular un dispositivo → escanear.
5. Confirmar que el estado sea `CONNECTED`.

## Backups del volumen (recomendado)

En el service del backend:

- Pestaña **Backups** → **Create Backup** para snapshot manual.
- **Edit schedule** para backups automáticos.
- **Restore** para volver a un backup.

Recomendación: crear un backup después de tener el primer dispositivo conectado y funcionando.

## Seguridad recomendada

### 1) CORS restringido

Por defecto el backend puede funcionar con `*`. Para producción, restringir:

- Backend → Variables:
  - `APP_CORS_ORIGINS=https://TU_FRONTEND.up.railway.app`
  - (si hay varios) `APP_CORS_ORIGINS=https://a.com,https://b.com`
- Redeploy del backend.

### 2) Secretos

- No compartir `OWNER_PASSWORD`, `APP_AUTH_SECRET`, tokens ni QR en capturas.
- Guardar `APP_AUTH_SECRET` en un gestor de secretos.
- Rotar `OWNER_PASSWORD` si se expuso.

## Troubleshooting

### “Cannot GET /” en el backend

Normal: el backend no sirve UI en `/`, solo APIs (`/api/*`).

### Frontend no muestra UI / “dist does not exist”

- Asegurar que el service del frontend tenga:
  - Root Directory `frontend`
  - Build Command que ejecute `npm run build`
  - Start Command usando `npm run preview ...`

### Generate Domain del frontend pide puerto

- Ir a **Deployments → View logs** del frontend y buscar el puerto.
- Poner ese puerto en la pantalla de Networking (frecuente: `8080`).

### 401 “No autorizado”

- Hacer login en el frontend.
- Verificar que `VITE_API_BASE` y `VITE_SOCKET_URL` apunten al backend correcto.
- Redeploy del frontend después de cambiar variables.

### Tras redeploy se pierde sesión WhatsApp

Esto indica problema de persistencia:
- Verificar que el backend tenga volumen conectado.
- Confirmar que la sesión sigue `CONNECTED` después de redeploy.

## Cómo guardar este instructivo en GitHub

1. Asegurar que el archivo exista en `docs/DEPLOY_RAILWAY.md`.
2. Subirlo al repo mediante commit normal (GitHub Desktop o git).
