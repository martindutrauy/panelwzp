import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_BASE, SOCKET_URL } from '../lib/runtime';
import { getAuthToken } from '../lib/auth';

// Singleton para evitar múltiples conexiones
let globalSocket: Socket | null = null;
let globalToken: string | null = null;

export const useSocket = () => {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [token, setToken] = useState(() => getAuthToken());
    const reconnectAttempts = useRef(0);

    // Verificar token cada 5 segundos (en lugar de cada segundo)
    useEffect(() => {
        const id = window.setInterval(() => {
            const next = getAuthToken();
            setToken((prev) => (prev === next ? prev : next));
        }, 5000);
        return () => {
            window.clearInterval(id);
        };
    }, []);

    useEffect(() => {
        const url = SOCKET_URL || API_BASE || undefined;
        
        if (!token) {
            setSocket(null);
            return;
        }

        // Si ya existe un socket global con el mismo token, reutilizarlo
        if (globalSocket && globalToken === token && globalSocket.connected) {
            setSocket(globalSocket);
            return;
        }

        // Cerrar socket anterior si existe
        if (globalSocket) {
            globalSocket.close();
            globalSocket = null;
        }

        const socketOptions = {
            auth: { token },
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 2000,
            reconnectionDelayMax: 10000,
            timeout: 20000,
            transports: ['websocket', 'polling'] // Preferir websocket
        };

        const newSocket = url ? io(url, socketOptions) : io(socketOptions);
        
        newSocket.on('connect', () => {
            reconnectAttempts.current = 0;
        });

        newSocket.on('connect_error', (err) => {
            reconnectAttempts.current++;
            if (reconnectAttempts.current <= 3) {
                console.warn(`[Socket] Error de conexión (intento ${reconnectAttempts.current}):`, err.message);
            }
        });

        globalSocket = newSocket;
        globalToken = token;
        setSocket(newSocket);

        return () => {
            // Solo desconectar si el componente se desmonta completamente
            // No desconectar en cada re-render
        };
    }, [token]);

    // Cleanup al desmontar la app completamente
    useEffect(() => {
        return () => {
            if (globalSocket) {
                globalSocket.close();
                globalSocket = null;
                globalToken = null;
            }
        };
    }, []);

    return socket;
};
