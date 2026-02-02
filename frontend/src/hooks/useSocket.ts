import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_BASE, SOCKET_URL } from '../lib/runtime';
import { getAuthToken } from '../lib/auth';

export const useSocket = () => {
    const [socket, setSocket] = useState<Socket | null>(null);

    useEffect(() => {
        const url = SOCKET_URL || API_BASE || undefined;
        const token = getAuthToken();
        if (!token) {
            setSocket(null);
            return;
        }
        const newSocket = url ? io(url, { auth: { token } }) : io({ auth: { token } });
        setSocket(newSocket);

        return () => {
            newSocket.close();
        };
    }, [API_BASE, SOCKET_URL, getAuthToken()]);

    return socket;
};
