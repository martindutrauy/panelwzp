import React, { useState, useEffect, useRef } from 'react';
import { Layout, List, Input, Avatar, Space, Button, Badge, Typography, Tooltip, Modal, Spin, Empty, Popconfirm, message, Radio, Divider, notification, Dropdown, Popover } from 'antd';
import { Reply, Copy } from 'lucide-react';
import { Search, Send, Paperclip, Mic, CheckCheck, X, Trash2, Settings, Play, PhoneCall, Image, Video, FileText, Camera, Sticker, Smile, Edit2 } from 'lucide-react';

// Emojis más usados en WhatsApp organizados por categoría
const EMOJI_CATEGORIES = {
    'Caritas': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐'],
    'Gestos': ['😤', '😠', '😡', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🙈', '🙉', '🙊'],
    'Manos': ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪'],
    'Corazones': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️'],
    'Celebración': ['🎉', '🎊', '🎈', '🎁', '🎀', '🎂', '🍰', '🧁', '🥂', '🍾', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🎗️', '🎄', '🎃', '🎆', '🎇', '✨', '🎵', '🎶', '🎤', '🎧'],
    'Objetos': ['📱', '💻', '⌨️', '🖥️', '📷', '📹', '🎥', '📞', '☎️', '📺', '📻', '⏰', '⌚', '💰', '💵', '💴', '💶', '💷', '💳', '🔑', '🗝️', '🔒', '🔓', '📦', '📫', '📬', '📭', '📮', '✉️', '📧'],
    'Símbolos': ['✅', '❌', '⭕', '❗', '❓', '‼️', '⁉️', '💯', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '▶️', '⏸️', '⏹️', '⏺️', '⏭️', '⏮️', '🔀', '🔁', '🔂', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '🔃', '🔄']
};
import QRCode from 'react-qr-code';
import { useSocket } from '../hooks/useSocket';
import { apiFetch, assetUrl } from '../lib/runtime';
import { PairingCodeModal } from './PairingCodeModal';
import { BranchNotificationsModal } from './BranchNotificationsModal';
import { setActiveBranchId, setActiveChatId, setChatOpen } from '../services/notificationFocus.service';
import { upsertBranchChats } from '../services/branchChatDirectory.service';

const { Sider, Content } = Layout;
const { Text } = Typography;

interface Device {
    id: string;
    name: string;
    status: 'CONNECTED' | 'DISCONNECTED' | 'QR_READY' | 'CONNECTING' | string;
    qr?: string | null;
    phoneNumber?: string | null;
    number?: string | null;
}

interface MediaMetadata {
    id: string;
    fileName: string;
    mimeType: string;
    url: string;
    size: number;
    timestamp: number;
}

interface Message {
    id: string;
    text: string | null;
    fromMe: boolean;
    timestamp: number;
    source: 'panel' | 'whatsapp' | 'phone' | 'contact';
    media?: MediaMetadata | null;
    location?: { latitude: number; longitude: number; name?: string | null; address?: string | null } | null;
    senderName?: string | null;  // Nombre del contacto de WhatsApp (pushName)
    quotedMessage?: {            // Mensaje citado (reply)
        id: string;
        text: string | null;
        senderName?: string | null;
    } | null;
}

interface Chat {
    id: string;
    name: string;
    originalName?: string | null;  // Nombre original de WhatsApp (pushName)
    customName?: string | null;    // Nombre personalizado por el usuario (como agenda)
    lastMessageTime: number;
    unreadCount: number;
    isGroup: boolean;
    profilePhotoUrl?: string | null;
    lastMessage?: string | null;
    lastMessageType?: string;
    lastMessageFromMe?: boolean;
    lastMessageMedia?: { mimeType?: string; duration?: number } | null;
}

interface SearchResult {
    id: string;
    chatId: string;
    chatName: string;
    text: string;
    fromMe: boolean;
    timestamp: number;
    matchHighlight: string;
}

export const ChatInterface = ({
    device,
    onClose
}: {
    device: Device;
    onClose?: () => void;
}) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [notificationApi, notificationContextHolder] = notification.useNotification();
    const socket = useSocket();
    const [currentDevice, setCurrentDevice] = useState<Device>(device);
    const [chats, setChats] = useState<Chat[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const chatsRef = useRef<Chat[]>([]);
    const [inputText, setInputText] = useState('');
    const [loading, setLoading] = useState(false);
    const [uploadingFile, setUploadingFile] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [presence, setPresence] = useState<string | null>(null);
    const [activeChat, setActiveChat] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [showSearchModal, setShowSearchModal] = useState(false);
    const [pendingScrollMsgId, setPendingScrollMsgId] = useState<string | null>(null);
    const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
    const [templates, setTemplates] = useState<{id: string, shortcut: string, content: string}[]>([]);
    const [showPairingModal, setShowPairingModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');
    const [changingPassword, setChangingPassword] = useState(false);
    const [selectedTone, setSelectedTone] = useState<number>(() => {
        const saved = localStorage.getItem('notificationTone');
        return saved ? parseInt(saved, 10) : 1;
    });

    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const notificationAudioCtxRef = useRef<AudioContext | null>(null);
    const lastNotificationSoundKeyRef = useRef<string>('');
    
    // Estado para trackear chats con notificación activa (para animación de zumbido)
    const [notifiedChats, setNotifiedChats] = useState<Set<string>>(new Set());
    
    // Estado para responder mensajes (reply/quote)
    const [replyingTo, setReplyingTo] = useState<Message | null>(null);
    
    // Estado para el selector de emojis
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [activeEmojiCategory, setActiveEmojiCategory] = useState<string>('Caritas');
    
    // Estado para editar nombre de contacto
    const [editingContactName, setEditingContactName] = useState(false);
    const [newContactName, setNewContactName] = useState('');
    
    // Cancelar respuesta
    const cancelReply = () => setReplyingTo(null);
    
    // Insertar emoji en el texto
    const insertEmoji = (emoji: string) => {
        setInputText(prev => prev + emoji);
    };
    
    // Guardar nombre personalizado del contacto
    const saveContactName = async () => {
        if (!activeChat) return;
        
        try {
            const encodedChatId = encodeURIComponent(activeChat);
            const res = await apiFetch(`/api/devices/${device.id}/chats/${encodedChatId}/rename`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customName: newContactName.trim() || null })
            });
            
            const result = await res.json();
            if (result.success) {
                // Actualizar el chat en la lista local
                setChats(prev => prev.map(c => 
                    c.id === activeChat 
                        ? { ...c, name: newContactName.trim() || c.originalName || c.id.split('@')[0], customName: newContactName.trim() || null }
                        : c
                ));
                messageApi.success('Nombre guardado');
                setEditingContactName(false);
            } else {
                messageApi.error(result.error || 'Error al guardar');
            }
        } catch (err: any) {
            messageApi.error('Error: ' + (err.message || 'Desconocido'));
        }
    };

    // Inyectar estilos de animación RETRO para las tarjetas de chat
    useEffect(() => {
        const styleId = 'chat-card-animations-retro';
        if (document.getElementById(styleId)) return;
        
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            /* === TEMA RETRO - Animaciones de Chat === */
            
            /* Animación de zumbido vintage */
            @keyframes chatBuzz {
                0%, 100% { transform: translateX(0); }
                10% { transform: translateX(-3px) rotate(-0.5deg); }
                20% { transform: translateX(3px) rotate(0.5deg); }
                30% { transform: translateX(-3px) rotate(-0.5deg); }
                40% { transform: translateX(3px) rotate(0.5deg); }
                50% { transform: translateX(-2px); }
                60% { transform: translateX(2px); }
                70% { transform: translateX(-1px); }
                80% { transform: translateX(1px); }
                90% { transform: translateX(0); }
            }
            
            /* Pulso dorado vintage */
            @keyframes chatPulse {
                0% { background: linear-gradient(90deg, #2f261d 0%, #1a1410 50%, #2f261d 100%); }
                25% { background: linear-gradient(90deg, rgba(201, 162, 39, 0.2) 0%, #2f261d 50%, rgba(201, 162, 39, 0.2) 100%); }
                50% { background: linear-gradient(90deg, #2f261d 0%, rgba(201, 162, 39, 0.3) 50%, #2f261d 100%); }
                75% { background: linear-gradient(90deg, rgba(201, 162, 39, 0.2) 0%, #2f261d 50%, rgba(201, 162, 39, 0.2) 100%); }
                100% { background: linear-gradient(90deg, #2f261d 0%, #1a1410 50%, #2f261d 100%); }
            }
            
            /* Clase para chat con notificación - estilo retro */
            .chat-item-notified {
                animation: chatBuzz 0.6s ease-in-out, chatPulse 1.5s ease-in-out;
                box-shadow: 0 0 20px rgba(201, 162, 39, 0.3), inset 0 0 15px rgba(201, 162, 39, 0.05);
                border-left: 3px solid #c9a227 !important;
            }
            
            /* Hover retro para tarjetas de chat */
            .chat-item-card {
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
                font-family: 'Crimson Text', Georgia, serif;
            }
            
            .chat-item-card::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: linear-gradient(90deg, transparent, rgba(201, 162, 39, 0.08), transparent);
                transition: left 0.5s ease;
            }
            
            .chat-item-card:hover::before {
                left: 100%;
            }
            
            .chat-item-card:hover {
                background: linear-gradient(90deg, rgba(47, 38, 29, 0.8) 0%, rgba(42, 34, 24, 0.9) 100%) !important;
                transform: scale(1.01);
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            }
            
            .chat-item-card:active {
                transform: scale(0.99);
            }
            
            /* Avatar hover efecto retro */
            .chat-item-card:hover .ant-avatar {
                transform: scale(1.08);
                transition: transform 0.2s ease;
                box-shadow: 0 0 10px rgba(201, 162, 39, 0.3);
            }
        `;
        document.head.appendChild(style);
        
        return () => {
            const existing = document.getElementById(styleId);
            if (existing) existing.remove();
        };
    }, []);

    useEffect(() => {
        chatsRef.current = chats;
    }, [chats]);

    const getChatKey = (chatId: string | null | undefined) => {
        if (!chatId) return '';
        if (chatId.includes('@g.us')) return chatId;
        const prefix = chatId.split('@')[0] || chatId;
        return prefix.split(':')[0] || prefix;
    };

    // Formatear duración de audio (segundos -> mm:ss)
    const formatAudioDuration = (seconds?: number) => {
        if (!seconds || !Number.isFinite(seconds)) return '';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    // Renderizar preview del último mensaje estilo WhatsApp
    const renderLastMessagePreview = (chat: Chat) => {
        const prefix = chat.lastMessageFromMe ? (
            <CheckCheck size={14} color="#53bdeb" style={{ marginRight: 4, flexShrink: 0 }} />
        ) : null;

        // Si es un grupo, mostrar ícono de grupo
        if (chat.isGroup && !chat.lastMessage && !chat.lastMessageMedia && !chat.lastMessageType) {
            return <span>👥 Grupo</span>;
        }

        // Verificar si es un sticker por el tipo de mensaje
        if (chat.lastMessageType === 'stickerMessage' || chat.lastMessage === 'Sticker') {
            return (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {prefix}
                    <span style={{ fontSize: 16 }}>🎭</span>
                    <span>Sticker</span>
                </span>
            );
        }

        // Si hay media
        if (chat.lastMessageMedia?.mimeType) {
            const mimeType = chat.lastMessageMedia.mimeType.toLowerCase();
            
            // Sticker (image/webp generalmente)
            if (mimeType === 'image/webp' && !chat.lastMessage) {
                return (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {prefix}
                        <span style={{ fontSize: 16 }}>🎭</span>
                        <span>Sticker</span>
                    </span>
                );
            }
            
            if (mimeType.startsWith('audio/')) {
                const duration = formatAudioDuration(chat.lastMessageMedia.duration);
                return (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {prefix}
                        <Mic size={14} color="#25D366" style={{ flexShrink: 0 }} />
                        <span style={{ color: '#25D366' }}>
                            {duration ? duration : 'Audio'}
                        </span>
                    </span>
                );
            }
            
            if (mimeType.startsWith('image/')) {
                return (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {prefix}
                        <Camera size={14} style={{ flexShrink: 0 }} />
                        <span>{chat.lastMessage || 'Foto'}</span>
                    </span>
                );
            }
            
            if (mimeType.startsWith('video/')) {
                return (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {prefix}
                        <Video size={14} style={{ flexShrink: 0 }} />
                        <span>{chat.lastMessage || 'Video'}</span>
                    </span>
                );
            }
            
            // Documento u otro tipo de archivo
            return (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {prefix}
                    <FileText size={14} style={{ flexShrink: 0 }} />
                    <span>{chat.lastMessage || 'Documento'}</span>
                </span>
            );
        }

        // Mensaje de texto normal
        if (chat.lastMessage) {
            // Verificar si es un sticker por el texto
            if (chat.lastMessage === 'Sticker') {
                return (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {prefix}
                        <span style={{ fontSize: 16 }}>🎭</span>
                        <span>Sticker</span>
                    </span>
                );
            }
            return (
                <span style={{ display: 'flex', alignItems: 'center' }}>
                    {prefix}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {chat.lastMessage}
                    </span>
                </span>
            );
        }

        // Sin mensaje - mostrar tipo de chat
        return <span style={{ fontStyle: 'italic' }}>{chat.isGroup ? '👥 Grupo' : 'Sin mensajes'}</span>;
    };

    useEffect(() => {
        const unlock = () => {
            try {
                if (!notificationAudioCtxRef.current) {
                    notificationAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                }
                if (notificationAudioCtxRef.current.state === 'suspended') {
                    notificationAudioCtxRef.current.resume().catch(() => {});
                }
            } catch {}
        };

        window.addEventListener('pointerdown', unlock, true);
        return () => window.removeEventListener('pointerdown', unlock, true);
    }, []);

    useEffect(() => {
        setChatOpen(true);
        return () => setChatOpen(false);
    }, []);

    useEffect(() => {
        setActiveBranchId(device.id);
    }, [device.id]);

    useEffect(() => {
        setActiveChatId(activeChat);
    }, [activeChat]);

    // Cargar plantillas para atajos
    useEffect(() => {
        const fetchTemplates = async () => {
            try {
                const res = await apiFetch('/api/templates');
                const data = await res.json();
                if (Array.isArray(data)) {
                    setTemplates(data.map((t: any) => ({ id: t.id, shortcut: t.shortcut, content: t.content })));
                }
            } catch (error) {
                console.error('Error al cargar plantillas:', error);
            }
        };
        fetchTemplates();
    }, []);

    // Cargar chats disponibles
    useEffect(() => {
        const fetchChats = async () => {
            try {
                console.log(`[fetchChats] Cargando chats para ${device.id}...`);
                const res = await apiFetch(`/api/devices/${device.id}/chats`);
                
                if (!res.ok) {
                    console.error(`[fetchChats] Error HTTP: ${res.status}`);
                    return; // No borrar chats existentes en caso de error
                }
                
                const text = await res.text();
                let data;
                try {
                    data = text ? JSON.parse(text) : [];
                } catch (parseError) {
                    console.error('[fetchChats] Error parseando JSON:', parseError);
                    return;
                }
                
                // Solo actualizar si es un array válido
                if (Array.isArray(data)) {
                    console.log(`[fetchChats] ${data.length} chats cargados`);
                    upsertBranchChats(device.id, data);
                    setChats(data);
                } else if (data?.error) {
                    console.error('[fetchChats] Error del servidor:', data.error);
                    // No borrar chats existentes
                } else {
                    console.log('[fetchChats] Respuesta no es un array:', data);
                    setChats([]);
                }
            } catch (error) {
                console.error('[fetchChats] Error de red:', error);
                // No borrar chats existentes en caso de error de red
            }
        };

        if (currentDevice.status === 'CONNECTED') {
            fetchChats();
            // Refrescar cada 10 segundos
            const interval = setInterval(fetchChats, 10000);
            return () => clearInterval(interval);
        } else {
            setChats([]);
        }
    }, [device.id, currentDevice.status]);

    // Cargar mensajes cuando se selecciona un chat
    useEffect(() => {
        if (!activeChat) return;
        void loadMessages(activeChat);
    }, [activeChat, device.id]);

    useEffect(() => {
        if (!pendingScrollMsgId) return;
        const id = pendingScrollMsgId;
        const el = document.getElementById(`msg-${id}`);
        if (!el) {
            if (messages.length > 0) {
                setPendingScrollMsgId(null);
                messageApi.info('Resultado encontrado, pero no está en los últimos mensajes cargados');
            }
            return;
        }
        try {
            el.scrollIntoView({ block: 'center' });
        } catch {}
        setPendingScrollMsgId(null);
        setHighlightMsgId(id);
        window.setTimeout(() => setHighlightMsgId((cur) => (cur === id ? null : cur)), 1500);
    }, [messages, pendingScrollMsgId]);

    // Sonido de notificación simple (beep suave)
    const playNotificationSound = (toneId: number = selectedTone) => {
        try {
            // Tono especial: Sapeee
            if (toneId === 11) {
                const audio = new Audio('https://www.myinstants.com/media/sounds/sape.mp3');
                audio.volume = 0.5;
                audio.play().catch(() => {});
                return;
            }

            if (!notificationAudioCtxRef.current) {
                notificationAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            const audioCtx = notificationAudioCtxRef.current;
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            if (audioCtx.state !== 'running') return;
            const now = audioCtx.currentTime;

            const createOsc = (type: OscillatorType, freq: number, start: number, dur: number, vol: number = 0.1) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = type;
                osc.frequency.setValueAtTime(freq, start);
                gain.gain.setValueAtTime(vol, start);
                gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(start);
                osc.stop(start + dur);
            };

            switch (toneId) {
                case 1: // Default Beep
                    createOsc('sine', 800, now, 0.15);
                    break;
                case 2: // Crystal
                    createOsc('sine', 1200, now, 0.5);
                    break;
                case 3: // Bubble
                    {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);
                        osc.frequency.setValueAtTime(400, now);
                        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
                        gain.gain.setValueAtTime(0.1, now);
                        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
                        osc.start(now);
                        osc.stop(now + 0.15);
                    }
                    break;
                case 4: // Notification
                    createOsc('sine', 600, now, 0.1);
                    createOsc('sine', 800, now + 0.1, 0.2);
                    break;
                case 5: // Success
                    createOsc('sine', 523.25, now, 0.3);
                    createOsc('sine', 659.25, now + 0.05, 0.3);
                    createOsc('sine', 783.99, now + 0.1, 0.4);
                    break;
                case 6: // Laser
                    {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        osc.type = 'sawtooth';
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);
                        osc.frequency.setValueAtTime(800, now);
                        osc.frequency.exponentialRampToValueAtTime(100, now + 0.2);
                        gain.gain.setValueAtTime(0.05, now);
                        gain.gain.linearRampToValueAtTime(0, now + 0.2);
                        osc.start(now);
                        osc.stop(now + 0.2);
                    }
                    break;
                case 7: // Coin
                    createOsc('square', 987.77, now, 0.08, 0.05);
                    createOsc('square', 1318.51, now + 0.08, 0.3, 0.05);
                    break;
                case 8: // Pluck
                    createOsc('triangle', 440, now, 0.3);
                    break;
                case 9: // Chime
                    createOsc('sine', 880, now, 1.5, 0.05);
                    createOsc('sine', 1100, now, 1.5, 0.03);
                    break;
                case 10: // Deep
                    createOsc('square', 150, now, 0.3, 0.05);
                    break;
                case 12: // Bird (Ave)
                    {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);
                        
                        // Primer pío
                        osc.frequency.setValueAtTime(2000, now);
                        osc.frequency.linearRampToValueAtTime(3000, now + 0.1);
                        gain.gain.setValueAtTime(0.1, now);
                        gain.gain.linearRampToValueAtTime(0, now + 0.1);
                        
                        // Segundo pío
                        const osc2 = audioCtx.createOscillator();
                        const gain2 = audioCtx.createGain();
                        osc2.connect(gain2);
                        gain2.connect(audioCtx.destination);
                        
                        osc2.frequency.setValueAtTime(2500, now + 0.15);
                        osc2.frequency.linearRampToValueAtTime(3500, now + 0.25);
                        gain2.gain.setValueAtTime(0.1, now + 0.15);
                        gain2.gain.linearRampToValueAtTime(0, now + 0.25);

                        osc.start(now);
                        osc.stop(now + 0.1);
                        osc2.start(now + 0.15);
                        osc2.stop(now + 0.25);
                    }
                    break;
                default:
                    createOsc('sine', 800, now, 0.15);
            }
        } catch (e) {
            console.error('Error playing sound:', e);
        }
    };

    // Anunciar llamada con voz (TTS)
    const announceCall = () => {
        if (!('speechSynthesis' in window)) return;

        // Cancelar cualquier speech anterior
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance("Llamada, atender en dispositivo");
        utterance.rate = 0.9; // Un poco más lento para formalidad
        utterance.pitch = 1.0;
        
        // Buscar voz femenina en español
        const voices = window.speechSynthesis.getVoices();
        // Preferencias: Google Español, Microsoft Helena/Sabina, o genérica femenina 'es'
        const femaleVoice = voices.find(v => 
            v.lang.includes('es') && 
            (v.name.includes('Google') || v.name.includes('Microsoft') || v.name.toLowerCase().includes('female'))
        );

        if (femaleVoice) {
            utterance.voice = femaleVoice;
        }

        window.speechSynthesis.speak(utterance);
    };

    useEffect(() => {
        if (!socket) return;

        // Cargar voces al inicio para asegurar que estén disponibles
        if ('speechSynthesis' in window) {
            window.speechSynthesis.getVoices();
        }

        socket.on('call:incoming', (data: { deviceId: string, from: string, isVideo: boolean }) => {
            if (data.deviceId === device.id) {
                console.log('Llamada entrante detectada:', data);
                
                // 1. Notificación Visual Persistente
                notificationApi.open({
                    message: 'Llamada Entrante',
                    description: (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <div style={{ fontWeight: 'bold', fontSize: 16 }}>
                                {data.from.split('@')[0]}
                            </div>
                            <div style={{ color: '#ff4d4f', display: 'flex', alignItems: 'center', gap: 5 }}>
                                <PhoneCall size={16} className="blink" />
                                <span>Atender en dispositivo físico</span>
                            </div>
                        </div>
                    ),
                    icon: <PhoneCall style={{ color: '#108ee9' }} />,
                    duration: 15, // Mantener visible 15 segundos
                    key: `call-${Date.now()}`,
                    style: { background: '#fff', border: '1px solid #1890ff' }
                });

                // 2. Anuncio de Voz
                announceCall();
            }
        });

        socket.on('message:new', (data: { deviceId: string, chatId: string, msg: Message }) => {
            if (data.deviceId === device.id) {
                console.log('Mensaje nuevo recibido:', data);

                const incomingKey = getChatKey(data.chatId);
                const activeKey = getChatKey(activeChat);
                const isSameChat = incomingKey && activeKey && incomingKey === activeKey;
                
                if (isSameChat) {
                    if (activeChat && data.chatId && data.chatId !== activeChat) {
                        setActiveChat(data.chatId);
                    }
                    setMessages(prev => {
                        const isDuplicate = prev.some(m => m.id === data.msg.id);
                        if (isDuplicate) return prev; // Evitar duplicados
                        return [...prev, data.msg];
                    });
                    if (scrollRef.current) {
                        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                    }
                }

                // Activar animación de zumbido si NO es el chat activo y NO es mensaje enviado por mí
                if (!isSameChat && !data.msg.fromMe) {
                    const chatIdToNotify = data.chatId;
                    setNotifiedChats(prev => new Set(prev).add(chatIdToNotify));
                    
                    // Remover la notificación después de que termine la animación (1.5s)
                    setTimeout(() => {
                        setNotifiedChats(prev => {
                            const newSet = new Set(prev);
                            newSet.delete(chatIdToNotify);
                            return newSet;
                        });
                    }, 1500);
                }

                // Actualizar lista de chats - unificar solo por clave segura (evita mezclar LIDs/grupos)
                setChats(prev => {
                    const incomingKey = getChatKey(data.chatId);
                    const existingChat = prev.find(c => getChatKey(c.id) === incomingKey);
                    if (existingChat) {
                        // Actualizar chat existente y moverlo al principio
                        return [
                            { ...existingChat, id: data.chatId, lastMessageTime: data.msg.timestamp },
                            ...prev.filter(c => getChatKey(c.id) !== incomingKey)
                        ];
                    } else {
                        // Agregar nuevo chat
                        const newChat: Chat = {
                            id: data.chatId,
                            name: data.chatId.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', ''),
                            lastMessageTime: data.msg.timestamp,
                            unreadCount: data.msg.fromMe ? 0 : 1,
                            isGroup: data.chatId.includes('@g.us')
                        };
                        return [newChat, ...prev];
                    }
                });
            }
        });

        socket.on('presence:update', (data: { deviceId: string, id: string, presences: any }) => {
            if (data.deviceId === device.id && data.id === activeChat) {
                const state = Object.values(data.presences)[0] as any;
                setPresence(state?.lastKnownPresence || null);
                setTimeout(() => setPresence(null), 3000);
            }
        });

        return () => {
            socket.off('message:new');
            socket.off('presence:update');
        };
    }, [socket, device.id, activeChat]);

    useEffect(() => {
        setCurrentDevice(device);
    }, [device]);

    useEffect(() => {
        if (!socket) return;

        const handler = (updated: Device) => {
            if (!updated?.id) return;
            if (updated.id !== device.id) return;
            setCurrentDevice(prev => ({ ...prev, ...updated }));
        };

        socket.on('device:update', handler);
        return () => {
            socket.off('device:update', handler);
        };
    }, [socket, device.id]);

    // Función de búsqueda de mensajes
    const handleSearch = async (query: string) => {
        setSearchQuery(query);

        // Debounce: esperar 500ms antes de buscar
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (!query.trim()) {
            setSearchResults([]);
            setShowSearchModal(false);
            return;
        }

        searchTimeoutRef.current = setTimeout(async () => {
            setIsSearching(true);
            setShowSearchModal(true);

            try {
                const params = new URLSearchParams();
                params.set('q', query);
                params.set('limit', '30');
                if (activeChat) params.set('chatId', activeChat);
                const res = await apiFetch(`/api/devices/${device.id}/messages/search?${params.toString()}`);
                const data = await res.json();

                if (Array.isArray(data)) {
                    setSearchResults(data);
                } else {
                    setSearchResults([]);
                }
            } catch (error) {
                console.error('Error al buscar mensajes:', error);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 500);
    };

    const goToSearchResult = (result: SearchResult) => {
        const targetChatId = result.chatId;
        setPendingScrollMsgId(result.id);
        setActiveChat(targetChatId);
        if (targetChatId === activeChat) {
            void loadMessages(targetChatId);
        }
        setShowSearchModal(false);
        setSearchQuery('');
        setSearchResults([]);
        // Los mensajes se cargarán automáticamente por el useEffect
    };

    const loadMessages = async (chatId: string) => {
        if (!chatId) return;
        try {
            const res = await apiFetch(`/api/devices/${device.id}/chats/${chatId}/messages`);
            const data = await res.json();
            console.log('[loadMessages] Mensajes cargados:', data.length, 'ejemplo:', data[0]);
            setMessages(Array.isArray(data) ? data : []);
            setTimeout(() => {
                if (scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
            }, 100);
        } catch (error) {
            console.error('Error al cargar mensajes:', error);
        }
    };

    const sendMessage = async () => {
        if (!inputText || !activeChat) {
            console.log('No se puede enviar: inputText=', inputText, 'activeChat=', activeChat);
            return;
        }

        console.log('Enviando mensaje a:', activeChat, 'texto:', inputText, replyingTo ? `(respondiendo a ${replyingTo.id})` : '');
        setLoading(true);

        try {
            const encodedChatId = encodeURIComponent(activeChat);
            const response = await apiFetch(`/api/devices/${device.id}/chats/${encodedChatId}/send-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    text: inputText,
                    quotedMessageId: replyingTo?.id || undefined
                })
            });

            const result = await response.json();
            console.log('Respuesta del servidor:', result);

            if (result.success) {
                // NO agregar mensaje localmente - el socket message:new lo hará
                // Esto evita duplicación
                setInputText('');
                // Limpiar respuesta después de enviar
                setReplyingTo(null);
            } else {
                console.error('Error del servidor:', result.error);
            }
        } catch (err) {
            console.error('Error al enviar mensaje:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !activeChat) return;

        setUploadingFile(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('caption', file.name);
            
            await apiFetch(`/api/devices/${device.id}/chats/${activeChat}/send-media`, {
                method: 'POST',
                body: formData
            });

            // Limpiar el input
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (err) {
            console.error('Error al enviar archivo:', err);
            alert('Error al enviar el archivo');
        } finally {
            setUploadingFile(false);
        }
    };

    const startRecording = async () => {
        if (!activeChat) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const preferredTypes = [
                'audio/ogg;codecs=opus',
                'audio/webm;codecs=opus',
                'audio/webm'
            ];
            const selectedType = preferredTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
            const mediaRecorder = selectedType
                ? new MediaRecorder(stream, { mimeType: selectedType })
                : new MediaRecorder(stream);

            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                const audioMime = selectedType || 'audio/webm';
                const audioBlob = new Blob(audioChunksRef.current, { type: audioMime });
                await sendAudio(audioBlob);

                // Detener el stream
                stream.getTracks().forEach(track => track.stop());

                // Limpiar
                audioChunksRef.current = [];
                setRecordingTime(0);
                if (recordingIntervalRef.current) {
                    clearInterval(recordingIntervalRef.current);
                    recordingIntervalRef.current = null;
                }
            };

            mediaRecorder.start();
            setIsRecording(true);

            // Contador de tiempo
            recordingIntervalRef.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);

        } catch (err) {
            console.error('Error al iniciar grabación:', err);
            alert('No se pudo acceder al micrófono. Por favor, permite el acceso.');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const cancelRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            audioChunksRef.current = [];
            setRecordingTime(0);
            if (recordingIntervalRef.current) {
                clearInterval(recordingIntervalRef.current);
                recordingIntervalRef.current = null;
            }
        }
    };

    const sendAudio = async (audioBlob: Blob) => {
        if (!activeChat) return;

        setUploadingFile(true);
        try {
            const formData = new FormData();
            const ext = audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
            formData.append('file', audioBlob, `audio-nota-voz.${ext}`);
            formData.append('caption', 'Nota de voz');
            formData.append('isVoiceNote', 'true');

            await apiFetch(`/api/devices/${device.id}/chats/${activeChat}/send-media`, {
                method: 'POST',
                body: formData
            });
        } catch (err) {
            console.error('Error al enviar audio:', err);
            alert('Error al enviar la nota de voz');
        } finally {
            setUploadingFile(false);
        }
    };

    // Limpiar al desmontar
    useEffect(() => {
        return () => {
            if (recordingIntervalRef.current) {
                clearInterval(recordingIntervalRef.current);
            }
        };
    }, []);

    const handleDeleteChat = async (chatId: string) => {
        try {
            const res = await apiFetch(`/api/devices/${device.id}/chats/${chatId}`, {
                method: 'DELETE'
            });
            if (!res.ok) throw new Error('Error al eliminar chat');
            
            setChats(prev => prev.filter(c => c.id !== chatId));
            if (activeChat === chatId) setActiveChat(null);
            messageApi.success('Chat eliminado');
        } catch (error) {
            console.error('Error eliminando chat:', error);
            messageApi.error('No se pudo eliminar el chat');
        }
    };

    const startLinking = async () => {
        setCurrentDevice(prev => ({ ...prev, status: 'CONNECTING' }));
        try {
            const res = await apiFetch(`/api/devices/${device.id}/start`, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Error al iniciar sesión');
            }
            setTimeout(async () => {
                try {
                    const devRes = await apiFetch('/api/devices');
                    const devs = await devRes.json();
                    const updated = Array.isArray(devs) ? devs.find((d: any) => d?.id === device.id) : null;
                    if (updated) setCurrentDevice(prev => ({ ...prev, ...updated }));
                } catch {}
            }, 600);
        } catch (error) {
            console.error('Error al iniciar sesión:', error);
            alert((error as any)?.message || 'Error al iniciar sesión');
        }
    };

    const regenerateQR = async () => {
        try {
            // Detener la sesión actual
            await apiFetch(`/api/devices/${device.id}/stop`, { method: 'POST' });
            // Esperar un momento y reiniciar
            setTimeout(async () => {
                await apiFetch(`/api/devices/${device.id}/start`, { method: 'POST' });
                // No recargar - el polling del modal actualiza automáticamente
                console.log('QR regenerado, esperando nuevo QR...');
            }, 500);
        } catch (error) {
            console.error('Error al regenerar QR:', error);
        }
    };

    const openPairingModal = () => {
        setShowPairingModal(true);
    };

    const submitPasswordChange = async () => {
        if (changingPassword) return;
        if (!currentPassword.trim()) {
            messageApi.error('Ingresá tu contraseña actual');
            return;
        }
        if (newPassword.trim().length < 4) {
            messageApi.error('La nueva contraseña debe tener al menos 4 caracteres');
            return;
        }
        if (newPassword !== confirmNewPassword) {
            messageApi.error('Las contraseñas no coinciden');
            return;
        }

        setChangingPassword(true);
        try {
            const res = await apiFetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al cambiar contraseña'));
            messageApi.success('Contraseña actualizada');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmNewPassword('');
            setShowSettingsModal(false);
        } catch (error: any) {
            messageApi.error(String(error?.message || 'Error al cambiar contraseña'));
        } finally {
            setChangingPassword(false);
        }
    };

    const settingsModalContent = (
        <BranchNotificationsModal
            open={showSettingsModal}
            branchId={device.id}
            branchName={device.name}
            onClose={() => setShowSettingsModal(false)}
        />
    );

    // Estado RECONNECTING - Auto-reconectando sesión guardada
    if (currentDevice.status === 'RECONNECTING') {
        return (
            <div style={{ padding: 40, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                <Spin size="large" />
                <h2 style={{ color: '#e9edef', marginTop: 20 }}>{currentDevice.name}</h2>
                <p style={{ color: '#25D366', fontSize: 16 }}>Reconectando sesión guardada...</p>
                <p style={{ color: '#8696a0', fontSize: 13 }}>Esto puede tomar unos segundos</p>
                {settingsModalContent}
            </div>
        );
    }

    if (currentDevice.status === 'DISCONNECTED' || currentDevice.status === 'CONNECTING' || currentDevice.status === 'PAIRING_CODE_READY') {
        const statusLabel =
            currentDevice.status === 'CONNECTING'
                ? 'conectando...'
                : currentDevice.status === 'PAIRING_CODE_READY'
                    ? 'esperando confirmación'
                    : 'no está vinculado';
        return (
            <div style={{ padding: 40, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                <h2 style={{ color: '#e9edef' }}>{currentDevice.name} {statusLabel}</h2>
                <p style={{ color: '#8696a0' }}>Podés vincular con QR o con código.</p>
                <Space>
                    <Button type="primary" size="large" onClick={startLinking} loading={currentDevice.status === 'CONNECTING'}>
                        {currentDevice.status === 'CONNECTING' ? 'Iniciando...' : 'Iniciar Sesión (QR)'}
                    </Button>
                    <Button type="default" size="large" onClick={openPairingModal} disabled={currentDevice.status === 'CONNECTING'}>
                        Vincular por código
                    </Button>
                </Space>
                <PairingCodeModal
                    open={showPairingModal}
                    deviceId={device.id}
                    onClose={() => setShowPairingModal(false)}
                />
                {settingsModalContent}
            </div>
        );
    }

    // Modal de Configuración (para reutilizar en todos los estados)
    const SettingsModal = () => (
        <Modal
            open={showSettingsModal}
            title="Configuración"
            onCancel={() => setShowSettingsModal(false)}
            footer={null}
            width={400}
        >
            <Typography.Title level={5}>Tono de notificación</Typography.Title>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <Radio.Group 
                    onChange={(e) => {
                        const val = e.target.value;
                        setSelectedTone(val);
                        localStorage.setItem('notificationTone', val.toString());
                        playNotificationSound(val);
                    }} 
                    value={selectedTone}
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                    {[
                        { id: 1, name: 'Beep' },
                        { id: 2, name: 'Crystal' },
                        { id: 3, name: 'Bubble' },
                        { id: 4, name: 'Notification' },
                        { id: 5, name: 'Success' },
                        { id: 6, name: 'Laser' },
                        { id: 7, name: 'Coin' },
                        { id: 8, name: 'Pluck' },
                        { id: 9, name: 'Chime' },
                        { id: 10, name: 'Deep' },
                    ].map(tone => (
                        <div key={tone.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px', background: '#f0f2f5', borderRadius: 8 }}>
                            <Radio value={tone.id}>{tone.name}</Radio>
                            <Button 
                                size="small" 
                                icon={<Play size={14} />} 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    playNotificationSound(tone.id);
                                }}
                            />
                        </div>
                    ))}
                </Radio.Group>
            </div>
            <Divider />
            <Typography.Title level={5}>Seguridad</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Input.Password
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Contraseña actual"
                    autoComplete="current-password"
                />
                <Input.Password
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Nueva contraseña"
                    autoComplete="new-password"
                />
                <Input.Password
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirmar nueva contraseña"
                    autoComplete="new-password"
                    onPressEnter={submitPasswordChange}
                />
                <Button type="primary" onClick={submitPasswordChange} loading={changingPassword}>
                    Cambiar contraseña
                </Button>
            </Space>
            <Divider />
            <Typography.Title level={5}>Mantenimiento</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Popconfirm
                    title="¿Resetear cache de chats?"
                    description="Esto limpiará todos los nombres y datos en cache. Los chats se recargarán con datos frescos."
                    onConfirm={async () => {
                        try {
                            const res = await apiFetch(`/api/devices/${device.id}/reset-cache`, { method: 'POST' });
                            const data = await res.json();
                            if (data.success) {
                                messageApi.success('Cache reseteado. Recargando...');
                                setChats([]);
                                setTimeout(() => window.location.reload(), 1500);
                            } else {
                                messageApi.error(data.message || 'Error al resetear');
                            }
                        } catch (err: any) {
                            messageApi.error('Error: ' + (err.message || 'Desconocido'));
                        }
                    }}
                    okText="Sí, resetear"
                    cancelText="Cancelar"
                    okButtonProps={{ danger: true }}
                >
                    <Button danger block>
                        🔄 Resetear cache de chats
                    </Button>
                </Popconfirm>
                <Text type="secondary" style={{ fontSize: 11 }}>
                    Usa esto si ves nombres incorrectos o datos mezclados
                </Text>
            </Space>
        </Modal>
    );

    if (currentDevice.status === 'QR_READY' && currentDevice.qr) {
        return (
            <div style={{ padding: 40, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#fff', position: 'relative' }}>
                {onClose && (
                    <Button
                        type="text"
                        icon={<X size={24} />}
                        onClick={onClose}
                        style={{
                            position: 'absolute',
                            top: 10,
                            right: 10,
                            color: '#667781',
                            padding: 8
                        }}
                    />
                )}
                <h2 style={{ color: '#000' }}>Escanea el código QR</h2>
                <div style={{ background: 'white', padding: 20, borderRadius: 10, margin: '20px 0', border: '1px solid #eee' }}>
                    <QRCode value={currentDevice.qr} size={256} />
                </div>
                <p style={{ color: '#667781', marginBottom: '20px' }}>Abre WhatsApp en tu teléfono {'>'} Dispositivos vinculados {'>'} Vincular un dispositivo</p>
                <Space>
                    <Button type="default" size="large" onClick={regenerateQR}>
                        🔄 Regenerar QR
                    </Button>
                    <Button type="default" size="large" onClick={openPairingModal}>
                        Vincular por código
                    </Button>
                    <Button type="link" danger onClick={regenerateQR}>
                        ¿QR expirado? Haz clic aquí
                    </Button>
                </Space>
                <p style={{ color: '#ff4d4f', marginTop: '10px', fontSize: '12px' }}>⚠️ Los códigos QR expiran en 20 segundos</p>
                <PairingCodeModal
                    open={showPairingModal}
                    deviceId={device.id}
                    onClose={() => setShowPairingModal(false)}
                />
                {settingsModalContent}
            </div>
        );
    }

    return (
        <Layout style={{ height: '100%', background: 'linear-gradient(180deg, #1a1410 0%, #0f0c08 100%)' }}>
            {contextHolder}
            {notificationContextHolder}
            <Sider width={300} style={{ 
                background: 'linear-gradient(180deg, #2a2218 0%, #1a1410 100%)', 
                borderRight: '2px solid',
                borderImage: 'linear-gradient(180deg, rgba(201, 162, 39, 0.3), transparent) 1'
            }}>
                <div style={{ padding: '12px' }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <Input
                            prefix={<Search size={14} color="#8b7b65" />}
                            suffix={searchQuery && (
                                <X
                                    size={14}
                                    color="#8b7b65"
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => {
                                        setSearchQuery('');
                                        setSearchResults([]);
                                        setShowSearchModal(false);
                                    }}
                                />
                            )}
                            placeholder={activeChat ? "Buscar mensajes en este chat..." : "Buscar mensajes..."}
                            value={searchQuery}
                            onChange={(e) => handleSearch(e.target.value)}
                            style={{ 
                                borderRadius: '8px', 
                                background: 'linear-gradient(145deg, #1a1410 0%, #0f0c08 100%)', 
                                color: '#f5e6c8', 
                                border: '1px solid rgba(74, 61, 46, 0.6)', 
                                flex: 1,
                                fontFamily: "'Crimson Text', Georgia, serif"
                            }}
                        />
                        <Button 
                            icon={<Settings size={16} color="#c9a227" />} 
                            style={{ 
                                background: 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)', 
                                border: '1px solid rgba(201, 162, 39, 0.3)' 
                            }}
                            onClick={() => setShowSettingsModal(true)}
                        />
                    </div>
                </div>
                <div style={{ overflowY: 'auto', height: 'calc(100% - 60px)' }}>
                    {chats.length === 0 ? (
                        <div style={{ 
                            padding: 40, 
                            textAlign: 'center', 
                            color: '#8b7b65',
                            fontFamily: "'Crimson Text', Georgia, serif",
                            fontStyle: 'italic'
                        }}>
                            <p>No hay chats disponibles</p>
                            <p style={{ fontSize: '12px' }}>Envía o recibe un mensaje para ver tus conversaciones</p>
                        </div>
                    ) : (
                        <List
                            dataSource={chats}
                            renderItem={chat => {
                                const isNotified = notifiedChats.has(chat.id) || 
                                    Array.from(notifiedChats).some(nid => getChatKey(nid) === getChatKey(chat.id));
                                const isActive = activeChat === chat.id;
                                
                                return (
                                <List.Item
                                    className={`chat-item-card ${isNotified ? 'chat-item-notified' : ''}`}
                                    onClick={() => {
                                        console.log('Chat seleccionado:', chat.id);
                                        setActiveChat(chat.id);
                                        // Resetear contador de no leídos al abrir el chat
                                        setChats(prev => prev.map(c => 
                                            c.id === chat.id ? { ...c, unreadCount: 0 } : c
                                        ));
                                        // Remover notificación al hacer click
                                        setNotifiedChats(prev => {
                                            const newSet = new Set(prev);
                                            newSet.delete(chat.id);
                                            return newSet;
                                        });
                                        // Limpiar respuesta pendiente al cambiar de chat
                                        setReplyingTo(null);
                                    }}
                                    style={{
                                        padding: '14px 16px',
                                        borderBottom: '1px solid rgba(74, 61, 46, 0.4)',
                                        cursor: 'pointer',
                                        background: isActive 
                                            ? 'linear-gradient(90deg, rgba(201, 162, 39, 0.15) 0%, rgba(47, 38, 29, 0.9) 100%)' 
                                            : 'transparent',
                                        borderLeft: isActive ? '3px solid #c9a227' : '3px solid transparent'
                                    }}
                                >
                                    <List.Item.Meta
                                        avatar={
                                            <Avatar
                                                shape="circle"
                                                src={chat.profilePhotoUrl ? assetUrl(chat.profilePhotoUrl) : undefined}
                                                style={{ 
                                                    backgroundColor: chat.isGroup ? '#4a7c59' : '#5a4d3d',
                                                    border: '2px solid rgba(201, 162, 39, 0.3)',
                                                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                                                    fontFamily: "'Playfair Display', Georgia, serif",
                                                    fontWeight: 700
                                                }}
                                            >
                                                {chat.name.substring(0, 2).toUpperCase()}
                                            </Avatar>
                                        }
                                        title={
                                            <div style={{ 
                                                color: '#f5e6c8', 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                fontFamily: "'Crimson Text', Georgia, serif"
                                            }}>
                                                <span style={{ fontWeight: 600 }}>{chat.name}</span>
                                                <Space size={4}>
                                                    {chat.unreadCount > 0 && (
                                                        <Badge
                                                            count={chat.unreadCount}
                                                            style={{ 
                                                                background: 'linear-gradient(145deg, #cd7f32 0%, #b87333 100%)',
                                                                boxShadow: '0 2px 8px rgba(205, 127, 50, 0.4)'
                                                            }}
                                                        />
                                                    )}
                                                    <span style={{ 
                                                        fontSize: '11px', 
                                                        color: '#8b7b65',
                                                        fontFamily: "'Source Serif Pro', Georgia, serif",
                                                        fontStyle: 'italic'
                                                    }}>
                                                        {new Date(chat.lastMessageTime).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                    <div onClick={(e) => e.stopPropagation()}>
                                                        <Popconfirm
                                                            title="¿Eliminar chat?"
                                                            description="Se eliminará de la lista pero no de WhatsApp"
                                                            onConfirm={() => handleDeleteChat(chat.id)}
                                                            okText="Sí"
                                                            cancelText="No"
                                                        >
                                                            <Button 
                                                                type="text" 
                                                                size="small" 
                                                                icon={<Trash2 size={14} color="#8b7b65" />} 
                                                                style={{ minWidth: 24, padding: 0 }}
                                                            />
                                                        </Popconfirm>
                                                    </div>
                                                </Space>
                                            </div>
                                        }
                                        description={
                                            <div style={{ 
                                                color: '#8b7b65', 
                                                fontSize: '13px', 
                                                display: 'flex', 
                                                alignItems: 'center', 
                                                overflow: 'hidden',
                                                fontFamily: "'Crimson Text', Georgia, serif",
                                                fontStyle: 'italic'
                                            }}>
                                                {renderLastMessagePreview(chat)}
                                            </div>
                                        }
                                    />
                                </List.Item>
                                );
                            }}
                        />
                    )}
                </div>
            </Sider>
            <Content style={{ display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, #1a1410 0%, #0f0c08 100%)' }}>
                {activeChat ? (
                    <>
                        {(() => {
                            const activeChatData = chats.find(c => c.id === activeChat);
                            const chatName = activeChatData?.name || activeChat.split('@')[0];
                            const originalName = activeChatData?.originalName || null;
                            const hasCustomName = Boolean(activeChatData?.customName);
                            
                            return (
                                <div style={{ 
                                    padding: '12px 20px', 
                                    background: 'linear-gradient(180deg, #2f261d 0%, #2a2218 100%)', 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    justifyContent: 'space-between',
                                    borderBottom: '2px solid',
                                    borderImage: 'linear-gradient(90deg, transparent, rgba(201, 162, 39, 0.4), transparent) 1'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center' }}>
                                        <Avatar style={{ 
                                            backgroundColor: activeChatData?.isGroup ? '#4a7c59' : '#5a4d3d',
                                            border: '2px solid rgba(201, 162, 39, 0.4)',
                                            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)',
                                            fontFamily: "'Playfair Display', Georgia, serif",
                                            fontWeight: 700
                                        }}>
                                            {chatName.substring(0, 2).toUpperCase()}
                                        </Avatar>
                                        <div style={{ marginLeft: 15 }}>
                                            {editingContactName ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <Input
                                                        value={newContactName}
                                                        onChange={e => setNewContactName(e.target.value)}
                                                        onPressEnter={saveContactName}
                                                        placeholder="Nombre personalizado..."
                                                        autoFocus
                                                        style={{ 
                                                            width: 200,
                                                            background: '#1a1410',
                                                            border: '1px solid rgba(201, 162, 39, 0.4)',
                                                            color: '#f5e6c8'
                                                        }}
                                                    />
                                                    <Button 
                                                        type="text" 
                                                        size="small"
                                                        onClick={saveContactName}
                                                        style={{ color: '#4a7c59' }}
                                                    >
                                                        ✓
                                                    </Button>
                                                    <Button 
                                                        type="text" 
                                                        size="small"
                                                        onClick={() => setEditingContactName(false)}
                                                        style={{ color: '#8b7b65' }}
                                                    >
                                                        ✕
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    <div style={{ 
                                                        color: '#f5e6c8', 
                                                        fontWeight: 'bold',
                                                        fontFamily: "'Playfair Display', Georgia, serif",
                                                        fontSize: '15px',
                                                        letterSpacing: '0.3px'
                                                    }}>
                                                        {chatName}
                                                        {hasCustomName && (
                                                            <span style={{ 
                                                                marginLeft: 6, 
                                                                fontSize: '10px', 
                                                                color: '#c9a227',
                                                                fontWeight: 'normal'
                                                            }}>
                                                                ✎
                                                            </span>
                                                        )}
                                                    </div>
                                                    <Tooltip title="Renombrar contacto (como agenda)">
                                                        <Button
                                                            type="text"
                                                            size="small"
                                                            icon={<Edit2 size={14} color="#8b7b65" />}
                                                            onClick={() => {
                                                                setNewContactName(activeChatData?.customName || '');
                                                                setEditingContactName(true);
                                                            }}
                                                            style={{ padding: 4, minWidth: 24 }}
                                                        />
                                                    </Tooltip>
                                                </div>
                                            )}
                                            {!editingContactName && originalName && hasCustomName && (
                                                <div style={{ 
                                                    color: '#8b7b65', 
                                                    fontSize: '10px',
                                                    fontFamily: "'Source Serif Pro', Georgia, serif",
                                                    fontStyle: 'italic'
                                                }}>
                                                    WhatsApp: {originalName}
                                                </div>
                                            )}
                                            {presence && (
                                                <div style={{ 
                                                    color: '#c9a227', 
                                                    fontSize: '11px',
                                                    fontFamily: "'Source Serif Pro', Georgia, serif",
                                                    fontStyle: 'italic'
                                                }}>
                                                    {presence === 'composing' ? 'escribiendo...' : presence === 'recording' ? 'grabando audio...' : ''}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })()}

                        <div
                            ref={scrollRef}
                            style={{
                                flex: 1,
                                padding: 20,
                                overflowY: 'auto',
                                background: `
                                    radial-gradient(ellipse at bottom right, rgba(201, 162, 39, 0.03) 0%, transparent 50%),
                                    repeating-linear-gradient(45deg, 
                                        rgba(26, 20, 16, 0.95) 0px, 
                                        rgba(26, 20, 16, 0.95) 12px, 
                                        rgba(15, 12, 8, 0.95) 12px, 
                                        rgba(15, 12, 8, 0.95) 24px
                                    )
                                `,
                                backgroundSize: 'auto'
                            }}
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {messages.map((m, i) => (
                                    <Dropdown
                                        key={m.id || i}
                                        menu={{
                                            items: [
                                                { 
                                                    key: 'reply', 
                                                    label: 'Responder',
                                                    icon: <span style={{ marginRight: 8 }}>↩️</span>,
                                                    onClick: () => {
                                                        console.log('[Reply] Mensaje seleccionado:', { id: m.id, text: m.text?.substring(0, 30), senderName: m.senderName, fromMe: m.fromMe });
                                                        setReplyingTo(m);
                                                    }
                                                },
                                                { 
                                                    key: 'copy', 
                                                    label: 'Copiar texto',
                                                    icon: <span style={{ marginRight: 8 }}>📋</span>,
                                                    onClick: () => {
                                                        navigator.clipboard.writeText(m.text || '');
                                                        messageApi.success('Texto copiado');
                                                    },
                                                    disabled: !m.text
                                                }
                                            ]
                                        }}
                                        trigger={['contextMenu']}
                                    >
                                        <div
                                            id={m.id ? `msg-${m.id}` : undefined}
                                            style={{
                                                alignSelf: m.fromMe ? 'flex-end' : 'flex-start',
                                                background: m.fromMe 
                                                    ? (m.source === 'panel' 
                                                        ? 'linear-gradient(145deg, #4a7c59 0%, #2d4a35 100%)' 
                                                        : 'linear-gradient(145deg, #3d5a45 0%, #2a3d30 100%)') 
                                                    : 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)',
                                                padding: '8px',
                                                borderRadius: '10px',
                                                color: '#f5e6c8',
                                                maxWidth: '70%',
                                                boxShadow: '0 3px 10px rgba(0,0,0,0.3), inset 0 1px 0 rgba(245, 230, 200, 0.05)',
                                                position: 'relative',
                                                border: m.fromMe 
                                                    ? '1px solid rgba(74, 124, 89, 0.4)' 
                                                    : '1px solid rgba(201, 162, 39, 0.2)',
                                                outline: highlightMsgId && m.id === highlightMsgId ? '2px solid #c9a227' : undefined,
                                                cursor: 'context-menu',
                                                fontFamily: "'Crimson Text', Georgia, serif"
                                            }}
                                        >
                                            {/* Nombre del remitente para mensajes recibidos - estilo retro */}
                                            {!m.fromMe && m.senderName && (
                                                <div style={{ 
                                                    fontSize: '12px', 
                                                    fontWeight: 700, 
                                                    color: '#c9a227',
                                                    padding: '2px 7px 6px 7px',
                                                    fontFamily: "'Playfair Display', Georgia, serif",
                                                    letterSpacing: '0.3px',
                                                    textShadow: '0 1px 2px rgba(0,0,0,0.2)'
                                                }}>
                                                    {m.senderName}
                                                </div>
                                            )}
                                            {m.location && Number.isFinite(m.location.latitude) && Number.isFinite(m.location.longitude) && (
                                                <div
                                                    style={{
                                                        background: 'rgba(0,0,0,0.2)',
                                                        padding: '10px 12px',
                                                        borderRadius: 6,
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        gap: 6
                                                    }}
                                                >
                                                    <div style={{ fontSize: '13px', fontWeight: 600 }}>📍 Ubicación</div>
                                                    {(m.location.name || m.location.address) && (
                                                        <div style={{ fontSize: '12px', color: '#d1d7db' }}>
                                                            {m.location.name && <div>{m.location.name}</div>}
                                                            {m.location.address && <div style={{ color: '#8696a0' }}>{m.location.address}</div>}
                                                        </div>
                                                    )}
                                                    <div style={{ fontSize: '11px', color: '#8696a0' }}>
                                                        {m.location.latitude.toFixed(5)}, {m.location.longitude.toFixed(5)}
                                                    </div>
                                                    <div>
                                                        <a
                                                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${m.location.latitude},${m.location.longitude}`)}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            style={{ color: '#25D366', fontSize: '12px' }}
                                                        >
                                                            Abrir en Google Maps
                                                        </a>
                                                    </div>
                                                </div>
                                            )}
                                            {m.media && (
                                                <div style={{ marginBottom: 5, borderRadius: 4, overflow: 'hidden' }}>
                                                    {m.media.mimeType.startsWith('image/') ? (
                                                        <img
                                                            src={assetUrl(m.media.url)}
                                                            alt={m.media.fileName}
                                                            style={{ maxWidth: '100%', maxHeight: 300, display: 'block', cursor: 'pointer' }}
                                                            onClick={() => window.open(assetUrl(m.media?.url || ''))}
                                                        />
                                                    ) : m.media.mimeType.startsWith('video/') ? (
                                                        <video controls style={{ maxWidth: '100%', maxHeight: 300 }}>
                                                            <source src={assetUrl(m.media.url)} type={m.media.mimeType} />
                                                        </video>
                                                    ) : m.media.mimeType.startsWith('audio/') ? (
                                                        <audio controls style={{ maxWidth: 250 }}>
                                                            <source src={assetUrl(m.media.url)} type={m.media.mimeType} />
                                                        </audio>
                                                    ) : (
                                                        <div
                                                            style={{ background: 'rgba(0,0,0,0.2)', padding: '10px 15px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                                                            onClick={() => window.open(assetUrl(m.media?.url || ''))}
                                                        >
                                                            <Paperclip size={20} />
                                                            <div style={{ flex: 1, overflow: 'hidden' }}>
                                                                <div style={{ fontSize: '13px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{m.media.fileName}</div>
                                                                <div style={{ fontSize: '11px', color: '#8696a0' }}>{(m.media.size / 1024).toFixed(1)} KB</div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {m.text && <div style={{ padding: '3px 7px 0 7px', lineHeight: 1.5 }}>{m.text}</div>}
                                            <div style={{ 
                                                fontSize: '10px', 
                                                color: '#8b7b65', 
                                                textAlign: 'right', 
                                                marginTop: 6, 
                                                padding: '0 5px 2px 7px', 
                                                display: 'flex', 
                                                alignItems: 'center', 
                                                justifyContent: 'flex-end', 
                                                gap: 6,
                                                fontFamily: "'Source Serif Pro', Georgia, serif",
                                                fontStyle: 'italic'
                                            }}>
                                                {(m.source === 'panel' || m.source === 'phone' || m.source === 'whatsapp') && (
                                                    <Tooltip title={`Enviado desde ${m.source === 'panel' ? 'el Panel' : 'el Dispositivo'}`}>
                                                        <span style={{ 
                                                            background: 'rgba(201, 162, 39, 0.15)', 
                                                            padding: '2px 6px', 
                                                            borderRadius: '4px',
                                                            color: '#c9a227',
                                                            fontSize: '9px'
                                                        }}>
                                                            {m.source === 'panel' ? '◈ Panel' : '◈ Dispositivo'}
                                                        </span>
                                                    </Tooltip>
                                                )}
                                                {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                {m.fromMe && <CheckCheck size={12} color="#c9a227" />}
                                            </div>
                                        </div>
                                    </Dropdown>
                                ))}
                            </div>
                        </div>

                        {/* Indicador de respuesta - estilo retro */}
                        {replyingTo && (
                            <div style={{ 
                                background: 'linear-gradient(90deg, rgba(201, 162, 39, 0.1) 0%, rgba(47, 38, 29, 0.95) 100%)', 
                                padding: '10px 14px',
                                borderLeft: '4px solid #c9a227',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                borderTop: '1px solid rgba(201, 162, 39, 0.2)'
                            }}>
                                <div style={{ flex: 1, overflow: 'hidden' }}>
                                    <div style={{ 
                                        color: '#c9a227', 
                                        fontSize: 12, 
                                        fontWeight: 700,
                                        fontFamily: "'Playfair Display', Georgia, serif",
                                        letterSpacing: '0.3px'
                                    }}>
                                        ↩ Respondiendo a {replyingTo.fromMe ? 'ti mismo' : (replyingTo.senderName || 'Contacto')}
                                    </div>
                                    <div style={{ 
                                        color: '#8b7b65', 
                                        fontSize: 11, 
                                        overflow: 'hidden', 
                                        textOverflow: 'ellipsis', 
                                        whiteSpace: 'nowrap',
                                        fontFamily: "'Crimson Text', Georgia, serif",
                                        fontStyle: 'italic',
                                        marginTop: 2
                                    }}>
                                        {replyingTo.text?.substring(0, 60) || (replyingTo.media ? '📎 Multimedia' : '...')}
                                        {replyingTo.text && replyingTo.text.length > 60 ? '...' : ''}
                                    </div>
                                </div>
                                <Button 
                                    type="text" 
                                    size="small"
                                    icon={<X size={16} color="#8b7b65" />} 
                                    onClick={cancelReply}
                                    style={{ marginLeft: 8 }}
                                />
                            </div>
                        )}

                        <div style={{ 
                            padding: '12px 14px', 
                            background: 'linear-gradient(180deg, #2f261d 0%, #2a2218 100%)', 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: 12,
                            borderTop: '2px solid',
                            borderImage: 'linear-gradient(90deg, transparent, rgba(201, 162, 39, 0.3), transparent) 1'
                        }}>
                            {isRecording ? (
                                <>
                                    <Tooltip title="Cancelar grabación">
                                        <Button
                                            type="text"
                                            danger
                                            icon={<span style={{ fontSize: '20px' }}>✕</span>}
                                            onClick={cancelRecording}
                                        />
                                    </Tooltip>
                                    <div style={{
                                        flex: 1,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 12,
                                        background: 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)',
                                        padding: '12px 16px',
                                        borderRadius: '8px',
                                        border: '1px solid rgba(201, 162, 39, 0.2)'
                                    }}>
                                        <div style={{
                                            width: 12,
                                            height: 12,
                                            borderRadius: '50%',
                                            background: 'linear-gradient(145deg, #cd7f32 0%, #b87333 100%)',
                                            animation: 'pulse 1.5s ease-in-out infinite',
                                            boxShadow: '0 0 10px rgba(205, 127, 50, 0.5)'
                                        }} />
                                        <span style={{ 
                                            color: '#f5e6c8', 
                                            fontSize: '14px',
                                            fontFamily: "'Source Serif Pro', Georgia, serif",
                                            fontStyle: 'italic'
                                        }}>
                                            Grabando... {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                                        </span>
                                    </div>
                                    <Tooltip title="Enviar nota de voz">
                                        <Button
                                            type="text"
                                            onClick={stopRecording}
                                            icon={<Send size={20} color="#c9a227" />}
                                        />
                                    </Tooltip>
                                </>
                            ) : (
                                <>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*,.pdf,application/pdf,video/*,audio/*"
                                        style={{ display: 'none' }}
                                        onChange={handleFileSelect}
                                    />
                                    {/* Selector de Emojis */}
                                    <Popover
                                        content={
                                            <div style={{ width: 320, maxHeight: 350 }}>
                                                {/* Categorías */}
                                                <div style={{ 
                                                    display: 'flex', 
                                                    gap: 4, 
                                                    marginBottom: 8, 
                                                    flexWrap: 'wrap',
                                                    borderBottom: '1px solid rgba(201, 162, 39, 0.2)',
                                                    paddingBottom: 8
                                                }}>
                                                    {Object.keys(EMOJI_CATEGORIES).map(cat => (
                                                        <Button
                                                            key={cat}
                                                            size="small"
                                                            type={activeEmojiCategory === cat ? 'primary' : 'text'}
                                                            onClick={() => setActiveEmojiCategory(cat)}
                                                            style={{ 
                                                                fontSize: 11,
                                                                padding: '2px 8px',
                                                                background: activeEmojiCategory === cat 
                                                                    ? 'linear-gradient(145deg, #c9a227 0%, #8b7015 100%)' 
                                                                    : 'transparent',
                                                                color: activeEmojiCategory === cat ? '#1a1410' : '#c9a227',
                                                                border: activeEmojiCategory === cat 
                                                                    ? 'none' 
                                                                    : '1px solid rgba(201, 162, 39, 0.3)'
                                                            }}
                                                        >
                                                            {cat}
                                                        </Button>
                                                    ))}
                                                </div>
                                                {/* Grid de emojis */}
                                                <div style={{ 
                                                    display: 'grid', 
                                                    gridTemplateColumns: 'repeat(8, 1fr)', 
                                                    gap: 4,
                                                    maxHeight: 250,
                                                    overflowY: 'auto'
                                                }}>
                                                    {EMOJI_CATEGORIES[activeEmojiCategory as keyof typeof EMOJI_CATEGORIES]?.map((emoji, idx) => (
                                                        <Button
                                                            key={idx}
                                                            type="text"
                                                            onClick={() => {
                                                                insertEmoji(emoji);
                                                                // No cerrar para permitir seleccionar múltiples
                                                            }}
                                                            style={{ 
                                                                fontSize: 22, 
                                                                padding: 4,
                                                                minWidth: 36,
                                                                height: 36,
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                justifyContent: 'center',
                                                                borderRadius: 6,
                                                                transition: 'all 0.2s'
                                                            }}
                                                            onMouseEnter={e => {
                                                                e.currentTarget.style.background = 'rgba(201, 162, 39, 0.2)';
                                                                e.currentTarget.style.transform = 'scale(1.2)';
                                                            }}
                                                            onMouseLeave={e => {
                                                                e.currentTarget.style.background = 'transparent';
                                                                e.currentTarget.style.transform = 'scale(1)';
                                                            }}
                                                        >
                                                            {emoji}
                                                        </Button>
                                                    ))}
                                                </div>
                                            </div>
                                        }
                                        title={
                                            <span style={{ 
                                                color: '#c9a227', 
                                                fontFamily: "'Playfair Display', Georgia, serif" 
                                            }}>
                                                Emojis
                                            </span>
                                        }
                                        trigger="click"
                                        open={showEmojiPicker}
                                        onOpenChange={setShowEmojiPicker}
                                        placement="topLeft"
                                        overlayStyle={{ 
                                            background: 'linear-gradient(145deg, #2f261d 0%, #1a1410 100%)',
                                            borderRadius: 10,
                                            border: '1px solid rgba(201, 162, 39, 0.3)'
                                        }}
                                        overlayInnerStyle={{
                                            background: 'transparent'
                                        }}
                                    >
                                        <Tooltip title="Emojis">
                                            <Button
                                                type="text"
                                                icon={<Smile size={20} color="#c9a227" />}
                                                style={{
                                                    background: showEmojiPicker 
                                                        ? 'linear-gradient(145deg, #4a3d2e 0%, #3d3225 100%)' 
                                                        : 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)',
                                                    border: '1px solid rgba(201, 162, 39, 0.3)',
                                                    borderRadius: '8px'
                                                }}
                                            />
                                        </Tooltip>
                                    </Popover>
                                    
                                    <Tooltip title="Adjuntar archivo">
                                        <Button
                                            type="text"
                                            icon={<Paperclip size={20} color="#8b7b65" />}
                                            onClick={() => fileInputRef.current?.click()}
                                            loading={uploadingFile}
                                            disabled={uploadingFile}
                                            style={{
                                                background: 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)',
                                                border: '1px solid rgba(201, 162, 39, 0.2)',
                                                borderRadius: '8px'
                                            }}
                                        />
                                    </Tooltip>
                                    <Input
                                        value={inputText}
                                        onChange={e => {
                                            const text = e.target.value;
                                            setInputText(text);
                                        }}
                                        onKeyDown={e => {
                                            // Detectar atajos cuando se presiona espacio o Enter
                                            if (e.key === ' ' || e.key === 'Enter') {
                                                const text = inputText.trim();
                                                if (text.startsWith('/')) {
                                                    const template = templates.find(t => t.shortcut === text);
                                                    if (template) {
                                                        e.preventDefault();
                                                        setInputText(template.content);
                                                        void apiFetch(`/api/templates/${template.id}/use`, { method: 'POST' }).catch(() => {});
                                                        return;
                                                    }
                                                }
                                            }
                                        }}
                                        onPressEnter={e => {
                                            // Solo enviar si no es un atajo
                                            const text = inputText.trim();
                                            if (text.startsWith('/')) {
                                                const template = templates.find(t => t.shortcut === text);
                                                if (template) {
                                                    return; // No enviar, el onKeyDown ya manejó esto
                                                }
                                            }
                                            sendMessage();
                                        }}
                                        placeholder="Escribe un mensaje o usa /atajo + espacio"
                                        style={{ 
                                            borderRadius: '8px', 
                                            background: 'linear-gradient(145deg, #1a1410 0%, #0f0c08 100%)', 
                                            color: '#f5e6c8', 
                                            border: '1px solid rgba(74, 61, 46, 0.6)', 
                                            height: '42px',
                                            fontFamily: "'Crimson Text', Georgia, serif",
                                            fontSize: '14px'
                                        }}
                                        disabled={uploadingFile}
                                    />
                                    {inputText ? (
                                        <Button 
                                            type="text" 
                                            onClick={sendMessage} 
                                            loading={loading} 
                                            icon={<Send size={20} color="#c9a227" />}
                                            style={{
                                                background: 'linear-gradient(145deg, #4a7c59 0%, #2d4a35 100%)',
                                                border: '1px solid rgba(74, 124, 89, 0.4)',
                                                borderRadius: '8px'
                                            }}
                                        />
                                    ) : (
                                        <Tooltip title="Mantén presionado para grabar">
                                            <Button
                                                type="text"
                                                icon={<Mic size={20} color={uploadingFile ? "#8b7b65" : "#c9a227"} />}
                                                onClick={startRecording}
                                                style={{
                                                    background: 'linear-gradient(145deg, #3d3225 0%, #2a2218 100%)',
                                                    border: '1px solid rgba(201, 162, 39, 0.2)',
                                                    borderRadius: '8px'
                                                }}
                                                disabled={uploadingFile}
                                            />
                                        </Tooltip>
                                    )}
                                </>
                            )}
                        </div>
                    </>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8696a0' }}>
                        Selecciona un chat para comenzar
                    </div>
                )}
            </Content>

            {/* Modal de resultados de búsqueda */}
            <Modal
                title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Search size={18} />
                        <span>Resultados de búsqueda: "{searchQuery}"</span>
                    </div>
                }
                open={showSearchModal}
                onCancel={() => {
                    setShowSearchModal(false);
                    setSearchQuery('');
                    setSearchResults([]);
                }}
                footer={null}
                width={600}
                styles={{
                    content: { background: '#111b21' },
                    header: { background: '#111b21', color: '#e9edef' },
                    body: { background: '#111b21', maxHeight: '60vh', overflowY: 'auto' }
                }}
            >
                {isSearching ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                        <Spin size="large" />
                        <div style={{ color: '#8696a0', marginTop: 16 }}>Buscando mensajes...</div>
                    </div>
                ) : searchResults.length === 0 ? (
                    <Empty
                        description={<span style={{ color: '#8696a0' }}>No se encontraron mensajes</span>}
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                ) : (
                    <List
                        dataSource={searchResults}
                        renderItem={(result) => (
                            <List.Item
                                onClick={() => goToSearchResult(result)}
                                style={{
                                    padding: '12px 16px',
                                    cursor: 'pointer',
                                    borderBottom: '1px solid #222e35',
                                    transition: 'background 0.2s'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = '#202c33'}
                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <List.Item.Meta
                                    avatar={
                                        <Avatar style={{ background: result.fromMe ? '#005c4b' : '#202c33' }}>
                                            {result.chatName.charAt(0).toUpperCase()}
                                        </Avatar>
                                    }
                                    title={
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <Text style={{ color: '#e9edef' }}>
                                                {result.chatName}
                                            </Text>
                                            <Text style={{ color: '#8696a0', fontSize: '11px' }}>
                                                {new Date(result.timestamp).toLocaleString()}
                                            </Text>
                                        </div>
                                    }
                                    description={
                                        <div style={{ color: '#d1d7db' }}>
                                            <Badge
                                                status={result.fromMe ? 'processing' : 'default'}
                                                text={
                                                    <span style={{ color: '#8696a0', fontSize: '11px' }}>
                                                        {result.fromMe ? 'Tú' : 'Contacto'}
                                                    </span>
                                                }
                                            />
                                            <div style={{ marginTop: 4 }}>
                                                {result.text.length > 150
                                                    ? result.text.substring(0, 150) + '...'
                                                    : result.text
                                                }
                                            </div>
                                        </div>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                )}
            </Modal>
            {settingsModalContent}
        </Layout>
    );
};
