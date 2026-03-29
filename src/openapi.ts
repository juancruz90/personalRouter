export interface OpenApiOptions {
  serverUrl?: string;
}

export function buildOpenApiSpec(options?: OpenApiOptions): Record<string, unknown> {
  const serverUrl = options?.serverUrl || 'http://127.0.0.1:3001';

  return {
    openapi: '3.1.0',
    info: {
      title: 'OCOM API',
      version: '1.0.0',
      description: 'OpenClaw Codex OAuth Manager API contract (single source of truth).',
    },
    servers: [
      {
        url: serverUrl,
      },
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Service health and operating mode',
          responses: {
            '200': { description: 'Healthy service response' },
          },
        },
      },
      '/mode': {
        get: {
          summary: 'Current operating mode (single-agent / permissions)',
          responses: {
            '200': { description: 'Current mode' },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI v1 contract',
          responses: {
            '200': { description: 'OpenAPI document' },
          },
        },
      },
      '/seed/personal-provider': {
        post: {
          summary: 'Idempotent seed for project + base agents',
          responses: {
            '200': { description: 'Seed result' },
          },
        },
      },
      '/accounts': {
        get: {
          summary: 'List accounts',
          responses: {
            '200': { description: 'Accounts list' },
          },
        },
        post: {
          summary: 'Create account',
          responses: {
            '201': { description: 'Created account' },
          },
        },
      },
      '/accounts/{id}': {
        get: {
          summary: 'Get account by id',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'Account view' },
            '404': { description: 'Account not found' },
          },
        },
        delete: {
          summary: 'Revoke account by id',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'Revoked account' },
          },
        },
      },
      '/accounts/{id}/status': {
        get: {
          summary: 'Get account computed status',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'Account status' },
          },
        },
      },
      '/accounts/runtime': {
        get: {
          summary: 'List runtime health semaphore per account',
          responses: {
            '200': { description: 'Runtime account states' },
          },
        },
      },
      '/accounts/{id}/runtime-event': {
        post: {
          summary: 'Record runtime event (success/degraded/exhausted) for account',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'Runtime event accepted' },
          },
        },
      },
      '/assignments': {
        get: {
          summary: 'List assignments (optionally by agent/provider)',
          responses: {
            '200': { description: 'Assignments list' },
          },
        },
        post: {
          summary: 'Upsert assignment for agent/account',
          responses: {
            '200': { description: 'Assignment upserted' },
          },
        },
      },
      '/assignments/{id}': {
        delete: {
          summary: 'Delete assignment by id',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'Assignment removed' },
          },
        },
      },
      '/router/{agentSlug}/select': {
        get: {
          summary: 'Select active account for an agent (with failover)',
          parameters: [
            { name: 'agentSlug', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Selection result' },
          },
        },
      },
      '/agents/{slug}/active-account': {
        get: {
          summary: 'Agent-centric active account resolution',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Active account view' },
          },
        },
      },
      '/oauth/{provider}/start': {
        get: {
          summary: 'Start OAuth PKCE flow',
          parameters: [
            { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Authorization URL + state' },
          },
        },
      },
      '/oauth/{provider}/callback': {
        get: {
          summary: 'Handle OAuth callback and optional token storage',
          parameters: [
            { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Callback result' },
          },
        },
      },
      '/tokens/refresh/run': {
        post: {
          summary: 'Run token refresh sweep',
          responses: {
            '200': { description: 'Refresh run summary' },
          },
        },
      },
      '/health/run': {
        post: {
          summary: 'Run health scoring sweep',
          responses: {
            '200': { description: 'Health run summary' },
          },
        },
      },
      '/backup/list': {
        get: {
          summary: 'List backup artifacts',
          responses: {
            '200': { description: 'Backup artifacts' },
          },
        },
      },
      '/backup/run': {
        post: {
          summary: 'Run immediate backup',
          responses: {
            '200': { description: 'Backup artifact' },
          },
        },
      },
      '/backup/restore': {
        post: {
          summary: 'Restore backup artifact',
          responses: {
            '200': { description: 'Restore result' },
          },
        },
      },
      '/events/recent': {
        get: {
          summary: 'Recent realtime events',
          responses: {
            '200': { description: 'Recent event list' },
          },
        },
      },
      '/ws/events': {
        get: {
          summary: 'Realtime websocket event stream',
          responses: {
            '101': { description: 'WebSocket upgrade' },
          },
        },
      },
      '/audit': {
        get: {
          summary: 'Audit log entries',
          responses: {
            '200': { description: 'Audit entries' },
          },
        },
      },
    },
  };
}
