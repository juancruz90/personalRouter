// OCOM Log Parser - P0
// Parsing 100% local, sin LLM. Extrae eventos estructurados de líneas de log del gateway.

const LINE_PATTERNS = [
  {
    name: 'auth_profile_failure',
    regex: /\[agent\/embedded\] auth profile failure state updated: runId=([0-9a-f-]+) profile=(sha256:[0-9a-f]+) provider=([^\s]+) reason=([^\s]+) window=([^\s]+) reused=(true|false)/,
    keys: ['runId', 'profile', 'provider', 'reason', 'window', 'reused']
  },
  {
    name: 'embedded_failover_decision',
    regex: /\[agent\/embedded\] embedded run failover decision: runId=([0-9a-f-]+) stage=([^\s]+) decision=([^\s]+) reason=([^\s]+) provider=([^\s]+(?:\/[^\s]+)?) profile=(sha256:[0-9a-f]+)/,
    keys: ['runId', 'stage', 'decision', 'reason', 'provider', 'profile']
  },
  {
    name: 'embedded_run_agent_end',
    regex: /\[agent\/embedded\] embedded run agent end: runId=([0-9a-f-]+) isError=(true|false) model=([^\s]+) provider=([^\s]+(?:\/[^\s]+)?)(?: error=([^\s]+) rawError=([^\s][^\r\n]*))?/,
    keys: ['runId', 'isError', 'model', 'provider', 'error', 'rawError']
  },
  // Patrón genérico para pares clave=valor sueltos dentro de la línea (después del marcador)
  {
    name: 'generic_kv',
    regex: /(?:^|\s)([a-zA-Z0-9_\.-]+)=([^\s]+)/g, // se usa con matchAll
    generic: true
  }
];

function parseLine(line) {
  const result = {
    raw: line,
    timestamp: null,
    level: 'info',
    context: 'gateway',
    parsed: {}
  };

  // Extraer timestamp inicial si existe: [Sat 2026-03-28 18:53 GMT-3]
  const tsMatch = line.match(/\[([A-Za-z]{3} [\d\s:-]+ [A-Za-z]{3,})\]/);
  if (tsMatch) {
    result.timestamp = tsMatch[1];
    line = line.slice(tsMatch[0].length);
  }

  // Extraer nivel entre corchetes: [error], [warn], etc.
  const levelMatch = line.match(/\[([a-z]+)\]$/);
  if (levelMatch) {
    result.level = levelMatch[1];
  }

  // Intentar cada patrón conocido (excepto genérico)
  for (const pattern of LINE_PATTERNS) {
    if (pattern.generic) continue;
    const m = line.match(pattern.regex);
    if (m) {
      result.parsed.name = pattern.name;
      for (let i = 0; i < pattern.keys.length; i++) {
        result.parsed[pattern.keys[i]] = m[i + 1];
      }
      // Capturar adicionalmente cualquier otro kv=vv en el resto de la línea
      const remaining = line.slice(m[0].length);
      result.parsed.extra = parseGenericKV(remaining);
      return result;
    }
  }

  // Fallback: solo extraer pares clave=valor genéricos (mínimo uno)
  const generic = parseGenericKV(line);
  if (Object.keys(generic).length > 0) {
    result.parsed.name = 'generic';
    result.parsed.extra = generic;
  } else {
    result.parsed.name = 'unknown';
  }

  return result;
}

function parseGenericKV(text) {
  const kv = {};
  // regex global para capturar múltiples key=value
  const genericPattern = /([a-zA-Z0-9_\.-]+)=([^\s]+)/g;
  let match;
  while ((match = genericPattern.exec(text)) !== null) {
    kv[match[1]] = match[2];
  }
  return kv;
}

function parseLogBlock(block) {
  // block: string o array de líneas
  const lines = Array.isArray(block) ? block : block.split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    events.push(parseLine(line));
  }
  return events;
}

// Clasificación de nivel por contenido
function classifyEvent(parsed) {
  const { name, extra } = parsed;
  if (name.includes('failure') || name.includes('error') || extra?.error || extra?.isError === 'true') {
    return 'error';
  }
  if (name.includes('failover') || extra?.reason === 'rate_limit' || extra?.reason === 'cooldown') {
    return 'warn';
  }
  return 'info';
}

// Ayuda para truncar hash sha256
function shortProfile(profile) {
  if (!profile) return profile;
  return profile.replace(/^sha256:([0-9a-f]{8}).*$/, 'sha256:$1…');
}

// Enriquecer eventos con email resuelto (integrado)
function enrichWithEmail(event, profileEmailMap) {
  // Si ya tiene email en la línea, preferirlo
  if (event.parsed.email) return event;
  const profile = event.parsed.profile || event.parsed.extra?.profile;
  if (profile && profileEmailMap[profile]) {
    event.parsed.email = profileEmailMap[profile];
  }
  return event;
}

export { parseLine, parseLogBlock, classifyEvent, shortProfile, enrichWithEmail };
