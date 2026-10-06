import fs from 'fs';
import path from 'path';

export type Status = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';
export interface Check { phase: string; id: string; name: string; status: Status; detail?: string; at: string }

export class Recorder {
  checks: Check[] = [];
  screenshots: string[] = [];
  notes: string[] = [];
  phase = 'setup';
  constructor(private log: (s: string) => void) {}

  setPhase(p: string) { this.phase = p; this.log(`\n== ${p} ==`); }

  add(status: Status, id: string, name: string, detail?: string) {
    this.checks.push({ phase: this.phase, id, name, status, detail, at: new Date().toISOString() });
    this.log(`${status.padEnd(4)} ${id} ${name}${detail ? ` -- ${detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  }
  pass(id: string, name: string, detail?: string) { this.add('PASS', id, name, detail); }
  fail(id: string, name: string, detail?: string) { this.add('FAIL', id, name, detail); }
  info(id: string, name: string, detail?: string) { this.add('INFO', id, name, detail); }
  skip(id: string, name: string, detail?: string) { this.add('SKIP', id, name, detail); }
  /** Records PASS/FAIL and never throws, so one failed assertion does not hide the rest of the run. */
  check(id: string, name: string, ok: boolean, detail?: string) { this.add(ok ? 'PASS' : 'FAIL', id, name, detail); return ok; }

  /** Runs a step; an exception becomes a FAIL (with message) instead of aborting the whole run. */
  async step<T>(id: string, name: string, fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn(); } catch (e: any) { this.fail(id, name + ' (step threw)', String(e?.message || e).split('\n').slice(0, 4).join(' | ')); return undefined; }
  }

  counts() {
    const c = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 } as Record<Status, number>;
    for (const k of this.checks) c[k.status]++;
    return c;
  }
}

export function writeReports(outDir: string, meta: Record<string, unknown>, rec: Recorder, banner: string, serverLogTail: string) {
  const c = rec.counts();
  const json = { banner, ...meta, summary: c, ok: c.FAIL === 0, checks: rec.checks, screenshots: rec.screenshots, notes: rec.notes };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(json, null, 2));
  const lines: string[] = [];
  lines.push('='.repeat(100), banner, '='.repeat(100));
  for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  lines.push('', `RESULT: ${c.FAIL === 0 ? 'ALL CHECKS PASSED' : `${c.FAIL} CHECK(S) FAILED`}  (PASS ${c.PASS}, FAIL ${c.FAIL}, SKIP ${c.SKIP}, INFO ${c.INFO})`, '');
  let phase = '';
  for (const k of rec.checks) {
    if (k.phase !== phase) { phase = k.phase; lines.push('', `[${phase}]`); }
    lines.push(`  ${k.status.padEnd(4)} ${k.id}  ${k.name}${k.detail ? `\n         ${k.detail.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
  }
  if (rec.notes.length) lines.push('', 'NOTES:', ...rec.notes.map((n) => `  - ${n}`));
  lines.push('', 'SCREENSHOTS:', ...rec.screenshots.map((s) => `  ${s}`));
  lines.push('', banner);
  fs.writeFileSync(path.join(outDir, 'report.txt'), lines.join('\n') + '\n');
  if (c.FAIL > 0 && serverLogTail) fs.writeFileSync(path.join(outDir, 'server-log-tail.txt'), serverLogTail);
}
