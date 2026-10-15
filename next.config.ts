import type { NextConfig } from "next";

/**
 * Rotas do front. Cada uma serve, sem alterações, um arquivo exportado do Claude Design:
 *   /          → public/site/index.html        (Spherum 2.0 - Xodo.html: LP, login, cadastro, contato e portais)
 *   /agencia   → public/prototipo/agencia.html (portal da agência)
 *   /cliente   → public/prototipo/cliente.html (portal do cliente)
 *   /admin     → public/prototipo/admin.html   (portal admin)
 *   /video     → public/prototipo/video.html   (vídeo de demonstração)
 *   /xodo      → public/prototipo/xodo.html    (sistema dos Xodós completo)
 */
const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/site/index.html" },
        { source: "/agencia", destination: "/prototipo/agencia.html" },
        { source: "/cliente", destination: "/prototipo/cliente.html" },
        { source: "/admin", destination: "/prototipo/admin.html" },
        { source: "/video", destination: "/prototipo/video.html" },
        { source: "/xodo", destination: "/prototipo/xodo.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
