import React, { useState, useEffect, useRef } from 'react';
import { Card, Badge, Avatar, List, Typography, Button, Spin } from 'antd';
import { MessageSquare, Maximize2 } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { apiFetch, assetUrl } from '../lib/runtime';
import { upsertBranchChats } from '../services/branchChatDirectory.service';

const { Text } = Typography;

// Inyectar estilos de animación RETRO para las tarjetas de dispositivos
const injectBranchCardStyles = () => {
    const styleId = 'branch-card-animations-retro';
    if (document.getElementById(styleId)) return;
    
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        /* === TEMA RETRO - Animaciones de BranchCard === */
        
        /* Animación de zumbido vintage */
        @keyframes branchCardBuzz {
            0%, 100% { transform: translateY(-8px) rotate(-0.5deg); }
            10% { transform: translateY(-8px) translateX(-4px) rotate(-1.5deg); }
            20% { transform: translateY(-8px) translateX(4px) rotate(0.5deg); }
            30% { transform: translateY(-8px) translateX(-4px) rotate(-1deg); }
            40% { transform: translateY(-8px) translateX(4px) rotate(1deg); }
            50% { transform: translateY(-8px) translateX(-2px) rotate(-0.5deg); }
            60% { transform: translateY(-8px) translateX(2px) rotate(0.5deg); }
            70% { transform: translateY(-8px) translateX(-1px); }
            80% { transform: translateY(-8px) translateX(1px); }
            90% { transform: translateY(-8px) rotate(-0.5deg); }
        }
        
        /* Pulso dorado vintage */
        @keyframes branchCardPulse {
            0%, 100% { box-shadow: 0 8px 32px rgba(201, 162, 39, 0.25); }
            50% { box-shadow: 0 12px 40px rgba(201, 162, 39, 0.5), 0 0 30px rgba(232, 197, 71, 0.3); }
        }
        
        /* Brillo dorado deslizante */
        @keyframes goldShine {
            0% { left: -100%; }
            50% { left: 100%; }
            100% { left: 100%; }
        }
        
        /* Pulso verde "en vivo" */
        @keyframes livePulse {
            0%, 100% { 
                transform: scale(1);
                box-shadow: 0 0 12px rgba(0, 210, 106, 0.6), 0 0 0 3px rgba(0, 210, 106, 0.25);
            }
            50% { 
                transform: scale(1.15);
                box-shadow: 0 0 20px rgba(0, 210, 106, 0.8), 0 0 0 6px rgba(0, 210, 106, 0.15);
            }
        }
        
        /* Clase base retro para hover */
        .branch-card-animated {
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
            position: relative !important;
            overflow: hidden !important;
        }
        
        .branch-card-animated::before {
            content: '' !important;
            position: absolute !important;
            inset: 0 !important;
            background: 
                repeating-linear-gradient(
                    0deg,
                    transparent,
                    transparent 2px,
                    rgba(0, 0, 0, 0.02) 2px,
                    rgba(0, 0, 0, 0.02) 4px
                ) !important;
            pointer-events: none !important;
            z-index: 1 !important;
        }
        
        .branch-card-animated:hover {
            transform: translateY(-8px) rotate(-0.5deg) !important;
            box-shadow: 
                0 16px 48px rgba(0, 0, 0, 0.5),
                0 0 30px rgba(201, 162, 39, 0.2) !important;
            border-color: rgba(201, 162, 39, 0.6) !important;
        }
        
        /* Clase para notificación activa - estilo vintage */
        .branch-card-notified {
            animation: branchCardBuzz 0.6s ease-in-out, branchCardPulse 1.5s ease-in-out !important;
            border-color: #c9a227 !important;
            box-shadow: 
                0 12px 40px rgba(201, 162, 39, 0.4),
                0 0 20px rgba(232, 197, 71, 0.2) !important;
        }
        
        .branch-card-notified::after {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 50%;
            height: 100%;
            background: linear-gradient(
                90deg,
                transparent,
                rgba(201, 162, 39, 0.2),
                transparent
            );
            animation: goldShine 1s ease-in-out;
            pointer-events: none;
            z-index: 2;
        }
    `;
    document.head.appendChild(style);
};

interface Device {
    id: string;
    name: string;
    status: string;
    phoneNumber?: string | null;
    number?: string | null;
}

interface Chat {
    id: string;
    name: string;
    lastMessageTime: number;
    unreadCount: number;
    isGroup: boolean;
    profilePhotoUrl?: string | null;
    lastMessage?: string | null;
    lastMessageType?: string;
    lastMessageFromMe?: boolean;
    lastMessageMedia?: { mimeType?: string; duration?: number } | null;
}

interface BranchCardProps {
    device: Device;
    onOpenFull: () => void;
    onRename?: (name: string) => void;
    headerActions?: React.ReactNode;
    onPin?: () => void;
    isPinned?: boolean;
    dragHandle?: React.ReactNode;
}

export const BranchCard: React.FC<BranchCardProps> = ({ device, onOpenFull, onRename, headerActions, onPin, isPinned, dragHandle }) => {
    const socket = useSocket();
    const [chats, setChats] = useState<Chat[]>([]);
    const [totalUnread, setTotalUnread] = useState(0);
    const [isNotified, setIsNotified] = useState(false);
    const chatsRef = useRef<Chat[]>([]);
    
    // Inyectar estilos de animación
    useEffect(() => {
        injectBranchCardStyles();
    }, []);
    
    useEffect(() => {
        chatsRef.current = chats;
    }, [chats]);

    // Función para normalizar IDs de chat y evitar duplicados
    // CRÍTICO: Debe estar definida ANTES de usarse en fetchChats
    const normalizeChatId = (id: string): string => {
        if (!id) return '';
        // Grupos tienen ID único
        if (id.includes('@g.us')) return id;
        // Extraer el número base sin sufijos de WhatsApp
        const base = id.split('@')[0] || id;
        // Remover prefijos de LID si existen (formato: numero:0@lid)
        const clean = base.split(':')[0] || base;
        return clean;
    };

    // Cargar chats
    useEffect(() => {
        const fetchChats = async () => {
            if (device.status !== 'CONNECTED') return;
            try {
                const res = await apiFetch(`/api/devices/${device.id}/chats`);
                const text = await res.text();
                const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
                if (!res.ok) {
                    setChats([]);
                    setTotalUnread(0);
                    return;
                }
                if (Array.isArray(data)) {
                    // ========== DEDUPLICACIÓN POR ID (ÚNICO PASO) ==========
                    // El servidor puede devolver el mismo contacto con diferentes IDs
                    // (ej: 123456@s.whatsapp.net y 123456:0@lid)
                    // IMPORTANTE: El backend ya hace la deduplicación, pero duplicamos aquí por seguridad
                    const seenKeys = new Map<string, Chat>();
                    
                    for (const chat of data as Chat[]) {
                        const key = normalizeChatId(chat.id);
                        const existing = seenKeys.get(key);
                        
                        if (existing) {
                            // Elegir el más reciente como base
                            const winner = chat.lastMessageTime > existing.lastMessageTime ? chat : existing;
                            const loser = chat.lastMessageTime > existing.lastMessageTime ? existing : chat;
                            
                            // Preservar el mejor nombre
                            const winnerHasRealName = winner.name && !/^\d+$/.test(winner.name);
                            const loserHasRealName = loser.name && !/^\d+$/.test(loser.name);
                            
                            let merged = { ...winner };
                            if (loserHasRealName && !winnerHasRealName) {
                                merged.name = loser.name;
                            }
                            
                            seenKeys.set(key, merged);
                        } else {
                            seenKeys.set(key, chat);
                        }
                    }
                    
                    // Convertir Map a array y ordenar por tiempo
                    const deduplicated = Array.from(seenKeys.values())
                        .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
                    
                    console.log(`[BranchCard ${device.id}] Chats: ${data.length} -> ${deduplicated.length} después de deduplicar`);
                    
                    upsertBranchChats(device.id, deduplicated);
                    setChats(deduplicated.slice(0, 5)); // Solo los 5 más recientes
                    setTotalUnread(deduplicated.reduce((sum: number, c: Chat) => sum + (c.unreadCount || 0), 0));
                }
            } catch (error) {
                console.error('Error:', error);
            }
        };
        
        fetchChats();
        const interval = setInterval(fetchChats, 10000);
        return () => clearInterval(interval);
    }, [device.id, device.status]);
    
    // Socket para mensajes nuevos
    useEffect(() => {
        if (!socket) return;
        
        const handleNewMessage = (data: any) => {
            if (data.deviceId !== device.id) return;
            
            const msg = data.msg || {};
            const chatId = data.chatId || '';
            const normalizedIncoming = normalizeChatId(chatId);
            
            // Incrementar contador solo si no es mensaje propio
            if (!msg.fromMe) {
                setTotalUnread(prev => prev + 1);
                
                // Activar animación de notificación
                setIsNotified(true);
                setTimeout(() => setIsNotified(false), 1500);
            }
            
            // Actualizar la lista de chats con el nuevo mensaje
            setChats(prevChats => {
                // Buscar chat existente usando ID normalizado para evitar duplicados
                const existingIndex = prevChats.findIndex(c => 
                    normalizeChatId(c.id) === normalizedIncoming
                );
                
                // Preservar el nombre existente si lo hay, sino usar senderName
                const existingChat = existingIndex >= 0 ? prevChats[existingIndex] : null;
                const senderName = msg.senderName || chatId.split('@')[0] || 'Desconocido';
                
                const updatedChat: Chat = {
                    id: existingChat?.id || chatId, // Mantener el ID original del chat existente
                    name: existingChat?.name || senderName, // Preservar nombre existente
                    lastMessageTime: msg.timestamp || Date.now(),
                    unreadCount: existingChat 
                        ? (msg.fromMe ? existingChat.unreadCount : existingChat.unreadCount + 1)
                        : (msg.fromMe ? 0 : 1),
                    isGroup: chatId.includes('@g.us'),
                    profilePhotoUrl: existingChat?.profilePhotoUrl || null,
                    lastMessage: msg.text || null,
                    lastMessageType: msg.type || 'text',
                    lastMessageFromMe: msg.fromMe || false,
                    lastMessageMedia: msg.media || null
                };
                
                // Si existe, actualizar y mover al principio
                if (existingIndex >= 0) {
                    const newChats = prevChats.filter((_, i) => i !== existingIndex);
                    return [updatedChat, ...newChats].slice(0, 5);
                }
                
                // Si no existe, agregar al principio
                return [updatedChat, ...prevChats].slice(0, 5);
            });
        };

        const handleUnreadUpdate = (data: any) => {
            if (data.deviceId !== device.id) return;
            if (typeof data.totalUnread === 'number') {
                setTotalUnread(data.totalUnread);
            }
        };
        
        socket.on('message:new', handleNewMessage);
        socket.on('device:unread:update', handleUnreadUpdate);
        return () => { 
            socket.off('message:new', handleNewMessage); 
            socket.off('device:unread:update', handleUnreadUpdate);
        };
    }, [socket, device.id]);

    const isConnected = device.status === 'CONNECTED';
    const isReconnecting = device.status === 'RECONNECTING';
    const nameEditable = onRename
        ? {
            onChange: (value: string) => onRename(value),
            triggerType: ['icon'] as ('text' | 'icon')[],
            tooltip: 'Editar nombre',
            maxLength: 60
        }
        : false;

    return (
        <Card
            hoverable
            onClick={onOpenFull}
            className={`branch-card-animated ${isNotified ? 'branch-card-notified' : ''}`}
            style={{
                background: 'linear-gradient(145deg, #2f261d 0%, #1a1410 100%)',
                borderColor: isNotified ? '#c9a227' : (isConnected ? 'rgba(201, 162, 39, 0.5)' : 'rgba(74, 61, 46, 0.6)'),
                borderWidth: isConnected ? 2 : 1,
                cursor: 'pointer',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                overflow: 'hidden',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(245, 230, 200, 0.03)'
            }}
            styles={{ body: { padding: 0, flex: 1, display: 'flex', flexDirection: 'column' } }}
        >
            {/* Header Vintage */}
            <div style={{
                padding: '12px 14px',
                background: isConnected 
                    ? 'linear-gradient(145deg, #4a7c59 0%, #2d4a35 100%)' 
                    : isReconnecting 
                        ? 'linear-gradient(145deg, #3d5a45 0%, #2a3d30 100%)' 
                        : 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)',
                borderBottom: '2px solid',
                borderImage: 'linear-gradient(90deg, transparent, rgba(201, 162, 39, 0.4), transparent) 1',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {isReconnecting ? (
                        <Spin size="small" />
                    ) : (
                        <div style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            background: isConnected 
                                ? 'linear-gradient(145deg, #00d26a 0%, #00a854 100%)'
                                : '#5a4d3d',
                            boxShadow: isConnected 
                                ? '0 0 12px rgba(0, 210, 106, 0.6), 0 0 0 3px rgba(0, 210, 106, 0.25)'
                                : 'inset 0 1px 2px rgba(0, 0, 0, 0.3)',
                            animation: isConnected ? 'livePulse 1.5s ease-in-out infinite' : 'none'
                        }} />
                    )}
                    <div>
                        <div onClick={(e) => e.stopPropagation()}>
                            <Text 
                                strong 
                                style={{ 
                                    color: '#f5e6c8', 
                                    fontSize: 14,
                                    fontFamily: "'Playfair Display', Georgia, serif",
                                    letterSpacing: '0.3px',
                                    textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)'
                                }} 
                                editable={nameEditable}
                            >
                                {device.name}
                            </Text>
                        </div>
                        <div style={{ 
                            fontSize: 10, 
                            color: 'rgba(245, 230, 200, 0.7)',
                            fontFamily: "'Source Serif Pro', Georgia, serif",
                            fontStyle: 'italic',
                            letterSpacing: '0.5px'
                        }}>
                            {isConnected 
                                ? (device.phoneNumber || device.number || '• Conectado')
                                : isReconnecting
                                    ? '• Reconectando...'
                                    : device.status === 'QR_READY' ? '• Escanear QR' : '• Sin vincular'
                            }
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {dragHandle}
                    {onPin && (
                        <Button
                            type="text"
                            size="small"
                            onClick={(e) => {
                                e.stopPropagation();
                                onPin();
                            }}
                            icon={
                                <div style={{ 
                                    transform: isPinned ? 'rotate(45deg)' : 'rotate(0deg)', 
                                    transition: 'transform 0.2s',
                                    color: isPinned ? '#c9a227' : '#8b7b65',
                                    textShadow: isPinned ? '0 0 8px rgba(201, 162, 39, 0.5)' : 'none'
                                }}>
                                    📌
                                </div>
                            }
                            style={{ padding: 0, minWidth: 24 }}
                            title={isPinned ? "Desfijar" : "Fijar al inicio"}
                        />
                    )}
                    {isConnected && totalUnread > 0 && (
                        <Badge
                            count={totalUnread}
                            size="small"
                            style={{ 
                                background: 'linear-gradient(145deg, #cd7f32 0%, #b87333 100%)',
                                boxShadow: '0 2px 8px rgba(205, 127, 50, 0.4)',
                                fontFamily: "'Source Serif Pro', Georgia, serif",
                                fontWeight: 600
                            }}
                        />
                    )}
                    <div onClick={(e) => e.stopPropagation()}>{headerActions}</div>
                </div>
            </div>

            {/* Chats Preview - Estilo Vintage */}
            <div style={{ flex: 1, overflow: 'hidden', background: 'rgba(26, 20, 16, 0.4)' }}>
                {!isConnected ? (
                    <div style={{ 
                        height: '100%', 
                        display: 'flex', 
                        flexDirection: 'column',
                        alignItems: 'center', 
                        justifyContent: 'center',
                        color: isReconnecting ? '#c9a227' : '#8b7b65',
                        fontSize: 12,
                        padding: 20,
                        textAlign: 'center',
                        gap: 8,
                        fontFamily: "'Crimson Text', Georgia, serif",
                        fontStyle: 'italic'
                    }}>
                        {isReconnecting ? (
                            <>
                                <Spin />
                                <span>Reconectando sesión...</span>
                            </>
                        ) : device.status === 'QR_READY' 
                            ? 'Haz clic para escanear QR'
                            : 'Haz clic para conectar'
                        }
                    </div>
                ) : chats.length === 0 ? (
                    <div style={{ 
                        height: '100%', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        color: '#8b7b65',
                        fontSize: 12,
                        fontFamily: "'Crimson Text', Georgia, serif",
                        fontStyle: 'italic'
                    }}>
                        Sin chats recientes
                    </div>
                ) : (
                    <List
                        size="small"
                        dataSource={chats}
                        renderItem={chat => (
                            <List.Item style={{ 
                                padding: '8px 12px', 
                                borderBottom: '1px solid rgba(74, 61, 46, 0.4)',
                                background: 'transparent',
                                transition: 'background 0.2s ease'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
                                    <Avatar 
                                        size="small" 
                                        shape="circle" 
                                        src={chat.profilePhotoUrl ? assetUrl(chat.profilePhotoUrl) : undefined} 
                                        style={{ 
                                            backgroundColor: chat.isGroup ? '#4a7c59' : '#5a4d3d',
                                            border: '2px solid rgba(201, 162, 39, 0.3)',
                                            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                                            flexShrink: 0,
                                            fontFamily: "'Playfair Display', Georgia, serif",
                                            fontWeight: 700
                                        }}
                                    >
                                        {chat.name.substring(0, 1).toUpperCase()}
                                    </Avatar>
                                    <div style={{ flex: 1, overflow: 'hidden' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                            <div style={{ 
                                                fontSize: 12, 
                                                color: '#f5e6c8',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                fontFamily: "'Crimson Text', Georgia, serif",
                                                fontWeight: 600,
                                                flex: 1
                                            }}>
                                                {chat.name}
                                            </div>
                                            <div style={{ 
                                                fontSize: 9, 
                                                color: '#8b7b65',
                                                fontFamily: "'Source Serif Pro', Georgia, serif",
                                                fontStyle: 'italic',
                                                flexShrink: 0
                                            }}>
                                                {new Date(chat.lastMessageTime).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </div>
                                        <div style={{ 
                                            fontSize: 10, 
                                            color: '#9a8b7a',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            marginTop: 2,
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 4
                                        }}>
                                            {chat.lastMessageFromMe && <span style={{ color: '#00d26a' }}>✓</span>}
                                            {(() => {
                                                const type = chat.lastMessageType || 'text';
                                                const media = chat.lastMessageMedia;
                                                
                                                // Audio
                                                if (type === 'audio' || media?.mimeType?.startsWith('audio/')) {
                                                    const duration = media?.duration;
                                                    const formatDuration = (s: number) => {
                                                        const m = Math.floor(s / 60);
                                                        const sec = Math.floor(s % 60);
                                                        return `${m}:${sec.toString().padStart(2, '0')}`;
                                                    };
                                                    return (
                                                        <span>🎤 {duration ? formatDuration(duration) : 'Audio'}</span>
                                                    );
                                                }
                                                // Imagen
                                                if (type === 'image' || media?.mimeType?.startsWith('image/')) {
                                                    return <span>📷 Imagen</span>;
                                                }
                                                // Video
                                                if (type === 'video' || media?.mimeType?.startsWith('video/')) {
                                                    return <span>🎥 Video</span>;
                                                }
                                                // Documento
                                                if (type === 'document') {
                                                    return <span>📄 Documento</span>;
                                                }
                                                // Sticker
                                                if (type === 'sticker') {
                                                    return <span>🎭 Sticker</span>;
                                                }
                                                // Ubicación
                                                if (type === 'location') {
                                                    return <span>📍 Ubicación</span>;
                                                }
                                                // Contacto
                                                if (type === 'contact') {
                                                    return <span>👤 Contacto</span>;
                                                }
                                                // Texto
                                                if (chat.lastMessage) {
                                                    return <span>{chat.lastMessage}</span>;
                                                }
                                                return <span style={{ opacity: 0.5 }}>Sin mensajes</span>;
                                            })()}
                                        </div>
                                    </div>
                                </div>
                            </List.Item>
                        )}
                    />
                )}
            </div>

            {/* Footer Vintage */}
            <div style={{
                padding: '10px 12px',
                background: 'linear-gradient(180deg, rgba(47, 38, 29, 0.8) 0%, rgba(42, 34, 24, 0.9) 100%)',
                borderTop: '1px solid rgba(201, 162, 39, 0.2)',
                display: 'flex',
                justifyContent: 'center'
            }}>
                <Button 
                    type="text" 
                    size="small"
                    icon={<Maximize2 size={14} />}
                    style={{ 
                        color: '#c9a227', 
                        fontSize: 11,
                        fontFamily: "'Source Serif Pro', Georgia, serif",
                        fontWeight: 600,
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase'
                    }}
                >
                    Abrir completo
                </Button>
            </div>
        </Card>
    );
};
