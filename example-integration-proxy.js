/**
 * Example proxy server for your separate app
 * Add this to YOUR app's codebase, not bolt.diy
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = 3000;

// Serve your app's static files or routes
app.use(express.static('dist')); // Your app's build folder

// Proxy all /bolt/* requests to bolt.diy
app.use('/bolt', createProxyMiddleware({
  target: 'http://localhost:5173', // Or your deployed bolt.diy URL
  changeOrigin: true,
  pathRewrite: { '^/bolt': '' },
  ws: true, // For WebSocket support (terminal)
  onProxyRes: (proxyRes) => {
    // Ensure COEP/COOP headers match
    proxyRes.headers['cross-origin-embedder-policy'] = 'credentialless';
    proxyRes.headers['cross-origin-opener-policy'] = 'same-origin';
  }
}));

// Set headers for all responses from your app
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.listen(PORT, () => {
  console.log(`Your app with embedded bolt.diy: http://localhost:${PORT}`);
});

// In your app's HTML/React component:
// <iframe src="/bolt" />  <!-- Same origin! -->