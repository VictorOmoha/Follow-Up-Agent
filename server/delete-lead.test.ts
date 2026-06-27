import { describe, it, expect } from 'vitest';
import { createAgentEngine } from './agent-engine';

const sample = {
  name: 'Temp Lead', company: 'Temp Co', service: 'roofing',
  budget: '1000', urgency: 'asap', pain: 'losing leads', channel: 'SMS' as const, contact: '+15550001111',
};

describe('deleteLead cascade', () => {
  it('removes the lead and every record that references it', async () => {
    const engine = createAgentEngine();
    const { lead } = await engine.createLead(sample);
    const id = lead.id;

    let s = engine.getState();
    expect(s.leads).toHaveLength(1);
    expect(s.messages.filter((m) => m.leadId === id).length).toBeGreaterThan(0);
    expect(s.tasks.filter((t) => t.leadId === id).length).toBeGreaterThan(0);
    expect(s.timeline.filter((e) => e.leadId === id).length).toBeGreaterThan(0);
    expect(s.decisions.filter((d) => d.leadId === id).length).toBeGreaterThan(0);

    const result = await engine.deleteLead(id);
    expect(result.deleted).toBe(id);

    s = engine.getState();
    expect(s.leads).toHaveLength(0);
    expect(s.messages.filter((m) => m.leadId === id)).toHaveLength(0);
    expect(s.tasks.filter((t) => t.leadId === id)).toHaveLength(0);
    expect(s.timeline.filter((e) => e.leadId === id)).toHaveLength(0);
    expect(s.decisions.filter((d) => d.leadId === id)).toHaveLength(0);
  });

  it('leaves other leads untouched', async () => {
    const engine = createAgentEngine();
    const a = (await engine.createLead({ ...sample, contact: '+15550000001' })).lead;
    const b = (await engine.createLead({ ...sample, name: 'Keep Me', contact: '+15550000002' })).lead;
    await engine.deleteLead(a.id);
    const s = engine.getState();
    expect(s.leads.map((l) => l.id)).toEqual([b.id]);
  });

  it('throws a 404 for an unknown lead', async () => {
    const engine = createAgentEngine();
    await expect(engine.deleteLead('does-not-exist')).rejects.toThrow(/not found/i);
  });
});
