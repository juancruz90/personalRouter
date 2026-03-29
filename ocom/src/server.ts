import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3001);

async function main() {
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({ ok: true, service: 'ocom', ts: new Date().toISOString() }));

  await app.listen({ host: '127.0.0.1', port });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
