export function renderMonitoringBoard(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>OCOM Monitor</title>
  <style>
    :root{
      --bg:#0b0b10; --surface:#141419; --border:#2a2a35; --muted:#6b6b7a;
      --text:#e8e8ef; --accent:#6366f1; --ok:#22c55e; --warn:#f59e0b; --crit:#ef4444; --accent3:#a855f7;
    }
    *{box-sizing:border-box}
    body{font-family:Inter, system-ui, sans-serif; background:var(--bg); color:var(--text); margin:0; padding:24px}
    .container{max-width:1200px; margin:0 auto}
    h2{font-size:18px; margin:24px 0 12px; color:var(--accent); border-bottom:1px solid var(--border); padding-bottom:6px}
    table{width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border); border-radius:8px; overflow:hidden; font-size:11.5px}
    th,td{padding:10px 12px; text-align:left; border-bottom:1px solid var(--border)}
    th{background:#1c1c24; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.4px}
    tr:last-child td{border-bottom:none}
    tr:hover{background:#1a1a22}
    code{background:#22222d; padding:2px 6px; border-radius:4px; font-family:JetBrains Mono, monospace; font-size:11px}
    .ok{color:var(--ok)} .warn{color:var(--warn)} .crit{color:var(--crit)}
    .logline{font-family:JetBrains Mono,monospace; font-size:11px}
    #events{max-height:60vh; overflow:auto}
    #runtimeTable tbody tr{cursor:default}
  </style>
</head>
<body>
  <div class="container">
    <h2>Semáforo de cuentas (runtime)</h2>
    <table id="runtimeTable">
      <thead>
        <tr><th>Email / Profile</th><th>Estado</th><th>Reset</th><th>Score</th></tr>
      </thead>
      <tbody></tbody>
    </table>

    <h2>Eventos recientes</h2>
    <table id="events">
      <thead>
        <tr><th style="width:160px">Hora</th><th style="width:140px">Tipo</th><th>Payload / Mensaje</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script type="module">
    const el = {
      runtimeTable: document.querySelector('#runtimeTable tbody'),
      eventsTable: document.querySelector('#events tbody'),
    };

    function formatTs(ts) {
      if (!ts) return '-';
      const d = new Date(ts);
      return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function extractEmail(p) {
      if (!p || typeof p !== 'object') return null;
      const emailRegex = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;
      if (typeof p.email === 'string' && emailRegex.test(p.email)) return p.email;
      const profileId = typeof p.profileId === 'string' ? p.profileId : '';
      if (profileId.includes(':')) {
        const suffix = profileId.slice(profileId.indexOf(':')+1);
        if (emailRegex.test(suffix)) return suffix;
      }
      const accountId = typeof p.accountId === 'string' ? p.accountId : (typeof p.accountExternalId === 'string' ? p.accountExternalId : '');
      if (emailRegex.test(accountId)) return accountId;
      if (Array.isArray(p.accounts)) {
        for (const acc of p.accounts) {
          const found = extractEmail(acc);
          if (found) return found + (p.accounts.length > 1 ? \` +\${p.accounts.length-1}\` : '');
        }
      }
      return null;
    }

    function shortPayload(p) {
      if (!p) return '-';
      if (typeof p === 'object') {
        if (Array.isArray(p)) return \`Array(\${p.length})\`;
        const parts = [];
        const email = extractEmail(p);
        if (email) parts.push('<span style="color:#93c5fd">' + email + '</span>');
        const errCode = p.errorCode || p.error_code || p.lastErrorCode || p.error || null;
        if (errCode) parts.push('<span style="color:var(--danger)">' + String(errCode).slice(0,40) + '</span>');
        const outcome = p.outcome || p.quotaStatus || null;
        if (outcome && outcome !== 'success') parts.push('<span style="color:var(--accent3)">' + outcome + '</span>');
        if (typeof p.usedPercent === 'number') parts.push('used:' + p.usedPercent + '%');
        if (!parts.length) {
          const keys = Object.keys(p).slice(0,3);
          return '{' + keys.map(k => k + ':' + JSON.stringify(p[k]).slice(0,25)).join(', ') + (Object.keys(p).length>3?'…':'') + '}';
        }
        return parts.join(' · ');
      }
      return String(p).slice(0,80);
    }

    // Initial fetch
    async function load() {
      try {
        const [rtRes, evRes] = await Promise.all([
          fetch('/assignments'),
          fetch('/events/recent?limit=100')
        ]);
        const rt = await rtRes.json();
        const ev = await evRes.json();

        // Runtime table: use rt.assignments
        el.runtimeTable.innerHTML = '';
        const runtimeRows = rt.assignments || [];
        runtimeRows.forEach(row => {
          const tr = document.createElement('tr');
          const state = row.account?.status || 'unknown';
          const level = state==='healthy'?'ok':(state==='degraded'?'warn':'crit');
          const reset = row.account?.expiresAt || '-';
          const score = row.account?.healthScore ?? '-';
          const profileId = row.account?.profileId || row.agentSlug || '-';
          const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
          const suffix = profileId.includes(':') ? profileId.slice(profileId.indexOf(':')+1) : profileId;
          const email = emailRegex.test(suffix) ? suffix : (emailRegex.test(row.account?.accountId||'') ? row.account?.accountId : null);
          const display = email ? email : '<span style="color:var(--muted);font-size:10px">' + profileId + '</span>';
          tr.innerHTML = '<td>' + display + '</td>' +
            '<td class="' + level + '">' + state + '</td>' +
            '<td style="font-size:11px">' + reset + '</td>' +
            '<td>' + score + '</td>';
          el.runtimeTable.appendChild(tr);
        });

        // Events table
        el.eventsTable.innerHTML = '';
        const events = ev.events || [];
        events.forEach(e => {
          const tr = document.createElement('tr');
          const ts = formatTs(e.created_at);
          const type = e.type || '-';
          const payload = shortPayload(e.payload || e.shortPayload || e);
          tr.innerHTML = '<td class="ts">' + ts + '</td><td><code>' + type + '</code></td><td style="font-size:11.5px;">' + payload + '</td>';
          el.eventsTable.appendChild(tr);
        });
      } catch (err) {
        console.error('Monitor load error:', err);
      }
    }

    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
`;
}

export function renderAccountsStatusBoard(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>OCOM Accounts</title>
  <style>
    :root{
      --bg:#0b0b10; --surface:#141419; --border:#2a2a35; --muted:#6b6b7a;
      --text:#e8e8ef; --accent:#6366f1; --ok:#22c55e; --warn:#f59e0b; --crit:#ef4444;
    }
    *{box-sizing:border-box}
    body{font-family:Inter, system-ui, sans-serif; background:var(--bg); color:var(--text); margin:0; padding:24px}
    .container{max-width:1200px; margin:0 auto}
    h2{font-size:18px; margin:24px 0 12px; color:var(--accent); border-bottom:1px solid var(--border); padding-bottom:6px}
    table{width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border); border-radius:8px; overflow:hidden; font-size:11.5px}
    th,td{padding:10px 12px; text-align:left; border-bottom:1px solid var(--border)}
    th{background:#1c1c24; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.4px}
    tr:last-child td{border-bottom:none}
    tr:hover{background:#1a1a22}
    code{background:#22222d; padding:2px 6px; border-radius:4px; font-family:JetBrains Mono, monospace; font-size:11px}
    .dot{display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle}
    .ok .dot{background:var(--ok)} .degraded .dot{background:var(--warn)} .failover .dot{background:var(--crit)} .expired .dot{background:var(--muted)}
  </style>
</head>
<body>
  <div class="container">
    <h2>Cuentas (OAuth)</h2>
    <table id="accounts">
      <thead>
        <tr><th>Estado</th><th>Email / Profile</th><th>Proveedor</th><th>Rotaciones</th><th>Rate limits</th><th>Regla</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script type="module">
    const tbody = document.querySelector('#accounts tbody');

    function renderStatusDot(status) {
      return '<span class="dot"></span>';
    }

    async function load() {
      const res = await fetch('/accounts?includeRevoked=false');
      const data = await res.json();
      tbody.innerHTML = '';
      (data.accounts || []).forEach(acc => {
        const tr = document.createElement('tr');
        tr.className = acc.status;
        const email = (acc.email || acc.profileKey || acc.profileId || '-').replace(/^/,'');
        const provider = acc.provider || '-';
        const rotations = acc.rotations ?? 0;
        const rateLimits = acc.rateLimits ?? 0;
        const ruleName = acc.ruleName || (acc.rule ? acc.rule.name : '') || '-';
        tr.innerHTML = '<td>' + renderStatusDot(acc.status) + acc.status + '</td>' +
          '<td><code>' + email + '</code></td>' +
          '<td>' + provider + '</td>' +
          '<td>' + rotations + '</td>' +
          '<td>' + rateLimits + '</td>' +
          '<td>' + ruleName + '</td>';
        tbody.appendChild(tr);
      });
    }

    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
`;
}