// The Copilot bridge's turn wait: a long turn that keeps making progress (or waits on the app's tools)
// is not cut off; one where nothing happens is aborted with a clear error.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JavaScript module without types
import { runTurn } from '../../copilot-bridge.mjs';

type Handler = (event: unknown) => void;

function fakeSession(script: (emit: () => void, finish: () => void) => void) {
  const handlers = new Set<Handler>();
  let resolve!: (v: unknown) => void;
  const session = {
    aborted: false,
    on(h: Handler) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    abort() {
      session.aborted = true;
      resolve(undefined);
      return Promise.resolve();
    },
    sendAndWait() {
      const done = new Promise((r) => (resolve = r));
      script(() => handlers.forEach((h) => h({ type: 'assistant.message_delta' })), () => resolve({ data: { content: 'done' } }));
      return done;
    },
  };
  return session;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Copilot bridge turns', () => {
  it('keep going past the stall limit while events arrive or a tool is pending', async () => {
    let busy = false;
    const session = fakeSession(async (emit, finish) => {
      for (let i = 0; i < 6; i++) {
        await sleep(20);
        emit();
      }
      busy = true;
      await sleep(150);
      busy = false;
      emit();
      finish();
    });
    const response = await runTurn(session, { prompt: 'hi' }, { busy: () => busy, stallMs: 60, tick: 5 });
    expect(response).toEqual({ data: { content: 'done' } });
    expect(session.aborted).toBe(false);
  });

  it('abort a turn where nothing happens', async () => {
    const session = fakeSession(() => {});
    await expect(runTurn(session, { prompt: 'hi' }, { stallMs: 40, tick: 5 })).rejects.toThrow(/stopped responding/);
    expect(session.aborted).toBe(true);
  });
});
