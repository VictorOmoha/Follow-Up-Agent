import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('webhook api integration', () => {
  it('should ingest webhooks and map fields correctly', async () => {
    const testPort = 8989;
    const proc = spawn('npx', ['tsx', 'server/index.ts'], {
      env: { ...process.env, AGENT_API_PORT: String(testPort) },
      shell: true,
    });

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Server start timed out after 15s'));
        }
      }, 15000);

      proc.stdout?.on('data', (data) => {
        const str = data.toString();
        if (str.includes('Omoha Follow-Up Agent API running on')) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
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
    } finally {
      proc.kill();
    }
  }, 25000); // 25s timeout
});
