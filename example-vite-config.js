/**
 * Example vite.config.js for YOUR separate app
 * This goes in YOUR app, not bolt.diy
 */

export default {
  server: {
    headers: {
      // Match bolt.diy's headers
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    proxy: {
      // Proxy /bolt to your bolt.diy instance
      '/bolt': {
        target: 'http://localhost:5173', // Or production URL
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bolt/, ''),
        ws: true, // WebSocket support for terminal
      }
    }
  }
}

// Then in your app:
// <iframe src="/bolt" />  <!-- Proxied to bolt.diy -->