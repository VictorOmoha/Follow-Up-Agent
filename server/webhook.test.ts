import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function getTestPort() {
  return 18_989 + Number(process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || 0);
}

describe('webhook api integration', () => {
  it('should ingest webhooks and map fields correctly', async () => {
    const testPort = getTestPort();
    const proc = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
      env: { ...process.env, AGENT_API_PORT: String(testPort), AGENT_PERSISTENCE: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      let output = '';
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          proc.kill('SIGTERM');
          reject(new Error(`Server start timed out after 15s. Output:\n${output}`));
        }
      }, 15000);

      const onData = (data: Buffer) => {
        const str = data.toString();
        output += str;
        if (str.includes('Omoha Follow-Up Agent API running on')) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      proc.on('exit', (code, signal) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Server exited before listening: code=${code} signal=${signal}. Output:\n${output}`));
        }
      });
    });

    try {
      // 1. Standard payload check
      const res1 = await fetch(`http://127.0.0.1:${testPort}/api/webhooks/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Sarah Webhook',
          company: 'Webhook Corp',
          email: 'sarah@example.com',
          service: 'legal intake help',
          budget: 5000,
          urgency: 'ASAP',
          pain: 'Too many calls to handle',
          channel: 'sms',
        }),
      });

      expect(res1.status).toBe(201);
      const data1 = await res1.json() as { lead: { name: string; channel: string; budget: string } };
      expect(data1.lead.name).toBe('Sarah Webhook');
      expect(data1.lead.channel).toBe('SMS');
      expect(data1.lead.budget).toBe('5000');

      // 2. Non-standard variations mapping check
      const res2 = await fetch(`http://127.0.0.1:${testPort}/api/webhooks/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'John',
          lastName: 'Smith',
          org: 'Smith & Co',
          preferredChannel: 'Email',
          budgetAmount: 2500,
          timeline: 'next week',
          description: 'broken pipes',
          phone: '123-456-7890',
        }),
      });

      expect(res2.status).toBe(201);
      const data2 = await res2.json() as { lead: { name: string; company: string; budget: string; urgency: string; pain: string; contact: string } };
      expect(data2.lead.name).toBe('John Smith');
      expect(data2.lead.company).toBe('Smith & Co');
      expect(data2.lead.budget).toBe('2500');
      expect(data2.lead.urgency).toBe('next week');
      expect(data2.lead.pain).toBe('broken pipes');
      expect(data2.lead.contact).toBe('123-456-7890');

      // 3. Twilio inbound SMS: E.164 sender must match the dash-formatted lead
      const res3 = await fetch(`http://127.0.0.1:${testPort}/api/sms/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'From=%2B11234567890&Body=Yes%2C%20tomorrow%20at%2010%20works%20for%20me.',
      });
      expect(res3.status).toBe(200);
      expect(await res3.text()).toBe('<Response></Response>');

      const stateRes = await fetch(`http://127.0.0.1:${testPort}/api/state`);
      const state = await stateRes.json() as {
        leads: Array<{ name: string; status: string }>;
        messages: Array<{ direction: string; body: string }>;
      };
      // Reply attached to the existing John Smith lead (no duplicate created)
      const johnSmithLeads = state.leads.filter((l) => l.name === 'John Smith');
      expect(johnSmithLeads).toHaveLength(1);
      expect(johnSmithLeads[0].status).toBe('needs_human');
      expect(state.messages).toContainEqual(expect.objectContaining({ direction: 'inbound', body: 'Yes, tomorrow at 10 works for me.' }));
    } finally {
      proc.kill('SIGTERM');
    }
  }, 25000); // 25s timeout
});
