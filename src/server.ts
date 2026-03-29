import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config as loadEnv } from 'dotenv';
import http from 'http';
import { sanitizeForLog } from './logSanitizer';
import {
  assertProjectWritable,
  projectAccess,
  ProjectWriteLockedError,
} from './projectLock';
import { OAuthPkceService } from './oauthPkce';
import { AccountsService, CreateAccountInput } from './accountsService';
import { AssignmentsService, UpsertAssignmentInput } from './assignmentsService';
import { RouterCandidate, RouterSelection, RouterService } from './routerService';
import { AuditService } from './auditService';
import { TokenVault } from './tokenVault';
import { TokenRefreshService } from './tokenRefreshService';
import { HealthService } from './healthService';
import { RealtimeEventsHub, RealtimeEvent, EmbeddedLogEnricher, OAuthProfileResolver } from './realtimeEvents';
import { BackupService } from './backupService';
import { AccountRuntimeService } from './accountRuntimeService';
import { AccountUsageCacheService } from './accountUsageCacheService';
import { SeedService } from './seedService';
import { parseDailySchedule, millisecondsUntilNextDailyRun } from './backupSchedule';
import { buildOpenApiSpec } from './openapi';
import { z } from 'zod';
import { createHash } from 'crypto';

loadEnv();

const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-api-key',
  'req.headers.proxy-authorization',
  'access_token',
  'refresh_token',
  'token',
  'authorization',
  'api_key',
  'apiKey',
  'password',
  'secret',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// In-memory profile meta store: profileKeyHash (sha256:...) -> { email?, provider?, created_at, plan? }
const profileMetaStore = new Map<string, { email?: string; provider?: string; created_at: string; plan?: string }>();

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').toLowerCase());
}

function validationErrorPayload(target: string, issues: z.ZodIssue[]) {
  return {
    ok: false,
    error: 'validation_error',
    target,
    issues: issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  };
}

function parseWithZod<T>(
  reply: FastifyReply,
  schema: z.ZodType<T>,
  data: unknown,
  target: string,
): T | null {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.code(400).send(validationErrorPayload(target, parsed.error.issues));
    return null;
  }

  return parsed.data;
}

function resolveProjectFromRequest(req: FastifyRequest): string | undefined {
  const headerProject = req.headers['x-project'];

  if (typeof headerProject === 'string' && headerProject.trim()) {
    return headerProject.trim();
  }

  const params = req.params as { project?: string };
  if (params && typeof params.project === 'string' && params.project.trim()) {
    return params.project.trim();
  }

  return undefined;
}

function parseScopeList(scopeRaw?: string): string[] | undefined {
  if (!scopeRaw || !scopeRaw.trim()) {
    return undefined;
  }

  const scopes = scopeRaw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return scopes.length ? scopes : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  const payloadPart = parts[1];
  const base64 = payloadPart
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

  try {
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractOpenAiCodexEmail(accessToken?: string): string | undefined {
  if (!accessToken || !accessToken.trim()) {
    return undefined;
  }

  const payload = decodeJwtPayload(accessToken.trim());
  if (!payload) {
    return undefined;
  }

  const raw = payload['https://api.openai.com/profile.email'] ?? payload.email;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return undefined;
  }

  return email;
}

function nextDefaultProfileId(provider: string, existingProfileIds: string[]): string {
  const prefix = `${provider}:default`;
  const suffixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9]+)$`);

  let baseExists = false;
  let maxSuffix = 0;

  for (const profileId of existingProfileIds) {
    if (profileId === prefix) {
      baseExists = true;
      maxSuffix = Math.max(maxSuffix, 1);
      continue;
    }

    const match = profileId.match(suffixPattern);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n)) {
        maxSuffix = Math.max(maxSuffix, n);
      }
    }
  }

  if (maxSuffix === 0) {
    return prefix;
  }

  if (baseExists && maxSuffix === 1) {
    return `${prefix}-2`;
  }

  return `${prefix}-${maxSuffix + 1}`;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const projectParamSchema = z.object({
  project: z.string().trim().min(1),
});

const actorBodySchema = z.object({
  actor: z.string().trim().min(1).optional(),
}).partial();

function resolveActor(req: FastifyRequest, body?: { actor?: string }): string {
  const headerActor = req.headers['x-actor'];
  if (typeof headerActor === 'string' && headerActor.trim()) {
    return headerActor.trim();
  }

  if (body?.actor && body.actor.trim()) {
    return body.actor.trim();
  }

  return 'system';
}

function renderOauthWizard(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OCOM OAuth Wizard</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: Inter, Segoe UI, Arial, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 720px; margin: 40px auto; background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 24px; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    .hint { color: #94a3b8; font-size: 0.95rem; margin-bottom: 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { font-size: 0.9rem; color: #cbd5e1; display: block; margin-bottom: 6px; }
    input, select, textarea { width: 100%; box-sizing: border-box; background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; }
    textarea { min-height: 80px; resize: vertical; }
    .full { grid-column: 1 / -1; }
    .actions { margin-top: 16px; display: flex; gap: 10px; align-items: center; }
    button { border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; background: #2563eb; color: white; font-weight: 600; }
    .secondary { background: #334155; }
    .endpoint { margin-top: 14px; background: #0b1220; border: 1px dashed #334155; border-radius: 8px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; word-break: break-all; color: #93c5fd; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>OAuth Account Wizard</h1>
    <p class="hint">Alta guiada de cuentas OAuth en OCOM. Este formulario inicia PKCE y guarda tokens cifrados al finalizar el callback.</p>
    <form id="oauthWizard" class="grid">
      <div>
        <label for="provider">Provider</label>
        <input id="provider" name="provider" value="openai-codex" required />
      </div>
      <div>
        <label for="healthScore">Health score inicial</label>
        <input id="healthScore" name="healthScore" type="number" value="100" min="0" max="100" />
      </div>
      <div>
        <label for="accountId">Account ID externo</label>
        <input id="accountId" name="accountId" placeholder="acct-main" />
      </div>
      <div>
        <label for="profileId">Profile ID local</label>
        <input id="profileId" name="profileId" placeholder="openai-codex:default" />
      </div>
      <div class="full">
        <label for="scope">Scopes (espacio o coma)</label>
        <textarea id="scope" name="scope" placeholder="openid profile offline_access"></textarea>
      </div>
      <div class="full actions">
        <button type="button" id="generateLink">Generar link OAuth</button>
        <button type="button" id="copyLink" class="secondary">Copiar link</button>
        <button type="button" id="openLink" class="secondary">Abrir link acÃƒÂ¡</button>
      </div>
    </form>
    <div id="endpoint" class="endpoint"></div>
    <div class="hint" id="statusLine">Tip: copiÃƒÂ¡ este link y abrilo en el perfil de Chrome que quieras.</div>
  </main>
  <script>
    const form = document.getElementById('oauthWizard');
    const endpoint = document.getElementById('endpoint');
    const generateLinkBtn = document.getElementById('generateLink');
    const copyLinkBtn = document.getElementById('copyLink');
    const openLinkBtn = document.getElementById('openLink');
    const statusLine = document.getElementById('statusLine');

    let generatedAuthorizationUrl = '';

    function buildStartApiUrl() {
      const provider = document.getElementById('provider').value.trim();
      const accountId = document.getElementById('accountId').value.trim();
      const profileId = document.getElementById('profileId').value.trim();
      const healthScore = document.getElementById('healthScore').value.trim();
      const scope = document.getElementById('scope').value.trim();

      const url = new URL('/oauth/' + encodeURIComponent(provider) + '/start', window.location.origin);
      url.searchParams.set('store', '1');
      url.searchParams.set('accountId', accountId);
      url.searchParams.set('profileId', profileId);

      if (healthScore) {
        url.searchParams.set('healthScore', healthScore);
      }

      if (scope) {
        url.searchParams.set('scope', scope);
      }

      return url;
    }

    function refreshPreview() {
      if (generatedAuthorizationUrl) {
        endpoint.textContent = generatedAuthorizationUrl;
        return;
      }

      endpoint.textContent = buildStartApiUrl().toString();
    }

    async function copyCurrentLink() {
      if (!validateFields()) {
        refreshPreview();
        return;
      }

      const link = generatedAuthorizationUrl || buildStartApiUrl().toString();

      try {
        await navigator.clipboard.writeText(link);
        statusLine.textContent = 'Ã¢Å“â€¦ Link copiado. Pegalo en el perfil de Chrome que quieras.';
      } catch {
        statusLine.textContent = 'Ã¢Å¡Â Ã¯Â¸Â No pude copiar automÃƒÂ¡tico. Copialo manualmente desde el recuadro.';
      }
    }

    function validateFields() {
      const accountId = document.getElementById('accountId').value.trim();
      const profileId = document.getElementById('profileId').value.trim();

      if (!accountId || !profileId) {
        statusLine.textContent = 'Ã¢Å¡Â Ã¯Â¸Â CompletÃƒÂ¡ accountId y profileId para generar un link vÃƒÂ¡lido.';
        return false;
      }

      return true;
    }

    async function generateLink() {
      if (!validateFields()) {
        generatedAuthorizationUrl = '';
        refreshPreview();
        return;
      }

      try {
        const response = await fetch(buildStartApiUrl().toString());
        const payload = await response.json();

        if (!response.ok || !payload.ok || !payload.authorizationUrl) {
          generatedAuthorizationUrl = '';
          refreshPreview();
          const reason = payload && payload.message ? payload.message : 'No se pudo generar authorizationUrl';
          statusLine.textContent = 'Ã¢ÂÅ’ Error generando link OAuth: ' + reason;
          return;
        }

        generatedAuthorizationUrl = payload.authorizationUrl;
        refreshPreview();
        statusLine.textContent = 'Ã¢Å“â€¦ Link OAuth final generado. Ya podÃƒÂ©s copiarlo y abrirlo en cualquier perfil.';
      } catch (error) {
        generatedAuthorizationUrl = '';
        refreshPreview();
        statusLine.textContent = 'Ã¢ÂÅ’ Error de red generando link OAuth.';
      }
    }

    function openCurrentLink() {
      if (!generatedAuthorizationUrl) {
        statusLine.textContent = 'Ã¢Å¡Â Ã¯Â¸Â Primero generÃƒÂ¡ el link OAuth.';
        return;
      }

      window.location.href = generatedAuthorizationUrl;
    }

    form.addEventListener('input', () => {
      generatedAuthorizationUrl = '';
      refreshPreview();
    });

    generateLinkBtn.addEventListener('click', () => {
      generateLink();
    });

    copyLinkBtn.addEventListener('click', () => {
      copyCurrentLink();
    });

    openLinkBtn.addEventListener('click', () => {
      openCurrentLink();
    });

    refreshPreview();
  </script>
</body>
</html>`;
}

function renderMonitoringBoard(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OCOM Monitor</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0c10;
      --surface: #111318;
      --surface2: #181c24;
      --border: #1e2430;
      --accent: #00d4a1;
      --accent2: #3b82f6;
      --accent3: #f59e0b;
      --danger: #ef4444;
      --text: #e2e8f0;
      --muted: #64748b;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:var(--bg); color:var(--text); font-family:'JetBrains Mono',monospace; font-size:13px; line-height:1.7; min-height:100vh; }
    header { border-bottom:1px solid var(--border); padding:20px 32px; display:flex; align-items:center; gap:12px; position:sticky; top:0; background:rgba(10,12,16,0.92); backdrop-filter:blur(12px); z-index:100; }
    .logo { font-family:'Syne',sans-serif; font-weight:800; font-size:18px; color:var(--accent); letter-spacing:-0.5px; }
    .logo span { color:var(--muted); font-weight:400; }
    main { max-width:1200px; margin:24px auto; padding:0 20px; }
    .wrap { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .full { grid-column:1 / -1; }
    h2 { font-family:'Syne',sans-serif; font-size:14px; font-weight:700; color:#fff; margin:18px 0 10px; display:flex; align-items:center; gap:8px; }
    h2::before { content:''; display:inline-block; width:3px; height:14px; background:var(--accent); border-radius:2px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:16px; }
    .grid-4 { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; }
    .tile { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:14px 16px; text-align:center; }
    .tile .val { font-family:'Syne',sans-serif; font-size:28px; font-weight:800; color:var(--accent); }
    .tile .lbl { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.6px; margin-top:4px; }
    .alert-ok { color:var(--accent); }
    .alert-warn { color:var(--accent3); }
    .alert-crit { color:var(--danger); }
    table { width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border); border-radius:8px; overflow:hidden; font-size:11.5px; }
    thead tr { background:var(--surface2); }
    th { text-align:left; padding:8px 10px; font-family:'Syne',sans-serif; font-size:10px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.6px; border-bottom:1px solid var(--border); }
    td { padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
    tr:last-child td { border-bottom:none; }
    tr:hover td { background:rgba(255,255,255,0.02); }
    .bad { color:var(--danger); }
    code { background:var(--surface2); padding:2px 6px; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:11px; }
    .section { margin-bottom:16px; }
    .meta { color:var(--muted); font-size:11px; margin-top:8px; }
    ul { list-style:none; padding:0; margin:0; }
    li { padding:6px 0; border-bottom:1px dashed var(--border); display:flex; flex-direction:column; gap:4px; }
    li:last-child { border-bottom:none; }
    .ts { color:var(--muted); font-size:11px; }
  </style>
</head>
<body>
<header>
  <div class="logo">OpenClaw <span>/ monitor</span></div>
  <div class="badge">personal-provider</div>
</header>
<main>
  <div class="wrap">
    <div class="section full">
      <h2>Estado general</h2>
      <div class="grid-4">
        <div class="tile"><div class="val" id="vActive">0</div><div class="lbl">Active</div></div>
        <div class="tile"><div class="val" id="vDegraded">0</div><div class="lbl">Degraded</div></div>
        <div class="tile"><div class="val" id="vFailover">0</div><div class="lbl">Failover</div></div>
        <div class="tile"><div class="val" id="vExpired">0</div><div class="lbl">Expired</div></div>
      </div>
    </div>

    <div class="section">
      <h2>Alertas recientes</h2>
      <div class="card">
        <ul id="alertsList"></ul>
        <div class="meta" id="wsMeta">Conectando a /ws/events...</div>
      </div>
    </div>

    <div class="section">
      <h2>Semáforo de cuentas (runtime)</h2>
      <div class="card">
        <table>
          <thead>
            <tr><th>Profile</th><th>Estado</th><th>Reset</th><th>Score</th></tr>
          </thead>
          <tbody id="runtimeTable"></tbody>
        </table>
        <div class="meta">Fuente: /accounts/runtime?provider=openai-codex</div>
      </div>
    </div>

    <div class="section full">
      <h2>Eventos recientes (formato GMT-3)</h2>
      <div class="card">
        <table>
          <thead>
            <tr><th style="width:140px;">Timestamp</th><th>Tipo</th><th>Payload (resumido)</th></tr>
          </thead>
          <tbody id="eventsTable"></tbody>
        </table>
      </div>
    </div>
  </div>
</main>

<script>
  const state = { active:0, degraded:0, failover:0, expired:0 };
  const alerts = []; const events = []; const runtimeRows = [];
  const el = {
    active: document.getElementById('vActive'),
    degraded: document.getElementById('vDegraded'),
    failover: document.getElementById('vFailover'),
    expired: document.getElementById('vExpired'),
    alertsList: document.getElementById('alertsList'),
    eventsTable: document.getElementById('eventsTable'),
    runtimeTable: document.getElementById('runtimeTable'),
    wsMeta: document.getElementById('wsMeta')
  };

  // Formato GMT-3: yyyy-MM-dd HH:mm:ss
  function fmtGMt3(date) {
    const d = new Date(date);
    const ofsOffset = -3; // ART
    const offsetMs = d.getTimezoneOffset() * 60000;
    const local = new Date(d.getTime() + offsetMs + (ofsOffset*60000));
    const yyyy = local.getFullYear();
    const MM = String(local.getMonth()+1).padStart(2,'0');
    const dd = String(local.getDate()).padStart(2,'0');
    const HH = String(local.getHours()).padStart(2,'0');
    const mm = String(local.getMinutes()).padStart(2,'0');
    const ss = String(local.getSeconds()).padStart(2,'0');
    return \`\${yyyy}-\${MM}-\${dd} \${HH}:\${mm}:\${ss}\`;
  }

  function shortPayload(p) {
    if (!p) return '-';
    if (typeof p === 'object') {
      if ( Array.isArray(p) ) return \`Array(\${p.length})\`;
      const keys = Object.keys(p).slice(0,3);
      return '{' + keys.map(k=>\`\${k}:\${JSON.stringify(p[k]).slice(0,30)}\`).join(', ') + (Object.keys(p).length>3?'Ã¢â‚¬Â¦':'') + '}';
    }
    return String(p).slice(0,80);
  }

  function render() {
    el.active.textContent = state.active;
    el.degraded.textContent = state.degraded;
    el.failover.textContent = state.failover;
    el.expired.textContent = state.expired;

    // Alerts as list
    el.alertsList.innerHTML = '';
    if (!alerts.length) {
      el.alertsList.innerHTML = '<li class="alert-ok">Sin alertas crÃƒÂ­ticas.</li>';
    } else {
      alerts.slice(-12).reverse().forEach(a => {
        const li = document.createElement('li');
        li.className = a.level === 'crit' ? 'alert-crit' : (a.level === 'warn' ? 'alert-warn' : 'alert-ok');
        li.innerHTML = '<span class="ts">' + fmtGMt3(a.ts) + '</span> ' + a.text;
        el.alertsList.appendChild(li);
      });
    }

    // Runtime table
    el.runtimeTable.innerHTML = '';
    runtimeRows.forEach(row => {
      const tr = document.createElement('tr');
      const state = row.runtime?.state || 'unknown';
      const level = state==='healthy'?'ok':(state==='degraded'?'warn':'crit');
      const reset = row.runtime?.exhaustedUntil || '-';
      const score = row.runtime?.healthScore ?? '-';
      tr.innerHTML = '<td><code>' + (row.profileId||'-') + '</code></td>' +
        '<td class="' + level + '">' + state + '</td>' +
        '<td>' + reset + '</td>' +
        '<td>' + score + '</td>';
      el.runtimeTable.appendChild(tr);
    });

    // Events table
    el.eventsTable.innerHTML = '';
    events.slice(-50).reverse().forEach(ev => {
      const tr = document.createElement('tr');
      const ts = fmtGMt3(ev.ts || Date.now());
      const type = ev.type || '-';
      const payload = shortPayload(ev.payload);
      tr.innerHTML = '<td class="ts">' + ts + '</td><td><code>' + type + '</code></td><td style="font-family:JetBrains Mono; font-size:11.5px;">' + payload + '</td>';
      el.eventsTable.appendChild(tr);
    });
  }

  function pushAlert(level, text) {
    alerts.push({ level, text, ts: Date.now() });
  }

  function handleEvent(event) {
    if (!event || !event.type) return;
    events.push(event);
    event.ts = event.timestamp || event.ts || Date.now();

    if (event.type === 'health.run' || event.type === 'health.scoring.completed') {
      const p = event.payload || {};
      state.active = Number(p.active || 0);
      state.degraded = Number(p.degraded || 0);
      state.failover = Number(p.failover || 0);
      state.expired = Number(p.expired || 0);
      if (Number(p.failover || 0) > 0) pushAlert('crit', 'Cuentas en failover: ' + p.failover);
      if (Number(p.degraded || 0) > 0) pushAlert('warn', 'Cuentas degradadas: ' + p.degraded);
    }

    if (event.type === 'tokens.refresh.run' || event.type === 'tokens.refresh.completed') {
      const p = event.payload || {};
      if (Number(p.failed || 0) > 0) pushAlert('warn', 'Fallos en refresh: ' + p.failed);
    }

    if (event.type === 'account.runtime.event' || event.type === 'account.runtime.recovered') {
      loadRuntime();
    }

    render();
  }

  async function loadRuntime() {
    try {
      const res = await fetch('/accounts/runtime?provider=openai-codex');
      const j = await res.json();
      runtimeRows.length = 0;
      (j.accounts || []).forEach(a => runtimeRows.push(a));
    } catch {}
    render();
  }

  async function bootstrapRecent() {
    try {
      const res = await fetch('/events/recent?limit=40');
      const j = await res.json();
      (j.events || []).forEach(handleEvent);
    } catch {
      pushAlert('warn', 'No se pudieron cargar eventos iniciales.');
    }
    render();
  }

  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + location.host + '/ws/events?replay=40';
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => { el.wsMeta.textContent = 'Conectado en tiempo real'; };
    ws.onmessage = (msg) => {
      try { handleEvent(JSON.parse(msg.data)); } catch {}
    };
    ws.onclose = () => { el.wsMeta.textContent = 'Desconectado, reintentando en 2s...'; setTimeout(connectWs, 2000); };
    ws.onerror = () => ws.close();
  }

  bootstrapRecent().then(() => {
    loadRuntime();
    connectWs();
    setInterval(loadRuntime, 60_000);
  });
</script>
</body>
</html>`;
}

function renderAccountsStatusBoard(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OCOM Accounts Status</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, Segoe UI, Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
    h1 { margin-bottom: 8px; }
    .hint { color: #94a3b8; margin-bottom: 16px; }
    .bar { display:flex; gap:8px; margin-bottom: 12px; align-items:center; }
    input, button { background:#0b1220; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:8px 10px; }
    button { cursor:pointer; background:#2563eb; border:0; }
    table { width:100%; border-collapse: collapse; background:#111827; border:1px solid #1f2937; border-radius:10px; overflow:hidden; }
    th, td { border-bottom:1px solid #1f2937; padding:10px; text-align:left; font-size:0.9rem; }
    th { color:#94a3b8; }
    .ok { color:#34d399; }
    .warn { color:#f59e0b; }
    .crit { color:#f87171; }
    .meta { margin-top: 8px; color:#94a3b8; font-size:0.9rem; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Accounts & Runtime Status</h1>
    <p class="hint">Listado completo de cuentas y su estado actual.</p>
    <div class="bar">
      <input id="provider" placeholder="provider (ej: openai-codex)" value="openai-codex" />
      <button id="refresh">Actualizar</button>
      <button id="probe">Probar cuota ahora</button>
    </div>
    <div class="meta" id="activeOauthMeta">OAuth actual: cargando...</div>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Provider</th><th>Account</th><th>Profile</th><th>Status</th><th>Runtime</th><th>Cuota</th><th>Uso %</th><th>ÃƒÅ¡ltima actualizaciÃƒÂ³n</th><th>Health</th><th>Locked</th><th>Expires</th><th>Reset at</th><th>ÃƒÅ¡ltimo error</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="meta" id="meta">Cargando...</div>

    <h2 style="margin-top:22px;">Cuentas en uso ahora (por agente)</h2>
    <table>
      <thead>
        <tr>
          <th>Agent</th><th>Modo</th><th>Prioridad</th><th>Cuenta</th><th>Profile</th><th>Estado asignaciÃƒÂ³n</th><th>Health</th><th>Cuota</th><th>Uso %</th><th>ÃƒÅ¡lt. actualizaciÃƒÂ³n</th>
        </tr>
      </thead>
      <tbody id="assignRows"></tbody>
    </table>
    <div class="meta" id="assignMeta">Cargando asignaciones...</div>

    <h2 style="margin-top:22px;">Cuentas sin asignaciÃƒÂ³n</h2>
    <table>
      <thead>
        <tr>
          <th>Cuenta</th><th>Profile</th><th>Cuota</th><th>Uso %</th><th>ÃƒÅ¡lt. actualizaciÃƒÂ³n</th>
        </tr>
      </thead>
      <tbody id="unassignedRows"></tbody>
    </table>
    <div class="meta" id="unassignedMeta">Cargando...</div>
  </main>

  <script>
    const providerInput = document.getElementById('provider');
    const refreshBtn = document.getElementById('refresh');
    const probeBtn = document.getElementById('probe');
    const rowsEl = document.getElementById('rows');
    const metaEl = document.getElementById('meta');
    const assignRowsEl = document.getElementById('assignRows');
    const assignMetaEl = document.getElementById('assignMeta');
    const unassignedRowsEl = document.getElementById('unassignedRows');
    const unassignedMetaEl = document.getElementById('unassignedMeta');
    const activeOauthMetaEl = document.getElementById('activeOauthMeta');

    function levelClass(runtime) {
      if (runtime === 'healthy') return 'ok';
      if (runtime === 'degraded') return 'warn';
      return 'crit';
    }

    function quotaFromData(item, usage) {
      if (item.locked || item.status === 'revoked') return 'no';
      if (!usage) return 'unknown';
      if (usage.allowed === false || usage.limitReached === true) return 'no';
      if (usage.allowed === true) return 'yes';
      return 'unknown';
    }

    function extractEmailFromAccount(account) {
      const profile = (account && account.profileId ? String(account.profileId) : '').trim();
      const accountId = (account && account.accountId ? String(account.accountId) : '').trim();
      const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

      if (profile.includes(':')) {
        const suffix = profile.slice(profile.indexOf(':') + 1).trim().toLowerCase();
        if (emailRegex.test(suffix)) {
          return suffix;
        }
      }

      const normalizedAccountId = accountId.toLowerCase();
      if (emailRegex.test(normalizedAccountId)) {
        return normalizedAccountId;
      }

      return null;
    }

    async function loadActiveOauth() {
      activeOauthMetaEl.textContent = 'OAuth actual: cargando...';
      try {
        const provider = providerInput.value.trim() || 'openai-codex';
        const response = await fetch('/agents/florencia/active-account?provider=' + encodeURIComponent(provider));
        const payload = await response.json();

        if (!response.ok || !payload.ok || !payload.account) {
          const reason = payload.error || response.statusText || 'sin cuenta activa';
          activeOauthMetaEl.textContent = 'OAuth actual: no disponible (' + reason + ')';
          return;
        }

        const account = payload.account;
        const email = extractEmailFromAccount(account);
        const providerName = account.provider || provider || '-';
        const profileId = account.profileId || '-';

        activeOauthMetaEl.textContent = 'OAuth actual (' + providerName + '): ' + (email || 'email no identificado') + ' Ã‚Â· profile=' + profileId;
      } catch {
        activeOauthMetaEl.textContent = 'OAuth actual: error al consultar cuenta activa';
      }
    }

    async function loadAssignments() {
      assignRowsEl.innerHTML = '';
      unassignedRowsEl.innerHTML = '';
      assignMetaEl.textContent = 'Cargando asignaciones...';
      unassignedMetaEl.textContent = 'Cargando...';
      try {
        const provider = providerInput.value.trim() || 'openai-codex';
        const [assignRes, usageRes, runtimeRes] = await Promise.all([
          fetch('/assignments'),
          fetch('/accounts/wham/usage?provider=' + encodeURIComponent(provider)),
          fetch('/accounts/runtime?provider=' + encodeURIComponent(provider)),
        ]);
        const payload = await assignRes.json();
        const usagePayload = await usageRes.json();
        const runtimePayload = await runtimeRes.json();
        const items = payload.assignments || [];
        const usageById = Object.fromEntries((usagePayload.accounts || []).map((x) => [String(x.id), x]));
        const runtimeById = Object.fromEntries((runtimePayload.accounts || []).map((x) => [String(x.id), x]));

        if (!items.length) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td colspan="10">Sin asignaciones.</td>';
          assignRowsEl.appendChild(tr);
        } else {
          for (const a of items) {
            const tr = document.createElement('tr');
            const usage = usageById[String(a.accountId)] || null;
            const quota = usage ? ((usage.allowed === false || usage.limitReached === true) ? 'no' : (usage.allowed === true ? 'yes' : 'unknown')) : 'unknown';
            const usedPercent = usage?.usedPercent;
            const checkedAt = usage?.checkedAt || '-';
            tr.innerHTML = '' +
              '<td>' + a.agentSlug + '</td>' +
              '<td>' + a.mode + '</td>' +
              '<td>' + a.priority + '</td>' +
              '<td>' + (a.account?.accountId || '-') + '</td>' +
              '<td>' + (a.account?.profileId || '-') + '</td>' +
              '<td>' + (a.account?.status || '-') + '</td>' +
              '<td>' + (a.account?.healthScore ?? '-') + '</td>' +
              '<td>' + quota + '</td>' +
              '<td>' + (usedPercent == null ? '-' : (usedPercent + '%')) + '</td>' +
              '<td>' + checkedAt + '</td>';
            assignRowsEl.appendChild(tr);
          }
        }

        const assignedIds = new Set(items.map((a) => String(a.accountId)));
        const unassigned = (usagePayload.accounts || []).filter((x) => {
          if (assignedIds.has(String(x.id))) return false;
          const runtime = runtimeById[String(x.id)];
          if (!runtime) return false;
          if (runtime.locked) return false;
          if (runtime.status && runtime.status !== 'active') return false;
          return true;
        });

        if (!unassigned.length) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td colspan="5">Sin cuentas sin asignaciÃƒÂ³n.</td>';
          unassignedRowsEl.appendChild(tr);
        } else {
          for (const u of unassigned) {
            const tr = document.createElement('tr');
            const quota = (u.allowed === false || u.limitReached === true) ? 'no' : (u.allowed === true ? 'yes' : 'unknown');
            tr.innerHTML = '' +
              '<td>' + (u.accountId || '-') + '</td>' +
              '<td>' + (u.profileId || '-') + '</td>' +
              '<td>' + quota + '</td>' +
              '<td>' + (u.usedPercent == null ? '-' : (u.usedPercent + '%')) + '</td>' +
              '<td>' + (u.checkedAt || '-') + '</td>';
            unassignedRowsEl.appendChild(tr);
          }
        }

        assignMetaEl.textContent = 'Actualizado: ' + new Date().toLocaleTimeString() + ' Ã‚Â· asignaciones: ' + items.length;
        unassignedMetaEl.textContent = 'Cuentas sin asignaciÃƒÂ³n: ' + unassigned.length;
      } catch {
        assignMetaEl.textContent = 'Error cargando asignaciones';
        unassignedMetaEl.textContent = 'Error cargando cuentas sin asignaciÃƒÂ³n';
      }
    }

    async function loadAccounts() {
      rowsEl.innerHTML = '';
      metaEl.textContent = 'Cargando...';

      const provider = providerInput.value.trim();
      const query = provider ? ('?provider=' + encodeURIComponent(provider)) : '';

      try {
        const [runtimeRes, usageRes] = await Promise.all([
          fetch('/accounts/runtime' + query),
          fetch('/accounts/wham/usage' + query),
        ]);
        const payload = await runtimeRes.json();
        const usagePayload = await usageRes.json();
        const items = payload.accounts || [];
        const usageById = Object.fromEntries((usagePayload.accounts || []).map((x) => [String(x.id), x]));

        if (!items.length) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td colspan="14">Sin cuentas para ese provider.</td>';
          rowsEl.appendChild(tr);
          metaEl.textContent = 'Sin resultados';
          return;
        }

        for (const item of items) {
          const tr = document.createElement('tr');
          const runtimeState = item.runtime?.state || 'unknown';
          const runtimeClass = levelClass(runtimeState);
          const usage = usageById[String(item.id)] || null;
          const quota = quotaFromData(item, usage);
          const quotaClass = quota === 'yes' ? 'ok' : (quota === 'unknown' ? 'warn' : 'crit');
          const lastError = item.runtime?.lastErrorCode || item.runtime?.lastErrorMessage || '-';
          const usedPercent = (usage.usedPercent ?? usage.rateLimit?.usedPercent ?? null);
          const updatedAt = usage.checkedAt || item.runtime?.updatedAt || '-';

          tr.innerHTML = '' +
            '<td>' + item.id + '</td>' +
            '<td>' + item.provider + '</td>' +
            '<td>' + item.accountId + '</td>' +
            '<td>' + item.profileId + '</td>' +
            '<td>' + item.status + '</td>' +
            '<td class="' + runtimeClass + '">' + runtimeState + '</td>' +
            '<td class="' + quotaClass + '">' + quota + '</td>' +
            '<td>' + (usedPercent == null ? '-' : (usedPercent + '%')) + '</td>' +
            '<td>' + updatedAt + '</td>' +
            '<td>' + item.healthScore + '</td>' +
            '<td>' + (item.locked ? 'yes' : 'no') + '</td>' +
            '<td>' + (item.expiresAt || '-') + '</td>' +
            '<td>' + (item.runtime?.exhaustedUntil || '-') + '</td>' +
            '<td>' + lastError + '</td>';

          rowsEl.appendChild(tr);
        }

        const usageSource = usagePayload.source || 'unknown';
        const usageCheckedAt = usagePayload.checkedAt || '-';
        metaEl.textContent = 'Actualizado: ' + new Date().toLocaleTimeString() + ' Ã‚Â· cuentas: ' + items.length + ' Ã‚Â· usage=' + usageSource + ' Ã‚Â· checkedAt=' + usageCheckedAt;
      } catch {
        metaEl.textContent = 'Error cargando cuentas/runtime';
      }
    }

    refreshBtn.addEventListener('click', async () => {
      await loadAccounts();
      await loadActiveOauth();
    });
    probeBtn.addEventListener('click', async () => {
      const provider = providerInput.value.trim();
      metaEl.textContent = 'Probando cuota real por cuenta...';
      try {
        const response = await fetch('/accounts/runtime/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const payload = await response.json();
        if (!response.ok) {
          metaEl.textContent = 'Error en probe: ' + (payload.message || response.statusText);
          return;
        }
        metaEl.textContent = 'Probe ejecutado Ã‚Â· ' + (payload.summary?.total || 0) + ' cuentas';
        await loadAccounts();
        await loadActiveOauth();
      } catch {
        metaEl.textContent = 'Error ejecutando probe de cuota';
      }
    });
    providerInput.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        await loadAccounts();
        await loadActiveOauth();
      }
    });

    loadAccounts();
    loadAssignments();
    loadActiveOauth();
    setInterval(loadAccounts, 60_000);
    setInterval(loadAssignments, 60_000);
    setInterval(loadActiveOauth, 60_000);
  </script>
</body>
</html>`;
}

export function createServer() {
  const pkce = new OAuthPkceService();
  const dbPath = process.env.DATABASE_PATH || './data/ocom.db';
  const masterKey = process.env.TOKEN_VAULT_MASTER_KEY || process.env.MASTER_KEY || 'changeme-please-generate-strong-key';
  const accounts = new AccountsService(dbPath, new TokenVault(masterKey));
  const assignments = new AssignmentsService(dbPath);
  const router = new RouterService(assignments);
  const audit = new AuditService(dbPath, process.env.AUDIT_HMAC_KEY || masterKey);
  const tokenRefresh = new TokenRefreshService(accounts);
  const healthService = new HealthService(accounts);
  const enricher = new EmbeddedLogEnricher();
  const profileResolver = new OAuthProfileResolver(profileMetaStore);
  const events = new RealtimeEventsHub(200, profileMetaStore, enricher, profileResolver);
  const backupDir = process.env.BACKUP_DIR || './data/backups';
  const backupService = new BackupService(dbPath, backupDir);
  const seedService = new SeedService(dbPath);
  const runtimeResetHoursRaw = Number(process.env.ACCOUNT_EXHAUSTED_RESET_HOURS || '24');
  const runtimeResetHours = Number.isFinite(runtimeResetHoursRaw)
    ? Math.max(1, Math.floor(runtimeResetHoursRaw))
    : 24;
  const accountRuntime = new AccountRuntimeService(dbPath, runtimeResetHours);
  const usageCache = new AccountUsageCacheService(dbPath);
  const refreshIntervalMsRaw = Number(process.env.TOKEN_REFRESH_INTERVAL_MS || '0');
  const refreshIntervalMs = Number.isFinite(refreshIntervalMsRaw) ? Math.max(0, Math.floor(refreshIntervalMsRaw)) : 0;
  const healthIntervalMinutesRaw = Number(process.env.HEALTH_CHECK_INTERVAL_MINUTES || '0');
  const healthIntervalMs = Number.isFinite(healthIntervalMinutesRaw)
    ? Math.max(0, Math.floor(healthIntervalMinutesRaw * 60_000))
    : 0;
  const backupIntervalHoursRaw = Number(process.env.BACKUP_INTERVAL_HOURS || '24');
  const backupIntervalMs = Number.isFinite(backupIntervalHoursRaw)
    ? Math.max(0, Math.floor(backupIntervalHoursRaw * 60 * 60_000))
    : 0;
  const backupDailySchedule = parseDailySchedule(process.env.BACKUP_DAILY_AT || '03:00');
  const runtimeRecoverIntervalMinRaw = Number(process.env.ACCOUNT_RUNTIME_RECOVER_INTERVAL_MINUTES || '15');
  const runtimeRecoverIntervalMs = Number.isFinite(runtimeRecoverIntervalMinRaw)
    ? Math.max(0, Math.floor(runtimeRecoverIntervalMinRaw * 60_000))
    : 0;
  const accountVerifyIntervalMinRaw = Number(process.env.ACCOUNT_VERIFY_INTERVAL_MINUTES || '30');
  const accountVerifyIntervalMs = Number.isFinite(accountVerifyIntervalMinRaw)
    ? Math.max(0, Math.floor(accountVerifyIntervalMinRaw * 60_000))
    : 0;
  const singleAgentMode = isTruthyEnv(process.env.SINGLE_AGENT_MODE);
  const singleAgentSlug = (process.env.SINGLE_AGENT_SLUG || 'florencia').trim() || 'florencia';
  const agentPermissionsEnabled = isTruthyEnv(process.env.AGENT_PERMISSIONS_ENABLED);
  const appPortRaw = Number(process.env.PORT || '3001');
  const appPort = Number.isFinite(appPortRaw) ? Math.max(1, Math.floor(appPortRaw)) : 3001;
  const callbackBridgeEnabled = process.env.NODE_ENV === 'test'
    ? false
    : isTruthyEnv(process.env.OAUTH_CALLBACK_BRIDGE_ENABLED || 'true');
  const callbackBridgePortRaw = Number(process.env.OAUTH_CALLBACK_BRIDGE_PORT || '1455');
  const callbackBridgePort = Number.isFinite(callbackBridgePortRaw)
    ? Math.max(0, Math.floor(callbackBridgePortRaw))
    : 1455;
  const gatewayApiToken = (
    process.env.GATEWAY_API_TOKEN
    || process.env.OPENCLAW_GATEWAY_TOKEN
    || process.env.API_TOKEN
    || ''
  ).trim();

  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: {
        paths: LOG_REDACT_PATHS,
        censor: '[REDACTED]',
      },
      serializers: {
        req(req) {
          return sanitizeForLog({
            method: req.method,
            url: req.url.split('?')[0],
            headers: req.headers,
            remoteAddress: req.ip,
          });
        },
        err(err) {
          return sanitizeForLog({
            type: err.name,
            message: err.message,
            stack: err.stack || '',
          });
        },
      },
    },
  });
server.get('/profiles/:sha256/meta', async (req, reply) => {
  const params = parseWithZod(
    reply,
    z.object({ sha256: z.string().min(10) }),
    req.params || {},
    'params'
  );
  if (!params) return;

  const meta = profileMetaStore.get(params.sha256);
  if (!meta) {
    return reply.code(404).send({ ok: false, error: 'profile_not_found' });
  }
  return { ok: true, meta };
});

  server.register(helmet, {
    // Allow inline scripts in local UI pages rendered from template strings.
    // (wizard + monitor rely on inline <script> blocks)
    contentSecurityPolicy: false,
  });
  server.register(cors, {
    origin: '*',
  });

  let refreshTimer: NodeJS.Timeout | null = null;
  if (refreshIntervalMs > 0) {
    refreshTimer = setInterval(() => {
      tokenRefresh.runOnce().then((result) => {
        if (!result.scanned) {
          return;
        }

        server.log.info({
          scanned: result.scanned,
          refreshed: result.refreshed,
          failed: result.failed,
        }, 'token refresh run completed');

        events.publish('tokens.refresh.completed', {
          source: 'interval',
          scanned: result.scanned,
          refreshed: result.refreshed,
          failed: result.failed,
        });
      }).catch((error) => {
        server.log.error({ err: error }, 'token refresh run failed');
      });
    }, refreshIntervalMs);

    if (typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  let healthTimer: NodeJS.Timeout | null = null;
  if (healthIntervalMs > 0) {
    healthTimer = setInterval(() => {
      healthService.runOnce().then((result) => {
        if (!result.scanned) {
          return;
        }

        server.log.info({
          scanned: result.scanned,
          updated: result.updated,
          active: result.active,
          degraded: result.degraded,
          failover: result.failover,
          expired: result.expired,
          revoked: result.revoked,
        }, 'health scoring run completed');

        events.publish('health.scoring.completed', {
          source: 'interval',
          scanned: result.scanned,
          updated: result.updated,
          active: result.active,
          degraded: result.degraded,
          failover: result.failover,
          expired: result.expired,
          revoked: result.revoked,
        });
      }).catch((error) => {
        server.log.error({ err: error }, 'health scoring run failed');
      });
    }, healthIntervalMs);

    if (typeof healthTimer.unref === 'function') {
      healthTimer.unref();
    }
  }

  const runBackupJob = (source: 'interval' | 'daily') => {
    try {
      const artifact = backupService.runBackup();

      server.log.info({
        source,
        file: artifact.file,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      }, 'database backup completed');

      events.publish('backup.completed', {
        source,
        file: artifact.file,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      });
    } catch (error) {
      server.log.error({ err: error }, 'database backup failed');
    }
  };

  let backupTimer: NodeJS.Timeout | null = null;
  let backupDailyKickoff: NodeJS.Timeout | null = null;

  if (backupIntervalMs > 0) {
    if (backupDailySchedule) {
      const initialDelay = millisecondsUntilNextDailyRun(backupDailySchedule);
      const dayMs = 24 * 60 * 60_000;

      backupDailyKickoff = setTimeout(() => {
        runBackupJob('daily');

        backupTimer = setInterval(() => {
          runBackupJob('daily');
        }, dayMs);

        if (backupTimer && typeof backupTimer.unref === 'function') {
          backupTimer.unref();
        }
      }, initialDelay);

      server.log.info({
        backupDailyAt: `${String(backupDailySchedule.hour).padStart(2, '0')}:${String(backupDailySchedule.minute).padStart(2, '0')}`,
        firstRunInMs: initialDelay,
      }, 'database backup daily schedule configured');

      if (typeof backupDailyKickoff.unref === 'function') {
        backupDailyKickoff.unref();
      }
    } else {
      backupTimer = setInterval(() => {
        runBackupJob('interval');
      }, backupIntervalMs);

      if (typeof backupTimer.unref === 'function') {
        backupTimer.unref();
      }
    }
  }

  let callbackBridgeServer: http.Server | null = null;
  if (callbackBridgeEnabled && callbackBridgePort > 0 && callbackBridgePort !== appPort) {
    callbackBridgeServer = http.createServer((req, res) => {
      try {
        const host = req.headers.host || `localhost:${callbackBridgePort}`;
        const sourceUrl = new URL(req.url || '/', `http://${host}`);

        if (sourceUrl.pathname !== '/auth/callback') {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('Not found');
          return;
        }

        const target = new URL(`http://127.0.0.1:${appPort}/oauth/openai-codex/callback`);
        target.search = sourceUrl.search;

        res.statusCode = 302;
        res.setHeader('Location', target.toString());
        res.end();
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Callback bridge error');
      }
    });

    callbackBridgeServer.on('error', (error) => {
      server.log.error({ err: error, callbackBridgePort }, 'oauth callback bridge failed');
    });

    callbackBridgeServer.listen(callbackBridgePort, '127.0.0.1', () => {
      server.log.info({ callbackBridgePort }, 'oauth callback bridge listening');
    });
  }

  let runtimeRecoverTimer: NodeJS.Timeout | null = null;
  let accountVerifyTimer: NodeJS.Timeout | null = null;
  if (runtimeRecoverIntervalMs > 0) {
    runtimeRecoverTimer = setInterval(() => {
      accountRuntime.recoverDue().then((recovered) => {
        if (!recovered.length) {
          return;
        }

        for (const item of recovered) {
          events.publish('account.runtime.recovered', {
            accountId: item.accountId,
            state: item.state,
          });
        }

        server.log.info({ recovered: recovered.length }, 'account runtime auto-recovery completed');
      }).catch((error) => {
        server.log.error({ err: error }, 'account runtime auto-recovery failed');
      });
    }, runtimeRecoverIntervalMs);

    if (typeof runtimeRecoverTimer.unref === 'function') {
      runtimeRecoverTimer.unref();
    }
  }

  server.addHook('onClose', async () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }

    if (backupDailyKickoff) {
      clearTimeout(backupDailyKickoff);
      backupDailyKickoff = null;
    }

    if (backupTimer) {
      clearInterval(backupTimer);
      backupTimer = null;
    }

    if (runtimeRecoverTimer) {
      clearInterval(runtimeRecoverTimer);
      runtimeRecoverTimer = null;
    }

    if (accountVerifyTimer) {
      clearInterval(accountVerifyTimer);
      accountVerifyTimer = null;
    }

    if (callbackBridgeServer) {
      await new Promise<void>((resolve) => {
        callbackBridgeServer?.close(() => resolve());
      });
      callbackBridgeServer = null;
    }
  });

  // Lock protected projects (e.g. reel) in read-only mode for any mutating method.
  server.addHook('preHandler', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }

    const project = resolveProjectFromRequest(request);
    if (!project) {
      return;
    }

    try {
      assertProjectWritable(project);
    } catch (error) {
      if (error instanceof ProjectWriteLockedError) {
        return reply.code(423).send({
          ok: false,
          error: 'project_locked',
          project,
          mode: 'read-only',
          message: error.message,
        });
      }
      throw error;
    }
  });

  const resolveHeaderAgentSlug = (request: FastifyRequest): string | undefined => {
    const raw = request.headers['x-agent-slug'];
    if (typeof raw !== 'string') {
      return undefined;
    }

    const normalized = raw.trim();
    return normalized ? normalized : undefined;
  };

  const enforceAgentSlugPermission = (
    request: FastifyRequest,
    reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
    targetAgentSlug: string,
  ): boolean => {
    if (!agentPermissionsEnabled) {
      return true;
    }

    const callerAgentSlug = resolveHeaderAgentSlug(request);
    if (!callerAgentSlug) {
      reply.code(401).send({
        ok: false,
        error: 'missing_agent_slug_header',
        requiredHeader: 'x-agent-slug',
      });
      return false;
    }

    if (callerAgentSlug !== targetAgentSlug) {
      reply.code(403).send({
        ok: false,
        error: 'agent_slug_forbidden',
        expected: targetAgentSlug,
        received: callerAgentSlug,
      });
      return false;
    }

    return true;
  };

  const resolvePresentedApiToken = (request: FastifyRequest): string | undefined => {
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.trim()) {
      return apiKey.trim();
    }

    const authorization = request.headers.authorization;
    if (typeof authorization === 'string') {
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (match && match[1].trim()) {
        return match[1].trim();
      }
    }

    return undefined;
  };

  const requireGatewayApiToken = (
    request: FastifyRequest,
    reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  ): boolean => {
    if (!gatewayApiToken) {
      reply.code(503).send({
        ok: false,
        error: 'gateway_api_token_not_configured',
        message: 'Set GATEWAY_API_TOKEN (or OPENCLAW_GATEWAY_TOKEN) to use this endpoint.',
      });
      return false;
    }

    const presented = resolvePresentedApiToken(request);
    if (!presented || presented !== gatewayApiToken) {
      reply.code(401).send({
        ok: false,
        error: 'unauthorized',
      });
      return false;
    }

    return true;
  };

  const applyRuntimeRouting = async (selection: RouterSelection): Promise<RouterSelection> => {
    if (!selection.candidates.length) {
      return selection;
    }

    const runtimeById = await accountRuntime.listByAccountId(selection.candidates.map((candidate) => candidate.accountId));

    const ranked = [...selection.candidates].sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      if (a.healthScore !== b.healthScore) {
        return b.healthScore - a.healthScore;
      }

      return a.assignmentId - b.assignmentId;
    });

    const selectable = ranked.filter((candidate) => {
      const runtime = runtimeById[candidate.accountId];
      if (runtime?.state === 'exhausted') {
        return false;
      }

      return candidate.class !== 'excluded';
    });

    if (!selectable.length) {
      return {
        ...selection,
        ok: false,
        selected: null,
        failoverApplied: false,
        reason: 'no_runtime_eligible_accounts',
      };
    }

    // CLW-A02 (MVP): when provider is not explicitly requested,
    // rotate across openai-codex profiles before falling back to other providers/models.
    let rotationPool = selectable;
    if (!selection.provider) {
      const codexPool = selectable.filter((candidate) => candidate.provider === 'openai-codex');
      if (codexPool.length) {
        rotationPool = codexPool;
      }
    }

    const selected = rotationPool[0] as RouterCandidate;

    return {
      ...selection,
      ok: true,
      selected,
      failoverApplied: selected.status !== 'active'
        || (selection.selected ? selection.selected.accountId !== selected.accountId : false),
      reason: undefined,
    };
  };

  server.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OCOM Ã‚Â· Landing</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: Inter, Segoe UI, Arial, sans-serif; background:#0f172a; color:#e2e8f0; }
    main { max-width: 980px; margin: 28px auto; padding: 0 16px; }
    h1 { margin-bottom: 6px; }
    .hint { color:#94a3b8; margin-bottom: 16px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    a.card { display:block; background:#111827; border:1px solid #1f2937; border-radius:10px; padding:14px; color:#e2e8f0; text-decoration:none; }
    a.card:hover { border-color:#2563eb; }
    .title { font-weight:700; margin-bottom:6px; }
    .desc { color:#94a3b8; font-size:0.92rem; }
    .meta { margin-top:14px; color:#94a3b8; font-size:0.9rem; }
  </style>
</head>
<body>
  <main>
    <h1>OCOM</h1>
    <p class="hint">Panel principal para navegar entre las herramientas del proyecto.</p>

    <section class="grid">
      <a class="card" href="/ui/oauth-wizard"><div class="title">OAuth Wizard</div><div class="desc">Alta de cuentas OAuth y generaciÃƒÂ³n de link de autorizaciÃƒÂ³n.</div></a>
      <a class="card" href="/ui/accounts"><div class="title">Accounts Status</div><div class="desc">Listado completo de cuentas con estado lÃƒÂ³gico y runtime.</div></a>
      <a class="card" href="/ui/monitor"><div class="title">Monitor</div><div class="desc">MÃƒÂ©tricas, alertas y eventos en tiempo real.</div></a>
      <a class="card" href="/openapi.json"><div class="title">OpenAPI</div><div class="desc">Contrato API v1 para integraciÃƒÂ³n.</div></a>
      <a class="card" href="/health"><div class="title">Health</div><div class="desc">Estado de servicio y modo operativo.</div></a>
      <a class="card" href="/events/recent"><div class="title">Eventos recientes</div><div class="desc">Feed JSON de eventos emitidos.</div></a>
    </section>

    <div class="meta">Servicio: ocom Ã‚Â· versiÃƒÂ³n 0.1.0</div>
  </main>
</body>
</html>`);
  });

  server.get('/health', async () => {
    return {
      healthy: true,
      timestamp: new Date().toISOString(),
      mode: {
        singleAgent: singleAgentMode,
        agentSlug: singleAgentMode ? singleAgentSlug : null,
        agentPermissions: agentPermissionsEnabled,
      },
    };
  });

  server.get('/mode', async () => {
    return {
      ok: true,
      mode: {
        singleAgent: singleAgentMode,
        agentSlug: singleAgentMode ? singleAgentSlug : null,
        agentPermissions: agentPermissionsEnabled,
      },
    };
  });

  server.get('/openapi.json', async (request) => {
    const originHeader = request.headers.origin;
    const hostHeader = request.headers.host;
    const protocolHeader = request.headers['x-forwarded-proto'];

    const protocol = typeof protocolHeader === 'string'
      ? protocolHeader
      : (request.protocol || 'http');

    const origin = typeof originHeader === 'string' && originHeader.trim()
      ? originHeader.trim()
      : (typeof hostHeader === 'string' && hostHeader.trim()
        ? `${protocol}://${hostHeader}`
        : undefined);

    return buildOpenApiSpec({ serverUrl: origin });
  });

  server.post('/seed/personal-provider', async (request, reply) => {
    const body = parseWithZod(
      reply,
      actorBodySchema,
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    try {
      const seeded = await seedService.seedPersonalProvider();

      await audit.append({
        actor: resolveActor(request, body),
        action: 'seed.personal_provider',
        resourceType: 'project',
        resourceId: 'personal-provider',
        payload: {
          project: seeded.project.name,
          agents: seeded.agents.map((agent) => agent.slug),
          count: seeded.agents.length,
        },
      });

      events.publish('seed.personal_provider', {
        project: seeded.project.name,
        count: seeded.agents.length,
        agents: seeded.agents.map((agent) => agent.slug),
      });

      return {
        ok: true,
        ...seeded,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'seed_personal_provider_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.get('/events/recent', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const limit = query.limit || 50;

    return {
      ok: true,
      listeners: events.listenerCount(),
      events: events.listRecent(limit),
    };
  });

  server.register(async (wsScope) => {
    await wsScope.register(websocket);

    wsScope.get('/ws/events', { websocket: true }, (connection, request) => {
      const parsedQuery = z.object({
        replay: z.coerce.number().int().positive().max(200).optional(),
      }).safeParse(request.query || {});

      const replay = parsedQuery.success && parsedQuery.data.replay
        ? parsedQuery.data.replay
        : 20;

      const sendEvent = (event: RealtimeEvent) => {
        if (connection.socket.readyState === 1) {
          connection.socket.send(JSON.stringify(event));
        }
      };

      const initial = events.listRecent(replay);
      for (const event of initial) {
        sendEvent(event);
      }

      const unsubscribe = events.subscribe((event) => {
        sendEvent(event);
      });

      connection.socket.on('close', () => {
        unsubscribe();
      });

      connection.socket.on('error', () => {
        unsubscribe();
      });

      connection.socket.on('message', (raw: Buffer) => {
        const text = raw.toString();
        if (text === 'ping') {
          connection.socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
        }
      });
    });
  });

  server.get('/backup/list', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        limit: z.coerce.number().int().positive().max(100).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const limit = query.limit || 30;

    try {
      const backups = backupService.listBackups(limit);
      return {
        ok: true,
        backupDir,
        backups,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'backup_list_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/backup/run', async (request, reply) => {
    const body = parseWithZod(
      reply,
      actorBodySchema,
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    try {
      const artifact = backupService.runBackup();

      await audit.append({
        actor: resolveActor(request, body),
        action: 'backup.run',
        resourceType: 'backup',
        resourceId: artifact.file,
        payload: {
          file: artifact.file,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
        },
      });

      events.publish('backup.run', {
        file: artifact.file,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      });

      return {
        ok: true,
        backup: artifact,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'backup_run_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/backup/restore', async (request, reply) => {
    const body = parseWithZod(
      reply,
      z.object({
        file: z.string().trim().min(1),
        actor: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    try {
      const restored = backupService.restoreBackup(body.file);

      await audit.append({
        actor: resolveActor(request, body),
        action: 'backup.restore',
        resourceType: 'backup',
        resourceId: restored.file,
        payload: {
          file: restored.file,
          bytes: restored.bytes,
          sha256: restored.sha256,
        },
      });

      events.publish('backup.restore', {
        file: restored.file,
        bytes: restored.bytes,
        sha256: restored.sha256,
      });

      return {
        ok: true,
        restored,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'backup_restore_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/health/run', async (request, reply) => {
    const body = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
        limit: z.coerce.number().int().positive().optional(),
        actor: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    try {
      const result = await healthService.runOnce({
        provider: body.provider,
        limit: body.limit,
      });

      await audit.append({
        actor: resolveActor(request, body),
        action: 'health.run',
        resourceType: 'health',
        resourceId: body.provider || 'all',
        payload: {
          provider: body.provider || null,
          scanned: result.scanned,
          updated: result.updated,
          active: result.active,
          degraded: result.degraded,
          failover: result.failover,
          expired: result.expired,
          revoked: result.revoked,
        },
      });

      events.publish('health.run', {
        provider: body.provider || null,
        scanned: result.scanned,
        updated: result.updated,
        active: result.active,
        degraded: result.degraded,
        failover: result.failover,
        expired: result.expired,
        revoked: result.revoked,
      });

      return result;
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'health_run_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.get('/ui/oauth-wizard', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderOauthWizard());
  });

  server.get('/ui/monitor', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderMonitoringBoard());
  });

  server.get('/board.html', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderMonitoringBoard());
  });

  server.get('/ui/accounts', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderAccountsStatusBoard());
  });

  server.get('/accounts.html', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderAccountsStatusBoard());
  });

  server.get('/projects/:project/access', async (request, reply) => {
    const params = parseWithZod(reply, projectParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    return projectAccess(params.project);
  });

  // Simple write endpoint to validate lock behavior.
  server.post('/projects/:project/simulate-write', async (request, reply) => {
    const params = parseWithZod(reply, projectParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    return {
      ok: true,
      project: params.project,
      action: 'write_allowed',
    };
  });

  // OAuth PKCE entrypoint.
  server.get('/oauth/:provider/start', async (request, reply) => {
    const params = parseWithZod(
      reply,
      z.object({ provider: z.string().trim().min(1) }),
      request.params || {},
      'params',
    );
    if (!params) {
      return;
    }

    const query = parseWithZod(
      reply,
      z.object({
        scope: z.string().optional(),
        redirect: z.string().optional(),
        store: z.string().optional(),
        accountId: z.string().trim().min(1).optional(),
        profileId: z.string().trim().min(1).optional(),
        healthScore: z.coerce.number().optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const storeRequested = query.store === '1' || query.store === 'true';

    try {
      const result = pkce.start(
        params.provider,
        parseScopeList(query.scope),
        {
          store: storeRequested,
          accountId: query.accountId,
          profileId: query.profileId,
          healthScore: typeof query.healthScore === 'number' && Number.isFinite(query.healthScore)
            ? query.healthScore
            : undefined,
        },
      );

      // Force prompt=login to ensure fresh consent and avoid invalid_grant
      try {
        const url = new URL(result.authorizationUrl);
        if (!url.searchParams.has('prompt')) {
          url.searchParams.set('prompt', 'login');
          result.authorizationUrl = url.toString();
        }
      } catch (e) {
        // ignore malformed URL
      }

      if (query.redirect === '1' || query.redirect === 'true') {
        return reply.redirect(result.authorizationUrl);
      }

      return {
        ...result,
        ok: true,
      };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: 'oauth_start_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // OAuth callback endpoint.
  server.get('/oauth/:provider/callback', async (request, reply) => {
    const params = parseWithZod(
      reply,
      z.object({ provider: z.string().trim().min(1) }),
      request.params || {},
      'params',
    );
    if (!params) {
      return;
    }

    const query = parseWithZod(
      reply,
      z.object({
        state: z.string().optional(),
        code: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
        store: z.string().optional(),
        accountId: z.string().trim().min(1).optional(),
        profileId: z.string().trim().min(1).optional(),
        healthScore: z.coerce.number().optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    if (query.error) {
      return reply.code(400).send({
        ok: false,
        error: 'oauth_provider_error',
        provider: params.provider,
        providerError: query.error,
        providerErrorDescription: query.error_description || null,
      });
    }

    if (!query.state || !query.code) {
      return reply.code(400).send({
        ok: false,
        error: 'missing_oauth_params',
        required: ['state', 'code'],
      });
    }

    try {
      // Log incoming callback params for diagnostics (no PII)
      server.log.info({
        provider: params.provider,
        hasState: !!query.state,
        hasCode: !!query.code,
        error: query.error,
        error_description: query.error_description,
        store: query.store,
      }, 'oauth callback invoked');

      const result = await pkce.complete(params.provider, query.state, query.code);

      const queryStoreRequested = query.store === '1' || query.store === 'true';
      const hint = result.storageHint || {};
      const storeRequested = Boolean(hint.store) || queryStoreRequested;

      const requestedAccountId = hint.accountId || query.accountId;
      const requestedProfileId = hint.profileId || query.profileId;

      let accountId = requestedAccountId;
      let profileId = requestedProfileId;
      let inferredEmail: string | undefined;

      if (params.provider === 'openai-codex') {
        inferredEmail = extractOpenAiCodexEmail(result.tokens?.accessToken);

        if (inferredEmail) {
          profileId = `${params.provider}:${inferredEmail}`;
          if (!accountId) {
            accountId = inferredEmail;
          }
        }

        if (!profileId) {
          const existing = await accounts.list({ provider: params.provider, includeRevoked: true });
          profileId = nextDefaultProfileId(
            params.provider,
            existing.map((item) => item.profileId),
          );
        }

        if (!accountId && profileId) {
          const separator = profileId.indexOf(':');
          accountId = separator >= 0 ? profileId.slice(separator + 1) : profileId;
        }
      }

      const healthScore = typeof hint.healthScore === 'number'
        ? hint.healthScore
        : (typeof query.healthScore === 'number' && Number.isFinite(query.healthScore)
          ? query.healthScore
          : undefined);

      if (!storeRequested) {
        return {
          ...result,
          ok: true,
        };
      }

      if (!result.tokens?.accessToken || !accountId || !profileId) {
        return reply.code(400).send({
          ok: false,
          error: 'oauth_storage_missing_fields',
          required: ['accountId', 'profileId', 'accessToken'],
        });
      }

      try {
        // Usar upsert: si el email (accountId) ya existe para este provider, actualiza; si no, crea.
        const storedAccount = await accounts.upsertByProviderAndAccount(params.provider, accountId, {
          profileId,
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
          expiresAt: result.tokens.expiresAt || null,
          healthScore,
        });

        // Guardar mapeo profileKeyHash -> email para enriquecimiento de logs (P1)
        if (inferredEmail) {
          try {
            const profileKey = `${params.provider}:${profileId}`;
            // Calcular SHA256(profileKey) para obtener el hash que usa el agente
            const fullHash = createHash('sha256').update(profileKey).digest('hex');
            // Truncar a 12 caracteres (como en los logs: sha256:4fd869f30e05)
            const shortHash = fullHash.slice(0, 12);
            const hashKey = `sha256:${shortHash}`;
            profileMetaStore.set(hashKey, { email: inferredEmail, provider: params.provider, created_at: new Date().toISOString(), plan: 'free' });
            // TambiÃƒÂ©n guardar el hash completo por siÃ¦Å“ÂªÃ¦ÂÂ¥ lo necesitamos
            profileMetaStore.set(`sha256:${fullHash}`, { email: inferredEmail, provider: params.provider, created_at: new Date().toISOString(), plan: 'free' });
          } catch (_) {}
        }

        server.log.info({
          provider: params.provider,
          accountId: storedAccount.id,
          accountExternalId: storedAccount.accountId,
          profileId: storedAccount.profileId,
          status: storedAccount.status,
        }, 'oauth account stored');

        await audit.append({
          actor: resolveActor(request),
          action: 'oauth.callback.store',
          resourceType: 'account',
          resourceId: String(storedAccount.id),
          payload: {
            provider: storedAccount.provider,
            accountId: storedAccount.accountId,
            profileId: storedAccount.profileId,
            status: storedAccount.status,
          },
        });

        events.publish('account.oauth.stored', {
          id: storedAccount.id,
          provider: storedAccount.provider,
          accountId: storedAccount.accountId,
          profileId: storedAccount.profileId,
          status: storedAccount.status,
        });

        return {
          ok: true,
          ...result,
          stored: true,
          account: storedAccount,
        };
      } catch (storageError) {
        const message = storageError instanceof Error ? storageError.message : 'Unknown error';
        const status = message.includes('already exists') ? 409 : 400;

        return reply.code(status).send({
          ok: false,
          error: 'oauth_storage_failed',
          message,
        });
      }
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: 'oauth_callback_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Accounts API (list/revoke/status)
  server.get('/accounts', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
        includeRevoked: z.string().optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const includeRevoked = !['0', 'false', 'no'].includes(String(query.includeRevoked || '').toLowerCase());

    try {
      const items = await accounts.list({
        provider: query.provider,
        includeRevoked,
      });

      return {
        ok: true,
        accounts: items,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'accounts_list_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/accounts', async (request, reply) => {
    const body = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1),
        accountId: z.string().trim().min(1),
        profileId: z.string().trim().min(1),
        expiresAt: z.string().trim().min(1).nullable().optional(),
        healthScore: z.number().finite().optional(),
        locked: z.boolean().optional(),
        accessToken: z.string().optional(),
        refreshToken: z.string().optional(),
        actor: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    const payload: CreateAccountInput = {
      provider: body.provider,
      accountId: body.accountId,
      profileId: body.profileId,
      expiresAt: typeof body.expiresAt === 'undefined' ? null : body.expiresAt,
      healthScore: body.healthScore,
      locked: Boolean(body.locked),
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
    };

    try {
      const created = await accounts.create(payload);
      await audit.append({
        actor: resolveActor(request, body),
        action: 'account.create',
        resourceType: 'account',
        resourceId: String(created.id),
        payload: {
          provider: created.provider,
          accountId: created.accountId,
          profileId: created.profileId,
          status: created.status,
        },
      });

      events.publish('account.created', {
        id: created.id,
        provider: created.provider,
        accountId: created.accountId,
        profileId: created.profileId,
        status: created.status,
      });

      return reply.code(201).send({
        ok: true,
        account: created,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('already exists') ? 409 : 400;

      return reply.code(status).send({
        ok: false,
        error: 'accounts_create_failed',
        message,
      });
    }
  });

  server.get('/accounts/:id', async (request, reply) => {
    const params = parseWithZod(reply, idParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    const account = await accounts.getById(params.id);

    if (!account) {
      return reply.code(404).send({
        ok: false,
        error: 'account_not_found',
      });
    }

    return {
      ok: true,
      account,
    };
  });

  server.get('/accounts/:id/status', async (request, reply) => {
    const params = parseWithZod(reply, idParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    const status = await accounts.statusById(params.id);

    if (!status) {
      return reply.code(404).send({
        ok: false,
        error: 'account_not_found',
      });
    }

    return {
      ok: true,
      ...status,
    };
  });

  async function fetchWhamUsage(accessToken: string): Promise<{ ok: boolean; status: number; usedPercent: number | null; allowed: boolean | null; limitReached: boolean | null; resetAt: number | null; bodyText?: string; }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const bodyText = await response.text().catch(() => '');
      let payload: any = null;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        payload = null;
      }

      return {
        ok: response.ok,
        status: response.status,
        usedPercent: typeof payload?.rate_limit?.primary_window?.used_percent === 'number' ? payload.rate_limit.primary_window.used_percent : null,
        allowed: typeof payload?.rate_limit?.allowed === 'boolean' ? payload.rate_limit.allowed : null,
        limitReached: typeof payload?.rate_limit?.limit_reached === 'boolean' ? payload.rate_limit.limit_reached : null,
        resetAt: typeof payload?.rate_limit?.primary_window?.reset_at === 'number' ? payload.rate_limit.primary_window.reset_at : null,
        bodyText,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        usedPercent: null,
        allowed: null,
        limitReached: null,
        resetAt: null,
        bodyText: isTimeout ? 'timeout' : (error instanceof Error ? error.message : 'network_error'),
      };
    }
  }

  function classifyQuotaSignal(status: number, bodyText?: string): { exhausted: boolean; code?: string } {
    if (status === 429) {
      return { exhausted: true, code: 'http_429' };
    }

    if (!bodyText || !bodyText.trim()) {
      return { exhausted: false };
    }

    const lower = bodyText.toLowerCase();

    if (lower.includes('insufficient_quota')) {
      return { exhausted: true, code: 'insufficient_quota' };
    }

    if (lower.includes('you exceeded your current quota')) {
      return { exhausted: true, code: 'quota_exceeded_message' };
    }

    return { exhausted: false };
  }

  async function probeOpenAICodexQuota(accessToken: string): Promise<{
    outcome: 'success' | 'degraded' | 'exhausted';
    quotaStatus: 'ok' | 'limited' | 'exhausted' | 'error' | 'expired';
    quotaRemainingPct: number | null;
    usedPercent: number | null;
    allowed: boolean | null;
    limitReached: boolean | null;
    resetAt: number | null;
    httpStatus: number;
    errorCode?: string;
    errorMessage?: string;
  }> {
    const usage = await fetchWhamUsage(accessToken);

    if (!usage.ok) {
      const quotaSignal = classifyQuotaSignal(usage.status, usage.bodyText);
      const quotaStatus = usage.status === 401 || usage.status === 403
        ? 'expired'
        : (quotaSignal.exhausted ? 'exhausted' : 'error');

      return {
        outcome: quotaSignal.exhausted ? 'exhausted' : 'degraded',
        quotaStatus,
        quotaRemainingPct: quotaSignal.exhausted ? 0 : null,
        usedPercent: usage.usedPercent,
        allowed: usage.allowed,
        limitReached: usage.limitReached,
        resetAt: usage.resetAt,
        httpStatus: usage.status,
        errorCode: quotaSignal.code || (usage.status ? String(usage.status) : 'network_error'),
        errorMessage: (usage.bodyText || '').slice(0, 300),
      };
    }

    const usedPercent = typeof usage.usedPercent === 'number' ? usage.usedPercent : null;
    const remainingPct = typeof usedPercent === 'number'
      ? Math.max(0, Math.min(100, Number((100 - usedPercent).toFixed(2))))
      : null;

    if (usage.allowed === false || usage.limitReached === true || (typeof usedPercent === 'number' && usedPercent >= 100)) {
      return {
        outcome: 'exhausted',
        quotaStatus: 'exhausted',
        quotaRemainingPct: 0,
        usedPercent,
        allowed: usage.allowed,
        limitReached: usage.limitReached,
        resetAt: usage.resetAt,
        httpStatus: usage.status,
        errorCode: 'wham_limit_reached',
        errorMessage: `used_percent=${usage.usedPercent ?? 'n/a'} reset_at=${usage.resetAt ?? 'n/a'}`,
      };
    }

    const quotaStatus = typeof usedPercent === 'number' && usedPercent >= 85
      ? 'limited'
      : 'ok';

    return {
      outcome: quotaStatus === 'limited' ? 'degraded' : 'success',
      quotaStatus,
      quotaRemainingPct: remainingPct,
      usedPercent,
      allowed: usage.allowed,
      limitReached: usage.limitReached,
      resetAt: usage.resetAt,
      httpStatus: usage.status,
      errorCode: quotaStatus === 'limited' ? 'wham_limited' : 'wham_ok',
      errorMessage: `used_percent=${usage.usedPercent ?? 'n/a'} reset_at=${usage.resetAt ?? 'n/a'}`,
    };
  }

  server.get('/accounts/runtime', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const accountItems = await accounts.list({
      provider: query.provider,
      includeRevoked: true,
    });

    const runtimeById = await accountRuntime.listByAccountId(accountItems.map((item) => item.id));

    return {
      ok: true,
      accounts: accountItems.map((item) => ({
        id: item.id,
        provider: item.provider,
        accountId: item.accountId,
        profileId: item.profileId,
        status: item.status,
        healthScore: item.healthScore,
        locked: item.locked,
        runtime: runtimeById[item.id] || {
          accountId: item.id,
          state: item.status === 'revoked' ? 'exhausted' : (item.status === 'active' ? 'healthy' : 'degraded'),
          exhaustedUntil: null,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: item.updatedAt,
        },
      })),
    };
  });

  server.get('/accounts/wham/usage', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
        refresh: z.union([z.string(), z.boolean()]).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const provider = query.provider || 'openai-codex';
    const refresh = query.refresh === true || query.refresh === '1' || query.refresh === 'true';

    const accountItems = await accounts.list({ provider, includeRevoked: true });
    const ids = accountItems.map((item) => item.id);

    let cachedById = await usageCache.listByProviderAndAccountIds(provider, ids);

    const shouldRefresh = refresh || Object.keys(cachedById).length === 0;

    if (shouldRefresh) {
      const checkedAt = new Date().toISOString();
      const candidates = await accounts.listAccessTokenCandidates({
        provider,
        includeLocked: false,
      });

      for (const candidate of candidates) {
        const usage = await fetchWhamUsage(candidate.accessToken);
        await usageCache.upsert({
          provider,
          accountId: candidate.id,
          usedPercent: usage.usedPercent,
          allowed: usage.allowed,
          limitReached: usage.limitReached,
          resetAt: usage.resetAt,
          httpStatus: usage.status,
          checkedAt,
        });
      }

      cachedById = await usageCache.listByProviderAndAccountIds(provider, ids);
    }

    return {
      ok: true,
      provider,
      source: shouldRefresh ? 'live+cache' : 'cache',
      checkedAt: new Date().toISOString(),
      accounts: accountItems.map((item) => {
        const extra = cachedById[item.id] || {
          usedPercent: null,
          allowed: null,
          limitReached: item.status === 'revoked' || item.locked,
          resetAt: null,
          httpStatus: 0,
          checkedAt: null,
        };

        return {
          id: item.id,
          accountId: item.accountId,
          profileId: item.profileId,
          usedPercent: extra.usedPercent,
          allowed: extra.allowed,
          limitReached: extra.limitReached,
          resetAt: extra.resetAt,
          httpStatus: extra.httpStatus,
          checkedAt: extra.checkedAt,
        };
      }),
    };
  });

  const runRuntimeProbe = async (provider?: string) => {
    const candidates = await accounts.listAccessTokenCandidates({
      provider,
      includeLocked: false,
    });

    const results: Array<{
      id: number;
      accountId: string;
      profileId: string;
      outcome: 'success' | 'degraded' | 'exhausted';
      quotaStatus: 'ok' | 'limited' | 'exhausted' | 'error' | 'expired';
      quotaRemainingPct: number | null;
      usedPercent: number | null;
      resetAt: number | null;
      httpStatus: number;
      lastVerifiedAt: string;
      durationMs: number;
      errorCode?: string;
    }> = [];

    for (const candidate of candidates) {
      const startedAt = Date.now();
      const probe = await probeOpenAICodexQuota(candidate.accessToken);
      const checkedAt = new Date().toISOString();

      await usageCache.upsert({
        provider: candidate.provider,
        accountId: candidate.id,
        usedPercent: probe.usedPercent,
        allowed: probe.allowed,
        limitReached: probe.limitReached,
        resetAt: probe.resetAt,
        httpStatus: probe.httpStatus,
        checkedAt,
      });

      await accountRuntime.recordEvent({
        accountId: candidate.id,
        outcome: probe.outcome,
        errorCode: probe.errorCode,
        errorMessage: probe.errorMessage,
      });

      const previous = await accounts.getById(candidate.id);
      if (previous && !previous.locked) {
        if (probe.outcome === 'success') {
          await accounts.updateHealthScoreById(candidate.id, 100);
        } else if (probe.outcome === 'degraded') {
          await accounts.updateHealthScoreById(candidate.id, Math.min(previous.healthScore, 40));
        } else if (probe.outcome === 'exhausted') {
          await accounts.updateHealthScoreById(candidate.id, 0);
        }
      }

      const durationMs = Date.now() - startedAt;

      results.push({
        id: candidate.id,
        accountId: candidate.accountId,
        profileId: candidate.profileId,
        outcome: probe.outcome,
        quotaStatus: probe.quotaStatus,
        quotaRemainingPct: probe.quotaRemainingPct,
        usedPercent: probe.usedPercent,
        resetAt: probe.resetAt,
        httpStatus: probe.httpStatus,
        lastVerifiedAt: checkedAt,
        durationMs,
        errorCode: probe.errorCode,
      });
    }

    const summary = results.reduce((acc, item) => {
      acc.total += 1;
      acc[item.outcome] = (acc[item.outcome] || 0) + 1;
      return acc;
    }, { total: 0, success: 0, degraded: 0, exhausted: 0 });

    const statusSummary = results.reduce((acc, item) => {
      acc.total += 1;
      acc[item.quotaStatus] = (acc[item.quotaStatus] || 0) + 1;
      return acc;
    }, { total: 0, ok: 0, limited: 0, exhausted: 0, error: 0, expired: 0 });

    return {
      summary,
      statusSummary,
      results,
    };
  };

  if (accountVerifyIntervalMs > 0) {
    accountVerifyTimer = setInterval(() => {
      runRuntimeProbe('openai-codex').then((probeResult) => {
        if (!probeResult.summary.total) {
          return;
        }

        for (const item of probeResult.results) {
          server.log.info({
            profileId: item.profileId,
            status: item.quotaStatus,
            quotaRemainingPct: item.quotaRemainingPct,
            durationMs: item.durationMs,
            timestamp: item.lastVerifiedAt,
          }, 'account verification probe result');
        }

        events.publish('accounts.runtime.probe.completed', {
          source: 'interval',
          provider: 'openai-codex',
          summary: probeResult.summary,
          statusSummary: probeResult.statusSummary,
          accounts: probeResult.results.map((r) => {
            const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
            const profileId = r.profileId;
            const colonIdx = profileId.indexOf(':');
            const suffix = colonIdx >= 0 ? profileId.slice(colonIdx + 1) : profileId;
            const email = emailPattern.test(suffix) ? suffix.toLowerCase() : (emailPattern.test(r.accountId) ? r.accountId.toLowerCase() : null);
            const providerPart = colonIdx >= 0 ? profileId.slice(0, colonIdx) : null;
            return {
              accountId: r.id,
              accountExternalId: r.accountId,
              profileId: r.profileId,
              provider: providerPart,
              email,
              outcome: r.outcome,
              quotaStatus: r.quotaStatus,
              usedPercent: r.usedPercent,
              errorCode: r.errorCode || null,
            };
          }),
        });
      }).catch((error) => {
        server.log.error({ err: error }, 'account verification probe interval failed');
      });
    }, accountVerifyIntervalMs);

    if (typeof accountVerifyTimer.unref === 'function') {
      accountVerifyTimer.unref();
    }
  }

  server.post('/accounts/runtime/probe', async (request, reply) => {
    const body = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    const probeResult = await runRuntimeProbe(body.provider);

    // Build enriched accounts array
    const enrichedAccounts = probeResult.results.map((r) => {
      const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      const profileId = r.profileId;
      const colonIdx = profileId.indexOf(':');
      const suffix = colonIdx >= 0 ? profileId.slice(colonIdx + 1) : profileId;
      const email = emailPattern.test(suffix) ? suffix.toLowerCase() : (emailPattern.test(r.accountId) ? r.accountId.toLowerCase() : null);
      const providerPart = colonIdx >= 0 ? profileId.slice(0, colonIdx) : null;
      return {
        accountId: r.id,
        accountExternalId: r.accountId,
        profileId: r.profileId,
        provider: providerPart,
        email,
        outcome: r.outcome,
        quotaStatus: r.quotaStatus,
        usedPercent: r.usedPercent,
        errorCode: r.errorCode || null,
      };
    });

    // Debug: write enriched payload to file for verification
    const fs = await import('fs');
    const debugPath = './probe_debug.json';
    try { fs.writeFileSync(debugPath, JSON.stringify({ enrichedAccounts, summary: probeResult.summary, statusSummary: probeResult.statusSummary }, null, 2)); } catch (e) {}

    // Debug log
    server.log.debug({ enrichedCount: enrichedAccounts.length, sample: enrichedAccounts[0] }, 'enriched probe event');

    // Emit enriched probe completed event (manual)
    events.publish('accounts.runtime.probe.completed', {
      source: 'manual',
      summary: probeResult.summary,
      statusSummary: probeResult.statusSummary,
      accounts: enrichedAccounts,
    });

    // Return enriched payload as part of response for verification
    const responsePayload = {
      ok: true,
      endpointVersion: 2,
      ...probeResult,
      enrichedAccounts,
    };
    return reply.send(responsePayload);
  });

  server.get('/api/auth/profiles/status', async (request, reply) => {
    if (!requireGatewayApiToken(request, reply)) {
      return;
    }

    const query = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const items = await accounts.list({
      provider: query.provider,
      includeRevoked: true,
    });

    const runtimeById = await accountRuntime.listByAccountId(items.map((item) => item.id));

    const usageByAccountId: Record<number, {
      usedPercent: number | null;
      allowed: boolean | null;
      limitReached: boolean | null;
      resetAt: number | null;
      httpStatus: number;
      checkedAt: string;
    }> = {};

    const accountIdsByProvider: Record<string, number[]> = {};
    for (const item of items) {
      if (!accountIdsByProvider[item.provider]) {
        accountIdsByProvider[item.provider] = [];
      }
      accountIdsByProvider[item.provider].push(item.id);
    }

    for (const [provider, ids] of Object.entries(accountIdsByProvider)) {
      const byId = await usageCache.listByProviderAndAccountIds(provider, ids);
      for (const [idText, usage] of Object.entries(byId)) {
        usageByAccountId[Number(idText)] = usage;
      }
    }

    const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

    const profiles = items.map((item) => {
      const runtime = runtimeById[item.id];
      const usage = usageByAccountId[item.id];

      const profileSuffix = item.profileId.includes(':')
        ? item.profileId.slice(item.profileId.indexOf(':') + 1)
        : item.profileId;
      const emailCandidate = emailPattern.test(profileSuffix)
        ? profileSuffix.toLowerCase()
        : (emailPattern.test(item.accountId) ? item.accountId.toLowerCase() : null);

      const usedPercent = typeof usage?.usedPercent === 'number' ? usage.usedPercent : null;
      const quotaRemainingPct = typeof usedPercent === 'number'
        ? Math.max(0, Math.min(100, Number((100 - usedPercent).toFixed(2))))
        : null;

      let status: 'ok' | 'limited' | 'exhausted' | 'error' | 'expired' = 'ok';
      if (runtime?.state === 'exhausted' || usage?.allowed === false || usage?.limitReached === true || (typeof usedPercent === 'number' && usedPercent >= 100)) {
        status = 'exhausted';
      } else if ((usage?.httpStatus === 401 || usage?.httpStatus === 403) || item.status === 'expired') {
        status = 'expired';
      } else if (usage && usage.httpStatus >= 400) {
        status = 'error';
      } else if (runtime?.state === 'degraded' || (typeof usedPercent === 'number' && usedPercent >= 85)) {
        status = 'limited';
      }

      const errorLast = runtime?.lastErrorMessage
        || runtime?.lastErrorCode
        || ((usage && usage.httpStatus >= 400) ? `http_${usage.httpStatus}` : null);

      return {
        profile_id: item.profileId,
        email: emailCandidate,
        provider: item.provider,
        status,
        quota_remaining_pct: quotaRemainingPct,
        error_last: errorLast,
        last_verified_at: usage?.checkedAt || runtime?.updatedAt || item.updatedAt,
        cooldown_until: runtime?.exhaustedUntil || null,
      };
    });

    return reply.send(profiles);
  });

  server.post('/accounts/:id/runtime-event', async (request, reply) => {
    const params = parseWithZod(reply, idParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    const body = parseWithZod(
      reply,
      z.object({
        outcome: z.enum(['success', 'degraded', 'exhausted']),
        errorCode: z.string().trim().min(1).optional(),
        errorMessage: z.string().trim().min(1).optional(),
        actor: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    const account = await accounts.getById(params.id);
    if (!account) {
      return reply.code(404).send({
        ok: false,
        error: 'account_not_found',
      });
    }

    const runtime = await accountRuntime.recordEvent({
      accountId: params.id,
      outcome: body.outcome,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
    });

    if (!account.locked) {
      if (body.outcome === 'success') {
        await accounts.updateHealthScoreById(params.id, 100);
      } else if (body.outcome === 'degraded') {
        await accounts.updateHealthScoreById(params.id, Math.min(account.healthScore, 40));
      } else if (body.outcome === 'exhausted') {
        await accounts.updateHealthScoreById(params.id, 0);
      }
    }

    await audit.append({
      actor: resolveActor(request, body),
      action: 'account.runtime.event',
      resourceType: 'account',
      resourceId: String(params.id),
      payload: {
        outcome: body.outcome,
        errorCode: body.errorCode || null,
        errorMessage: body.errorMessage || null,
        runtimeState: runtime.state,
        exhaustedUntil: runtime.exhaustedUntil,
      },
    });

    events.publish('account.runtime.event', {
      accountId: params.id,
      profileId: account.profileId,
      outcome: body.outcome,
      runtimeState: runtime.state,
      exhaustedUntil: runtime.exhaustedUntil,
    });

    return {
      ok: true,
      runtime,
    };
  });

  const revokeAccountById = async (
    request: FastifyRequest,
    reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
    id: number,
    body?: { actor?: string },
  ) => {
    try {
      const account = await accounts.revokeById(id);

      if (!account) {
        return reply.code(404).send({
          ok: false,
          error: 'account_not_found',
        });
      }

      await audit.append({
        actor: resolveActor(request, body),
        action: 'account.revoke',
        resourceType: 'account',
        resourceId: String(account.id),
        payload: {
          provider: account.provider,
          accountId: account.accountId,
          profileId: account.profileId,
          status: account.status,
        },
      });

      events.publish('account.revoked', {
        id: account.id,
        provider: account.provider,
        accountId: account.accountId,
        profileId: account.profileId,
        status: account.status,
      });

      return {
        ok: true,
        account,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'accounts_revoke_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  server.post('/accounts/:id/revoke', async (request, reply) => {
    const params = parseWithZod(reply, idParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    const body = parseWithZod(reply, actorBodySchema, request.body || {}, 'body');
    if (!body) {
      return;
    }

    return revokeAccountById(request, reply, params.id, body);
  });

  server.delete('/accounts/:id', async (request, reply) => {
    const params = parseWithZod(reply, idParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    const body = parseWithZod(reply, actorBodySchema, request.body || {}, 'body');
    if (!body) {
      return;
    }

    return revokeAccountById(request, reply, params.id, body);
  });

  server.post('/tokens/refresh/run', async (request, reply) => {
    const body = parseWithZod(
      reply,
      z.object({
        provider: z.string().trim().min(1).optional(),
        expiresInMinutes: z.coerce.number().nonnegative().optional(),
        limit: z.coerce.number().int().positive().optional(),
        actor: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    try {
      const result = await tokenRefresh.runOnce({
        provider: body.provider,
        expiresInMinutes: body.expiresInMinutes,
        limit: body.limit,
      });

      await audit.append({
        actor: resolveActor(request, body),
        action: 'tokens.refresh.run',
        resourceType: 'token_refresh',
        resourceId: body.provider || 'all',
        payload: {
          provider: body.provider || null,
          scanned: result.scanned,
          refreshed: result.refreshed,
          failed: result.failed,
        },
      });

      events.publish('tokens.refresh.run', {
        provider: body.provider || null,
        scanned: result.scanned,
        refreshed: result.refreshed,
        failed: result.failed,
      });

      return result;
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'tokens_refresh_run_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Assignment API (account <-> agent priority bindings)
  server.get('/assignments', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        agentSlug: z.string().trim().min(1).optional(),
        provider: z.string().trim().min(1).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const requestedAgentSlug = query.agentSlug;
    if (singleAgentMode && requestedAgentSlug && requestedAgentSlug !== singleAgentSlug) {
      return reply.code(409).send({
        ok: false,
        error: 'single_agent_slug_mismatch',
        expected: singleAgentSlug,
        received: requestedAgentSlug,
      });
    }

    const callerAgentSlug = resolveHeaderAgentSlug(request);
    const effectiveAgentSlug = singleAgentMode
      ? singleAgentSlug
      : (requestedAgentSlug || (agentPermissionsEnabled ? callerAgentSlug : undefined));

    if (agentPermissionsEnabled && !effectiveAgentSlug) {
      return reply.code(401).send({
        ok: false,
        error: 'missing_agent_slug_header',
        requiredHeader: 'x-agent-slug',
      });
    }

    if (effectiveAgentSlug && !enforceAgentSlugPermission(request, reply, effectiveAgentSlug)) {
      return;
    }

    try {
      const items = await assignments.list({
        agentSlug: effectiveAgentSlug,
        provider: query.provider,
      });

      return {
        ok: true,
        assignments: items,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'assignments_list_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/assignments', async (request, reply) => {
    const body = parseWithZod(
      reply,
      z.object({
        agentSlug: z.string().trim().min(1).optional(),
        accountId: z.coerce.number().int().positive(),
        priority: z.coerce.number().int().optional(),
        mode: z.string().trim().min(1).optional(),
        actor: z.string().trim().min(1).optional(),
      }),
      request.body || {},
      'body',
    );
    if (!body) {
      return;
    }

    const requestedAgentSlug = body.agentSlug;
    if (singleAgentMode && requestedAgentSlug && requestedAgentSlug !== singleAgentSlug) {
      return reply.code(409).send({
        ok: false,
        error: 'single_agent_slug_mismatch',
        expected: singleAgentSlug,
        received: requestedAgentSlug,
      });
    }

    const callerAgentSlug = resolveHeaderAgentSlug(request);
    const effectiveAgentSlug = singleAgentMode
      ? singleAgentSlug
      : (requestedAgentSlug || (agentPermissionsEnabled ? callerAgentSlug : undefined));

    if (!effectiveAgentSlug) {
      return reply.code(400).send({
        ok: false,
        error: 'missing_required_fields',
        required: ['agentSlug', 'accountId'],
      });
    }

    if (!enforceAgentSlugPermission(request, reply, effectiveAgentSlug)) {
      return;
    }

    try {
      const assignment = await assignments.upsert({
        agentSlug: effectiveAgentSlug,
        accountId: body.accountId,
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        mode: typeof body.mode === 'string' ? body.mode : undefined,
      });

      await audit.append({
        actor: resolveActor(request, body),
        action: 'assignment.upsert',
        resourceType: 'assignment',
        resourceId: String(assignment.id),
        payload: {
          agentSlug: assignment.agentSlug,
          accountId: assignment.accountId,
          priority: assignment.priority,
          mode: assignment.mode,
        },
      });

      events.publish('assignment.upserted', {
        id: assignment.id,
        agentSlug: assignment.agentSlug,
        accountId: assignment.accountId,
        priority: assignment.priority,
        mode: assignment.mode,
      });

      return {
        ok: true,
        assignment,
      };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: 'assignments_upsert_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.delete('/assignments/:id', async (request, reply) => {
    const params = parseWithZod(reply, idParamSchema, request.params || {}, 'params');
    if (!params) {
      return;
    }

    const body = parseWithZod(reply, actorBodySchema, request.body || {}, 'body');
    if (!body) {
      return;
    }

    try {
      const assignment = await assignments.getById(params.id);
      if (!assignment) {
        return reply.code(404).send({
          ok: false,
          error: 'assignment_not_found',
        });
      }

      if (!enforceAgentSlugPermission(request, reply, assignment.agentSlug)) {
        return;
      }

      const removed = await assignments.removeById(params.id);
      if (!removed) {
        return reply.code(404).send({
          ok: false,
          error: 'assignment_not_found',
        });
      }

      await audit.append({
        actor: resolveActor(request, body),
        action: 'assignment.delete',
        resourceType: 'assignment',
        resourceId: String(params.id),
        payload: {
          removed: true,
          agentSlug: assignment.agentSlug,
        },
      });

      events.publish('assignment.deleted', {
        id: params.id,
        removed: true,
        agentSlug: assignment.agentSlug,
      });

      return {
        ok: true,
        removed: true,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'assignments_delete_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Router API (selection + failover)
  server.get('/router/:agentSlug/select', async (request, reply) => {
    const params = parseWithZod(
      reply,
      z.object({ agentSlug: z.string().trim().min(1) }),
      request.params || {},
      'params',
    );
    if (!params) {
      return;
    }

    const query = parseWithZod(
      reply,
      z.object({ provider: z.string().trim().min(1).optional() }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    if (singleAgentMode && params.agentSlug !== singleAgentSlug) {
      return reply.code(409).send({
        ok: false,
        error: 'single_agent_slug_mismatch',
        expected: singleAgentSlug,
        received: params.agentSlug,
      });
    }

    if (!enforceAgentSlugPermission(request, reply, params.agentSlug)) {
      return;
    }

    try {
      const result = await router.select(params.agentSlug, query.provider);
      const runtimeAware = await applyRuntimeRouting(result);
      const statusCode = runtimeAware.ok ? 200 : 404;
      return reply.code(statusCode).send(runtimeAware);
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'router_select_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Agent-centric view for active account resolution.
  server.get('/agents/:slug/active-account', async (request, reply) => {
    const params = parseWithZod(
      reply,
      z.object({ slug: z.string().trim().min(1) }),
      request.params || {},
      'params',
    );
    if (!params) {
      return;
    }

    const query = parseWithZod(
      reply,
      z.object({ provider: z.string().trim().min(1).optional() }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    if (singleAgentMode && params.slug !== singleAgentSlug) {
      return reply.code(409).send({
        ok: false,
        error: 'single_agent_slug_mismatch',
        expected: singleAgentSlug,
        received: params.slug,
      });
    }

    if (!enforceAgentSlugPermission(request, reply, params.slug)) {
      return;
    }

    try {
      const selection = await router.select(params.slug, query.provider);
      const runtimeAware = await applyRuntimeRouting(selection);

      if (!runtimeAware.ok || !runtimeAware.selected) {
        return reply.code(404).send({
          ok: false,
          error: runtimeAware.reason || 'no_active_account',
          agentSlug: params.slug,
          provider: query.provider,
        });
      }

      const selected = runtimeAware.selected;

      return {
        ok: true,
        agentSlug: params.slug,
        provider: selected.provider,
        failoverApplied: runtimeAware.failoverApplied,
        account: {
          id: selected.accountId,
          provider: selected.provider,
          accountId: selected.accountExternalId,
          profileId: selected.profileId,
          status: selected.status,
          healthScore: selected.healthScore,
          locked: selected.locked,
          expiresAt: selected.expiresAt,
          assignmentId: selected.assignmentId,
          priority: selected.priority,
          mode: selected.mode,
        },
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'agent_active_account_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.get('/audit', async (request, reply) => {
    const query = parseWithZod(
      reply,
      z.object({
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
      request.query || {},
      'query',
    );
    if (!query) {
      return;
    }

    const limit = query.limit || 100;

    try {
      const entries = await audit.list(limit);
      return {
        ok: true,
        entries,
      };
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: 'audit_list_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return server;
}

if (require.main === module) {
  const server = createServer();
  const port = parseInt(process.env.PORT || '3001', 10);

  server.listen({ port, host: '0.0.0.0' }).then(() => {
    server.log.info(`OCOM server listening on http://0.0.0.0:${port}`);
  }).catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
}
