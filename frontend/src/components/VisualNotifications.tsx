import React, { useEffect, useState } from 'react';
import { Avatar } from 'antd';
import { MessageCircle, Mic, Image, Video, FileText, MapPin, User, X } from 'lucide-react';

export interface VisualNotification {
    id: string;
    branchName: string;
    senderName: string;
    messageText?: string | null;
    messageType?: string;
    timestamp: number;
    chatId: string;
    branchId: string;
}

// Store global de notificaciones
let notifications: VisualNotification[] = [];
let listeners: Set<(n: VisualNotification[]) => void> = new Set();

const notifyListeners = () => {
    listeners.forEach(fn => fn([...notifications]));
};

export const addVisualNotification = (notif: VisualNotification) => {
    console.log('[VisualNotifications] addVisualNotification llamado:', notif);
    
    // Evitar duplicados
    if (notifications.some(n => n.id === notif.id)) {
        console.log('[VisualNotifications] Notificación duplicada, ignorando');
        return;
    }
    
    notifications = [notif, ...notifications].slice(0, 8); // Máximo 8 notificaciones
    console.log('[VisualNotifications] Total notificaciones:', notifications.length);
    notifyListeners();
    
    // Auto-remover después de 8 segundos
    setTimeout(() => {
        removeVisualNotification(notif.id);
    }, 8000);
};

export const removeVisualNotification = (id: string) => {
    notifications = notifications.filter(n => n.id !== id);
    notifyListeners();
};

export const clearAllVisualNotifications = () => {
    notifications = [];
    notifyListeners();
};

// Hook para suscribirse a las notificaciones
export const useVisualNotifications = () => {
    const [notifs, setNotifs] = useState<VisualNotification[]>([]);
    
    useEffect(() => {
        const handler = (n: VisualNotification[]) => setNotifs(n);
        listeners.add(handler);
        setNotifs([...notifications]);
        return () => { listeners.delete(handler); };
    }, []);
    
    return notifs;
};

// Componente de notificaciones visuales
export const VisualNotificationsOverlay: React.FC = () => {
    const notifs = useVisualNotifications();
    
    console.log('[VisualNotificationsOverlay] Renderizando con', notifs.length, 'notificaciones');
    
    if (notifs.length === 0) return null;
    
    const getMessageIcon = (type?: string) => {
        switch (type) {
            case 'audio': return <Mic size={14} />;
            case 'image': return <Image size={14} />;
            case 'video': return <Video size={14} />;
            case 'document': return <FileText size={14} />;
            case 'location': return <MapPin size={14} />;
            case 'contact': return <User size={14} />;
            default: return <MessageCircle size={14} />;
        }
    };
    
    const getMessagePreview = (notif: VisualNotification) => {
        const type = notif.messageType || 'text';
        switch (type) {
            case 'audio': return '🎤 Mensaje de voz';
            case 'image': return '📷 Imagen';
            case 'video': return '🎥 Video';
            case 'document': return '📄 Documento';
            case 'location': return '📍 Ubicación';
            case 'contact': return '👤 Contacto';
            case 'sticker': return '🎭 Sticker';
            default: return notif.messageText || 'Nuevo mensaje';
        }
    };
    
    return (
        <div style={{
            position: 'fixed',
            top: 20,
            right: 20,
            zIndex: 10000,
            display: 'grid',
            gridTemplateColumns: notifs.length > 1 ? 'repeat(2, 1fr)' : '1fr',
            gap: 12,
            maxWidth: notifs.length > 1 ? 700 : 350,
            pointerEvents: 'auto'
        }}>
            <style>{`
                @keyframes notifSlideIn {
                    0% { 
                        transform: translateX(100%) scale(0.8);
                        opacity: 0;
                    }
                    50% {
                        transform: translateX(-10px) scale(1.02);
                    }
                    100% { 
                        transform: translateX(0) scale(1);
                        opacity: 1;
                    }
                }
                @keyframes notifPulse {
                    0%, 100% { box-shadow: 0 8px 32px rgba(0, 210, 106, 0.3), 0 0 0 0 rgba(0, 210, 106, 0.4); }
                    50% { box-shadow: 0 8px 32px rgba(0, 210, 106, 0.5), 0 0 0 8px rgba(0, 210, 106, 0); }
                }
                @keyframes notifGlow {
                    0%, 100% { border-color: rgba(0, 210, 106, 0.6); }
                    50% { border-color: rgba(0, 210, 106, 1); }
                }
            `}</style>
            
            {notifs.map((notif, index) => (
                <div
                    key={notif.id}
                    style={{
                        background: 'linear-gradient(145deg, #1a2e1a 0%, #0d1f0d 100%)',
                        borderRadius: 12,
                        padding: 16,
                        border: '2px solid rgba(0, 210, 106, 0.6)',
                        boxShadow: '0 8px 32px rgba(0, 210, 106, 0.3), 0 4px 16px rgba(0, 0, 0, 0.5)',
                        animation: `notifSlideIn 0.4s ease-out ${index * 0.1}s both, notifPulse 2s ease-in-out infinite, notifGlow 1.5s ease-in-out infinite`,
                        cursor: 'pointer',
                        position: 'relative',
                        minWidth: 280
                    }}
                    onClick={() => removeVisualNotification(notif.id)}
                >
                    {/* Botón cerrar */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            removeVisualNotification(notif.id);
                        }}
                        style={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            background: 'rgba(255,255,255,0.1)',
                            border: 'none',
                            borderRadius: '50%',
                            width: 24,
                            height: 24,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            color: '#888'
                        }}
                    >
                        <X size={14} />
                    </button>
                    
                    {/* Indicador de nuevo */}
                    <div style={{
                        position: 'absolute',
                        top: -6,
                        left: 16,
                        background: 'linear-gradient(145deg, #00d26a 0%, #00a854 100%)',
                        color: '#fff',
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '3px 10px',
                        borderRadius: 10,
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        boxShadow: '0 2px 8px rgba(0, 210, 106, 0.5)'
                    }}>
                        Nuevo mensaje
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 8 }}>
                        {/* Avatar */}
                        <Avatar 
                            size={48}
                            style={{
                                background: 'linear-gradient(145deg, #00d26a 0%, #00a854 100%)',
                                border: '2px solid rgba(255,255,255,0.2)',
                                flexShrink: 0,
                                fontSize: 20,
                                fontWeight: 700
                            }}
                        >
                            {notif.senderName.charAt(0).toUpperCase()}
                        </Avatar>
                        
                        <div style={{ flex: 1, overflow: 'hidden' }}>
                            {/* Sucursal */}
                            <div style={{
                                fontSize: 11,
                                color: '#00d26a',
                                fontWeight: 600,
                                marginBottom: 2
                            }}>
                                📱 {notif.branchName}
                            </div>
                            
                            {/* Nombre del remitente */}
                            <div style={{
                                fontSize: 15,
                                fontWeight: 700,
                                color: '#fff',
                                marginBottom: 4,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                            }}>
                                {notif.senderName}
                            </div>
                            
                            {/* Preview del mensaje */}
                            <div style={{
                                fontSize: 13,
                                color: 'rgba(255,255,255,0.8)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6
                            }}>
                                {getMessageIcon(notif.messageType)}
                                <span>{getMessagePreview(notif)}</span>
                            </div>
                            
                            {/* Hora */}
                            <div style={{
                                fontSize: 10,
                                color: 'rgba(255,255,255,0.5)',
                                marginTop: 4
                            }}>
                                {new Date(notif.timestamp).toLocaleTimeString('es', { 
                                    hour: '2-digit', 
                                    minute: '2-digit' 
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            ))}
            
            {/* Botón limpiar todo si hay más de 1 */}
            {notifs.length > 1 && (
                <div 
                    style={{
                        gridColumn: notifs.length > 1 ? '1 / -1' : '1',
                        textAlign: 'center',
                        marginTop: 4
                    }}
                >
                    <button
                        onClick={clearAllVisualNotifications}
                        style={{
                            background: 'rgba(255,255,255,0.1)',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: 20,
                            padding: '6px 16px',
                            color: '#fff',
                            fontSize: 12,
                            cursor: 'pointer'
                        }}
                    >
                        Cerrar todas ({notifs.length})
                    </button>
                </div>
            )}
        </div>
    );
};
