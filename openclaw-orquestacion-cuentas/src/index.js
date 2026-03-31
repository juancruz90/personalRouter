const { createProxyServer } = require('../proxy/server');
const { createAuthRouter } = require('../auth/interceptor');

async function main() {
  const proxy = createProxyServer();
  proxy.app.use(createAuthRouter());
  const { port } = await proxy.start();
  console.log(`Proxy listening on port ${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
