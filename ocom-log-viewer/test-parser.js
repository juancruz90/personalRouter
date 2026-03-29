import { parseLogBlock } from './src/parser.js';

const fs = await import('fs');
const path = await import('path');

const logFile = path.join(process.cwd(), 'test-logs.txt');
const raw = fs.readFileSync(logFile, 'utf-8');
const events = parseLogBlock(raw);

console.log(`Parsed ${events.length} events:`);
events.forEach((ev, idx) => {
  const p = ev.parsed;
  console.log(`${idx + 1}. [${p.name}] runId=${p.runId || '-'} profile=${p.profile || '-'} provider=${p.provider || (p.extra && p.extra.provider) || '-'} reason=${p.reason || (p.extra && p.extra.reason) || '-'} decision=${p.decision || (p.extra && p.extra.decision) || '-'} error=${p.error || (p.extra && p.extra.error) || '-'}`);
});
