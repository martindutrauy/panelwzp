import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors, { type CorsOptions } from 'cors';
import multer from 'multer';
import { DeviceManager } from './manager/DeviceManager';
import { TemplateManager } from './manager/TemplateManager';
import { LabelManager } from './manager/LabelManager';
import { exportToJSON, exportToCSV, exportToTXT } from './utils/export';
import path from 'path';
import fs from 'fs';
import { DB_ROOT } from './config/paths';
import { ensureDir } from './config/ensureDir';
import { changePassword, signAuthToken, verifyAuthToken, verifyCredentials } from './auth/appAuth';

const parseAllowedOrigins = (): string[] | '*' | null => {
    const raw = String(process.env.APP_CORS_ORIGINS || '').trim();
    if (!raw) return null;
    if (raw === '*') return '*';
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set(parts));
};

const allowedOrigins = parseAllowedOrigins();
const corsOptions: CorsOptions = allowedOrigins === '*' || !allowedOrigins
    ? { origin: '*' }
    : {
        origin: (origin, cb) => {
            if (!origin) return cb(null, true);
            if ((allowedOrigins as string[]).includes(origin)) return cb(null, true);
            return cb(new Error('CORS_NOT_ALLOWED'), false);
        }
    };

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: allowedOrigins === '*' || !allowedOrigins ? '*' : allowedOrigins }
});

const deviceManager = DeviceManager.getInstance();
const templateManager = TemplateManager.getInstance();
const labelManager = LabelManager.getInstance();
deviceManager.setIO(io);

// Configuración de multer para manejo de archivos
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB máximo
});

app.use(cors(corsOptions));
app.use(express.json());
ensureDir(DB_ROOT);
app.use('/storage', express.static(path.join(DB_ROOT, 'storage')));

app.post('/api/auth/login', (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!verifyCredentials(String(username || ''), String(password || ''))) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        const token = signAuthToken(String(username));
        res.json({ token, username: String(username) });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Error al iniciar sesión' });
    }
});

app.use('/api', (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.path === '/auth/login') return next();

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const verified = verifyAuthToken(token);
    if (!verified) return res.status(401).json({ error: 'No autorizado' });
    (req as any).user = verified;
    next();
});

app.post('/api/auth/change-password', (req, res) => {
    try {
        const user = (req as any).user as { username: string } | undefined;
        if (!user?.username) return res.status(401).json({ error: 'No autorizado' });
        const { currentPassword, newPassword } = req.body || {};
        const result = changePassword(user.username, String(currentPassword || ''), String(newPassword || ''));
        if (!result.ok) return res.status(400).json({ error: result.error });
        return res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Error al cambiar contraseña' });
    }
});

// REST Routes
app.get('/api/devices', (req, res) => {
    try {
        res.json(deviceManager.getDevices());
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Error al obtener dispositivos' });
    }
});

app.post('/api/devices', (req, res) => {
    try {
        const { name } = req.body;
        const device = deviceManager.createDevice(name);
        res.json(device);
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Error al crear dispositivo' });
    }
});

app.patch('/api/devices/:id', (req, res) => {
    try {
        const { name } = req.body;
        const updated = deviceManager.renameDevice(req.params.id, name);
        if (!updated) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        res.json(updated);
    } catch (error: any) {
        res.status(400).json({ error: error.message || 'Error al actualizar dispositivo' });
    }
});

app.post('/api/devices/:id/start', async (req, res) => {
    try {
        await deviceManager.initDevice(req.params.id, 'qr');
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/pairing-code', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        const result = await deviceManager.requestPairingCode(req.params.id, phoneNumber);
        res.json(result);
    } catch (error: any) {
        const status = typeof error?.status === 'number'
            ? error.status
            : (String(error?.message || '').includes('no encontrado') ? 404 : 400);
        res.status(status).json({ error: error?.message || 'Error al generar código' });
    }
});

app.post('/api/devices/:id/stop', async (req, res) => {
    await deviceManager.stopDevice(req.params.id);
    res.json({ success: true });
});

// Desconectar y limpiar datos de conexión
app.post('/api/devices/:id/disconnect-clean', async (req, res) => {
    try {
        const result = await deviceManager.disconnectAndClean(req.params.id);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Eliminar dispositivo completamente
app.delete('/api/devices/:id', async (req, res) => {
    try {
        const result = await deviceManager.deleteDevice(req.params.id);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Obtener lista de chats
app.get('/api/devices/:id/chats', async (req, res) => {
    try {
        const chats = await deviceManager.getChats(req.params.id);
        res.json(chats);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Obtener mensajes de un chat
app.get('/api/devices/:id/chats/:chatId/messages', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
        const messages = await deviceManager.getChatMessages(req.params.id, req.params.chatId, limit);
        res.json(messages);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:id/messages/summary', (req, res) => {
    try {
        res.json(deviceManager.getMessageSummary(req.params.id));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/import-messages', async (req, res) => {
    try {
        const result = await deviceManager.importDeviceMessagesFromDevice(req.params.id);
        res.json(result);
    } catch (error: any) {
        const status = Number(error?.status || 500);
        res.status(status).json({ error: error.message });
    }
});

app.get('/api/devices/:id/import-messages/status', (req, res) => {
    try {
        res.json(deviceManager.getImportMessagesStatus(req.params.id));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/import-messages/stop', (req, res) => {
    try {
        res.json(deviceManager.stopImportMessages(req.params.id));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Importar mensajes desde el dispositivo (solo si el chat está vacío en el panel)
app.post('/api/devices/:id/chats/:chatId/import-messages', async (req, res) => {
    try {
        const result = await deviceManager.importChatMessagesFromDevice(req.params.id, req.params.chatId);
        res.json(result);
    } catch (error: any) {
        const status = Number(error?.status || 500);
        res.status(status).json({ error: error.message });
    }
});

app.post('/api/devices/:id/chats/:chatId/import-profile-photo', async (req, res) => {
    try {
        const result = await deviceManager.importChatProfilePhoto(req.params.id, req.params.chatId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Buscar mensajes
app.get('/api/devices/:id/messages/search', async (req, res) => {
    try {
        const { q, chatId, limit, fromMe } = req.query;
        
        if (!q || typeof q !== 'string') {
            return res.status(400).json({ error: 'Se requiere el parámetro de búsqueda "q"' });
        }

        const results = await deviceManager.searchMessages(req.params.id, q, {
            chatId: chatId as string | undefined,
            limit: limit ? parseInt(limit as string) : 50,
            fromMe: fromMe === 'true' ? true : fromMe === 'false' ? false : undefined
        });

        res.json(results);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/chats/:chatId/send-text', async (req, res) => {
    try {
        const { text } = req.body;
        const result = await deviceManager.sendMessage(req.params.id, req.params.chatId, text);
        res.json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/chats/:chatId/send-media', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se proporcionó ningún archivo' });
        }

        const deviceId = req.params.id as string;
        const chatId = req.params.chatId as string;
        const { caption, isVoiceNote: isVoiceNoteRaw } = req.body;
        const isVoiceNote = isVoiceNoteRaw === 'true' || req.file.originalname?.includes('audio-nota-voz') || false;
        
        const result = await deviceManager.sendMedia(
            deviceId,
            chatId,
            req.file.buffer,
            req.file.mimetype || 'application/octet-stream',
            caption || req.file.originalname || 'archivo',
            isVoiceNote
        );
        
        res.json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/storage/files', (req, res) => {
    const { deviceId } = req.query;
    const storageRoot = path.join(DB_ROOT, 'storage');
    const files: any[] = [];

    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath);
            } else {
                const relativePath = path.relative(storageRoot, fullPath);
                // Filter by deviceId if provided
                if (deviceId && !relativePath.startsWith(deviceId as string)) return;

                files.push({
                    id: file,
                    fileName: file,
                    size: stat.size,
                    timestamp: stat.mtimeMs,
                    chatId: path.basename(path.dirname(fullPath)),
                    url: `/storage/${relativePath.replace(/\\/g, '/')}`
                });
            }
        });
    };

    walk(storageRoot);
    res.json(files.sort((a, b) => b.timestamp - a.timestamp));
});

// ========== TEMPLATES API ==========

app.get('/api/templates', (req, res) => {
    try {
        const templates = templateManager.getAllTemplates();
        res.json(templates);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/templates/categories', (req, res) => {
    try {
        const categories = templateManager.getCategories();
        res.json(categories);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/templates/search', (req, res) => {
    try {
        const { q } = req.query;
        const templates = q ? templateManager.searchTemplates(q as string) : templateManager.getAllTemplates();
        res.json(templates);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/templates/category/:category', (req, res) => {
    try {
        const templates = templateManager.getTemplatesByCategory(req.params.category);
        res.json(templates);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/templates', (req, res) => {
    try {
        const template = templateManager.createTemplate(req.body);
        res.json(template);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/templates/:id', (req, res) => {
    try {
        const template = templateManager.updateTemplate(req.params.id, req.body);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        res.json(template);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/templates/:id', (req, res) => {
    try {
        const success = templateManager.deleteTemplate(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Template not found' });
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/templates/:id/use', (req, res) => {
    try {
        templateManager.incrementUsage(req.params.id);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ========== LABELS API ==========

app.get('/api/labels', (req, res) => {
    try {
        const labels = labelManager.getAllLabels();
        res.json(labels);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/labels', (req, res) => {
    try {
        const label = labelManager.createLabel(req.body);
        res.json(label);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/labels/:id', (req, res) => {
    try {
        const label = labelManager.updateLabel(req.params.id, req.body);
        if (!label) {
            return res.status(404).json({ error: 'Label not found' });
        }
        res.json(label);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/labels/:id', (req, res) => {
    try {
        const success = labelManager.deleteLabel(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Label not found' });
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Chat label assignments

app.get('/api/devices/:deviceId/chats/:chatId/labels', (req, res) => {
    try {
        const labels = labelManager.getChatLabels(req.params.deviceId, req.params.chatId);
        res.json(labels);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/devices/:deviceId/chats/:chatId', async (req, res) => {
    try {
        const { deviceId, chatId } = req.params;
        const success = await deviceManager.deleteChat(deviceId, chatId);
        if (!success) return res.status(404).json({ error: 'Chat not found' });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/chats/:chatId/labels', (req, res) => {
    try {
        const { labelIds } = req.body;
        labelManager.assignLabels(req.params.deviceId, req.params.chatId, labelIds);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/chats/:chatId/labels/:labelId', (req, res) => {
    try {
        labelManager.addLabelToChat(req.params.deviceId, req.params.chatId, req.params.labelId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/devices/:deviceId/chats/:chatId/labels/:labelId', (req, res) => {
    try {
        labelManager.removeLabelFromChat(req.params.deviceId, req.params.chatId, req.params.labelId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/labels/:labelId/chats', (req, res) => {
    try {
        const chatIds = labelManager.getChatsByLabel(req.params.deviceId, req.params.labelId);
        res.json(chatIds);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ========== EXPORT API ==========

app.post('/api/export/chat', (req, res) => {
    try {
        const { messages, chatId, deviceId, format } = req.body;
        
        let filepath: string;
        
        switch (format) {
            case 'json':
                filepath = exportToJSON(messages, chatId, deviceId);
                break;
            case 'csv':
                filepath = exportToCSV(messages, chatId, deviceId);
                break;
            case 'txt':
                filepath = exportToTXT(messages, chatId, deviceId);
                break;
            default:
                return res.status(400).json({ error: 'Invalid format. Use json, csv, or txt' });
        }

        // Enviar el archivo
        res.download(filepath, path.basename(filepath), (err) => {
            if (err) {
                console.error('Error al enviar archivo:', err);
            }
            // Opcional: eliminar el archivo después de enviarlo
            // fs.unlinkSync(filepath);
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.use('/exports', express.static(path.join(DB_ROOT, 'exports')));

// ========== GROUPS API ==========

app.get('/api/devices/:id/groups', async (req, res) => {
    try {
        const groups = await deviceManager.getGroups(req.params.id);
        res.json(groups);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/groups', async (req, res) => {
    try {
        const { name, participants } = req.body;
        const result = await deviceManager.createGroup(req.params.id, name, participants);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:id/groups/:groupId', async (req, res) => {
    try {
        const metadata = await deviceManager.getGroupMetadata(req.params.id, req.params.groupId);
        res.json(metadata);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/groups/:groupId/participants', async (req, res) => {
    try {
        const { participants, action } = req.body;
        let result;
        
        switch (action) {
            case 'add':
                result = await deviceManager.addParticipantsToGroup(req.params.id, req.params.groupId, participants);
                break;
            case 'remove':
                result = await deviceManager.removeParticipantsFromGroup(req.params.id, req.params.groupId, participants);
                break;
            case 'promote':
                result = await deviceManager.promoteParticipants(req.params.id, req.params.groupId, participants);
                break;
            case 'demote':
                result = await deviceManager.demoteParticipants(req.params.id, req.params.groupId, participants);
                break;
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/devices/:id/groups/:groupId/subject', async (req, res) => {
    try {
        const { subject } = req.body;
        const result = await deviceManager.updateGroupSubject(req.params.id, req.params.groupId, subject);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/devices/:id/groups/:groupId/description', async (req, res) => {
    try {
        const { description } = req.body;
        const result = await deviceManager.updateGroupDescription(req.params.id, req.params.groupId, description);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/groups/:groupId/leave', async (req, res) => {
    try {
        const result = await deviceManager.leaveGroup(req.params.id, req.params.groupId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io
io.use((socket, next) => {
    const token = String((socket.handshake as any)?.auth?.token || '');
    const verified = verifyAuthToken(token);
    if (!verified) return next(new Error('UNAUTHORIZED'));
    (socket as any).user = verified;
    next();
});

io.on('connection', (socket) => {
    console.log('Client connected');
});

export const startBackend = (port: number = 5000) => {
    return new Promise<void>((resolve, reject) => {
        const onError = (err: any) => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.off('error', onError);
            console.log(`Backend running on port ${port}`);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
};

export const stopBackend = () => {
    return new Promise<void>((resolve, reject) => {
        server.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

if (require.main === module) {
    const port = process.env.PORT ? Number(process.env.PORT) : 5000;
    startBackend(Number.isFinite(port) ? port : 5000);
}
