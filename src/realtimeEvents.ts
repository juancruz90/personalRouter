export interface RealtimeEvent {
  id: number;
  type: string;
  ts: string;
  payload: EventPayload;
}

export interface EventPayload {
  raw?: string;
  profile?: string;
  profile_label?: string;
  profile_missing?: boolean;
  runId?: string;
  provider?: string;
  reason?: string;
  decision?: string;
  model?: string;
  email?: string;
  ts?: string;
  [key: string]: unknown;
}

export type RealtimeEventListener = (event: RealtimeEvent) => void;

export interface EventEnricher {
  enrich(channel: string, payload: EventPayload): EventPayload;
}

export interface ProfileResolver {
  resolve(profile: string): string | null;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return (local && local.length > 0 ? local[0] : '') + '***@' + domain;
}

export class EmbeddedLogEnricher implements EventEnricher {
  enrich(channel: string, payload: EventPayload): EventPayload {
    if (channel !== 'agent/embedded') return payload;
    const raw = payload.raw;
    if (typeof raw !== 'string') return payload;
    const parsed = parseEmbeddedLogLine(raw);
    if (!parsed) return payload;
    return { ...payload, ...parsed };
  }
}

export class OAuthProfileResolver implements ProfileResolver {
  constructor(private readonly store: Map<string, { email?: string }>) {}
  resolve(profile: string): string | null {
    const meta = this.store.get(profile);
    if (meta?.email) {
      return maskEmail(meta.email);
    }
    return null;
  }
}

function formatTsGMT3(): string {
  const now = new Date();
  // Assuming server runs in local time GMT-3; if UTC, subtract 3h.
  const tzDate = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const dd = String(tzDate.getDate()).padStart(2, '0');
  const mm = String(tzDate.getMonth() + 1).padStart(2, '0');
  const yyyy = tzDate.getFullYear();
  const hh = String(tzDate.getHours()).padStart(2, '0');
  const min = String(tzDate.getMinutes()).padStart(2, '0');
  const ss = String(tzDate.getSeconds()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}:${ss} GMT-3`;
}

export class RealtimeEventsHub {
  private nextId = 1;
  private readonly listeners = new Set<RealtimeEventListener>();
  private readonly recent: RealtimeEvent[] = [];

  constructor(
    private readonly maxRecent = 200,
    private readonly profileMetaStore?: Map<string, { email?: string }>,
    private readonly enricher?: EventEnricher,
    private readonly profileResolver?: ProfileResolver
  ) {}

  publish(type: string, payload: Record<string, unknown> = {}): RealtimeEvent {
    let enriched: EventPayload = payload as EventPayload;

    if (this.enricher) {
      enriched = this.enricher.enrich(type, enriched);
    }

    if (enriched.profile && this.profileResolver) {
      const email = this.profileResolver.resolve(String(enriched.profile));
      if (email) {
        enriched.profile_label = email;
      } else {
        enriched.profile_missing = true;
      }
    }

    enriched.ts = formatTsGMT3();

    const event: RealtimeEvent = {
      id: this.nextId,
      type,
      ts: new Date().toISOString(),
      payload: enriched,
    };

    this.nextId += 1;
    this.recent.push(event);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listRecent(limit = 50): RealtimeEvent[] {
    const normalized = Number.isInteger(limit) ? Math.max(1, Math.min(limit, this.maxRecent)) : 50;
    return this.recent.slice(-normalized);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function parseEmbeddedLogLine(line: string): EventPayload | null {
  try {
    const parts = line.split('[agent/embedded]');
    if (parts.length < 2) return null;
    const message = parts[1].trim();

    const result: EventPayload = {};
    const kvRegex = /([a-zA-Z_][a-zA-Z0-9_]*)=([^\s]+)/g;
    let m;
    while ((m = kvRegex.exec(message)) !== null) {
      (result as Record<string, unknown>)[m[1]] = m[2];
    }

    if (message.startsWith('auth profile failure state updated:')) {
      result.event = 'auth_profile_failure';
    } else if (message.startsWith('embedded run failover decision:')) {
      result.event = 'embedded_failover_decision';
      // Enrich with email from profileId (format "provider:email") if available
      if (result.profileId && typeof result.profileId === 'string') {
        const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        const suffix = (result.profileId as string).includes(':')
          ? (result.profileId as string).slice((result.profileId as string).indexOf(':') + 1)
          : (result.profileId as string);
        if (emailPattern.test(suffix)) {
          result.email = suffix.toLowerCase();
        }
        const providerPart = (result.profileId as string).split(':')[0];
        if (providerPart && providerPart !== suffix) {
          result.provider = providerPart;
        }
      }
      if (result.accountId) {
        result.accountExternalId = result.accountId;
      }
    } else if (message.startsWith('embedded run agent end:')) {
      result.event = 'embedded_run_agent_end';
      // Enrich with email from profileId
      if (result.profileId && typeof result.profileId === 'string') {
        const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        const suffix = (result.profileId as string).includes(':')
          ? (result.profileId as string).slice((result.profileId as string).indexOf(':') + 1)
          : (result.profileId as string);
        if (emailPattern.test(suffix)) {
          result.email = suffix.toLowerCase();
        }
        const providerPart = (result.profileId as string).split(':')[0];
        if (providerPart && providerPart !== suffix) {
          result.provider = providerPart;
        }
      }
      if (result.accountId) {
        result.accountExternalId = result.accountId;
      }
    } else {
      result.event = 'unknown';
    }

    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}
