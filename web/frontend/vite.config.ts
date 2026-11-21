import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/t': 'http://localhost:8080',
      '/s': 'http://localhost:8080',
    },
  },
})
