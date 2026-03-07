import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  void env // suppress unused-variable warning

  return {
    plugins: [react()],
    server: {
      port: 3001,
      strictPort: true,
      open: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
          secure: false,
          ws: true
        }
      }
    }
  }
})
