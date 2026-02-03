import React, { useEffect, useState } from 'react';
import { Button, ConfigProvider, notification, theme } from 'antd';
import { MessageSquare } from 'lucide-react';
import { WhatsAppPanelModal } from './components/WhatsAppPanelModal';
import { Login } from './components/Login';
import { clearAuthToken, getAuthToken } from './lib/auth';
import { apiFetch } from './lib/runtime';
import { unlockNotificationAudio } from './services/notificationSound.service';
import { initTts } from './services/tts.service';
import { GlobalSecurityModal } from './components/GlobalSecurityModal';
import { useSocket } from './hooks/useSocket';
import { VisualNotificationsOverlay, addVisualNotification } from './components/VisualNotifications';

function App() {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSecurityOpen, setIsSecurityOpen] = useState(false);
    const [authed, setAuthed] = useState(() => Boolean(getAuthToken()));
    const socket = useSocket();
    const [notificationApi, notificationContextHolder] = notification.useNotification();

    useEffect(() => {
        const unlock = () => {
            try {
                const w = window as any;
                if (!w.__wzpAudioCtx) {
                    w.__wzpAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
                }
                const audioCtx: AudioContext = w.__wzpAudioCtx;
                if (audioCtx.state === 'suspended') {
                    audioCtx.resume().catch(() => {});
                }
                if (audioCtx.state !== 'running') return;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                gain.gain.value = 0.00001;
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                const now = audioCtx.currentTime;
                osc.start(now);
                osc.stop(now + 0.01);
            } catch {}
            unlockNotificationAudio();
        };

        window.addEventListener('pointerdown', unlock, true);
        window.addEventListener('keydown', unlock, true);
        return () => {
            window.removeEventListener('pointerdown', unlock, true);
            window.removeEventListener('keydown', unlock, true);
        };
    }, []);

    useEffect(() => {
        initTts();
    }, []);

    useEffect(() => {
        if (!socket) return;
        const handler = (evt: any) => {
            const action = String(evt?.action || 'security');
            notificationApi.warning({
                message: 'Seguridad',
                description: action,
                placement: 'topRight',
                duration: 6
            });
        };
        socket.on('security:event', handler);
        return () => {
            socket.off('security:event', handler);
        };
    }, [socket]);

    // Escuchar mensajes nuevos para notificaciones visuales
    useEffect(() => {
        if (!socket) return;
        
        // Almacenar nombres de dispositivos
        const deviceNames = new Map<string, string>();
        
        // Cargar nombres de dispositivos
        const loadDeviceNames = async () => {
            try {
                const res = await apiFetch('/api/devices');
                const devices = await res.json();
                if (Array.isArray(devices)) {
                    devices.forEach((d: any) => {
                        deviceNames.set(d.id, d.name || d.id);
                    });
                }
                console.log('[VisualNotifications] Dispositivos cargados:', deviceNames.size);
            } catch (e) {
                console.error('[VisualNotifications] Error cargando dispositivos:', e);
            }
        };
        loadDeviceNames();
        
        const handler = (data: any) => {
            console.log('[VisualNotifications] Mensaje recibido:', data);
            
            const deviceId = String(data?.deviceId || '');
            const chatId = String(data?.chatId || '');
            const msg = data?.msg || {};
            
            // No mostrar mensajes propios
            if (msg.fromMe) {
                console.log('[VisualNotifications] Ignorando mensaje propio');
                return;
            }
            
            const msgId = String(msg.id || `${Date.now()}-${Math.random()}`);
            const senderName = msg.senderName || chatId.split('@')[0] || 'Desconocido';
            const branchName = deviceNames.get(deviceId) || deviceId;
            
            console.log('[VisualNotifications] Agregando notificación:', { msgId, senderName, branchName });
            
            addVisualNotification({
                id: msgId,
                branchId: deviceId,
                branchName,
                chatId,
                senderName,
                messageText: msg.text || null,
                messageType: msg.type || 'text',
                timestamp: msg.timestamp || Date.now()
            });
        };
        
        socket.on('message:new', handler);
        return () => {
            socket.off('message:new', handler);
        };
    }, [socket]);

    if (!authed) {
        return <Login onLoggedIn={() => setAuthed(true)} />;
    }

    return (
        <ConfigProvider
            theme={{
                algorithm: theme.darkAlgorithm,
                token: {
                    colorPrimary: '#25D366',
                    borderRadius: 8,
                },
            }}
        >
            {notificationContextHolder}
            <VisualNotificationsOverlay />
            <div style={{
                height: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#0b141a',
                flexDirection: 'column',
                gap: '20px'
            }}>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                        <h1 style={{ color: '#e9edef', margin: 0 }}>Panel WhatsApp Multi-Dispositivo</h1>
                        <Button type="default" onClick={() => setIsSecurityOpen(true)}>
                            🔒 Seguridad
                        </Button>
                    </div>
                    <p style={{ color: '#8696a0' }}>Modelo OWNER + ADMINS (control total preservado)</p>
                </div>

                <Button
                    type="primary"
                    size="large"
                    icon={<MessageSquare size={18} />}
                    onClick={() => setIsModalOpen(true)}
                    style={{ height: '50px', borderRadius: '25px', padding: '0 30px', fontWeight: 'bold' }}
                >
                    Abrir Panel WhatsApp
                </Button>
                <Button
                    type="text"
                    onClick={() => {
                        clearAuthToken();
                        setAuthed(false);
                    }}
                    style={{ color: '#8696a0' }}
                >
                    Cerrar sesión
                </Button>

                <WhatsAppPanelModal
                    visible={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                />
                <GlobalSecurityModal open={isSecurityOpen} onClose={() => setIsSecurityOpen(false)} />
            </div>
        </ConfigProvider>
    );
}

export default App;
