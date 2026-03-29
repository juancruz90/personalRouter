import fs from 'fs';
import path from 'path';

const filePath = path.join(process.cwd(), 'project_hub', 'tickets.personal-provider.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const now = new Date('2026-03-26T19:48:00.000Z'); // Current time in UTC as given
const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

const inProgressTickets = data.tickets.filter(t => t.status === 'in_progress');

// Build a map of latest activity per ticket from events
const latestActivity = new Map(); // ticket_id -> timestamp (max)
for (const ev of data.events) {
  if (ev.ticket_id) {
    const ts = new Date(ev.ts);
    if (!latestActivity.has(ev.ticket_id) || ts > latestActivity.get(ev.ticket_id)) {
      latestActivity.set(ev.ticket_id, ts);
    }
  }
}

// Also consider updated_at from ticket itself
for (const t of inProgressTickets) {
  const ticketUpdated = new Date(t.updated_at);
  const currentLatest = latestActivity.get(t.id) || new Date(0);
  if (ticketUpdated > currentLatest) {
    latestActivity.set(t.id, ticketUpdated);
  }
}

// Categorize
const warnings = [];
const alerts = [];

for (const t of inProgressTickets) {
  const lastActivity = latestActivity.get(t.id) || new Date(0);
  const inactiveMs = now - lastActivity;
  const inactiveMin = Math.floor(inactiveMs / (60 * 1000));

  const info = {
    id: t.id,
    title: t.title,
    assignee: t.assignee,
    lastActivity: lastActivity.toISOString(),
    inactiveMin
  };

  if (inactiveMs > 10 * 60 * 1000) {
    alerts.push(info);
  } else if (inactiveMs > 5 * 60 * 1000) {
    warnings.push(info);
  }
}

console.log(JSON.stringify({ warnings, alerts, totalInProgress: inProgressTickets.length, now: now.toISOString() }, null, 2));