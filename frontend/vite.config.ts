import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        {
            name: 'serve-index-html-at-root',
            configureServer(server) {
                server.middlewares.use((req, _res, next) => {
                    if (req.url === '/' || req.url === '') req.url = '/index.html'
                    next()
                })
            }
        }
    ],
    server: {
        port: 3000,
        proxy: {
            '/api': 'http://localhost:5000',
            '/storage': 'http://localhost:5000',
            '/socket.io': {
                target: 'http://localhost:5000',
                ws: true
            }
        }
    }
})
