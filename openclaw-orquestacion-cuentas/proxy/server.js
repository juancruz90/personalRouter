const http = require('http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { URL } = require('url');
const { routeRequest } = require('../routing/engine');

function createProxyServer({ port = Number(process.env.PROXY_PORT || 8080) } = {}) {
  const app = express();

  app.use(express.raw({ type: '*/*', limit: '10mb' }));

  app.use(async (req, res, next) => {
    if (req.path === '/health') {
      return next();
    }

    const startedAt = new Date().toISOString();
    console.log(JSON.stringify({
      module: 'proxy',
      level: 'info',
      message: 'request_intercepted',
      method: req.method,
      url: req.originalUrl,
      timestamp: startedAt,
    }));

    try {
      const target = req.headers['x-target-url'] || req.query.targetUrl;
      if (!target) {
        return res.status(400).json({ error: 'Missing target URL. Use x-target-url header or ?targetUrl=' });
      }

      const parsedTarget = new URL(target);
      req.routing = await routeRequest({
        method: req.method,
        url: parsedTarget.toString(),
        headers: req.headers,
        body: req.body,
      });

      req.proxyTarget = parsedTarget.origin;
      req.forwardPath = `${parsedTarget.pathname}${parsedTarget.search}`;
      return next();
    } catch (error) {
      console.error(JSON.stringify({
        module: 'proxy',
        level: 'error',
        message: 'request_intercept_failed',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));
      return res.status(502).json({ error: 'Proxy routing failed', detail: error.message });
    }
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use((req, res, next) => {
    if (!req.proxyTarget) {
      return next();
    }

    const proxy = createProxyMiddleware({
      target: req.proxyTarget,
      changeOrigin: true,
      secure: false,
      pathRewrite: () => req.forwardPath,
      on: {
        proxyReq(proxyReq, incomingReq) {
          Object.entries(incomingReq.headers || {}).forEach(([key, value]) => {
            if (value !== undefined && key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
              proxyReq.setHeader(key, value);
            }
          });

          if (incomingReq.body && incomingReq.body.length) {
            proxyReq.setHeader('content-length', incomingReq.body.length);
            proxyReq.write(incomingReq.body);
          }
        },
        error(error, _req, resObj) {
          if (!resObj.headersSent) {
            resObj.writeHead(502, { 'Content-Type': 'application/json' });
          }
          resObj.end(JSON.stringify({ error: 'Upstream connection failed', detail: error.message }));
        },
      },
    });

    return proxy(req, res, next);
  });

  const server = http.createServer(app);
  server.on('clientError', (error, socket) => {
    console.error(JSON.stringify({
      module: 'proxy',
      level: 'error',
      message: 'client_error',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    app,
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(port, () => resolve({ port }));
      });
    },
  };
}

module.exports = {
  createProxyServer,
};
