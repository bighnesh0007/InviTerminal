import { type BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import type { AiModel } from '../../shared/ai';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';

/** Injectable so tests can stub the model. Streams assistant text; returns the full turn. */
export type ChatStreamer = (
  opts: { model: AiModel; system: string; messages: { role: 'user' | 'assistant'; content: string }[] },
  onDelta: (chunk: string) => void,
  signal: AbortSignal,
) => Promise<string>;

export function interviewerSystem(topic: string): string {
  return (
    `You are a friendly, rigorous technical interviewer running a practice interview on: ${topic}. ` +
    'Ask ONE question at a time and wait for the candidate. After each answer, give brief, specific feedback — ' +
    'what was strong, what to improve, and one concrete pointer — then ask the next question, slightly harder. ' +
    'Keep each turn short (a few sentences). This is practice to help the candidate improve; be encouraging and concrete. ' +
    'Start now by asking the first question (no preamble).'
  );
}

const StartRequest = z.object({ topic: z.string().trim().min(1).max(200) }).strict();
const AnswerRequest = z.object({ answer: z.string().trim().min(1).max(20_000) }).strict();

/**
 * Interview practice: a multi-turn conversation where Claude interviews the
 * user. One session at a time. The user's spoken answer is transcribed
 * locally (7d) in the renderer and submitted here as text.
 */
export function registerPracticeIpc(getWin: () => BrowserWindow | null, streamer: ChatStreamer, getModel: () => AiModel): void {
  let messages: { role: 'user' | 'assistant'; content: string }[] = [];
  let system = '';
  let active: AbortController | null = null;

  const send = (channel: string, ...args: unknown[]) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  async function runTurn(): Promise<void> {
    if (active) throw new Error('A turn is already in progress.');
    active = new AbortController();
    const controller = active;
    try {
      const full = await streamer({ model: getModel(), system, messages }, (c) => send(IPC.practiceDelta, c), controller.signal);
      messages.push({ role: 'assistant', content: full });
      send(IPC.practiceTurn, full);
    } catch (err) {
      send(controller.signal.aborted ? IPC.practiceError : IPC.practiceError, (err as Error).message);
    } finally {
      if (active === controller) active = null;
    }
  }

  ipcMain.handle(IPC.practiceStart, async (e, raw: unknown) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    const { topic } = StartRequest.parse(raw);
    system = interviewerSystem(topic);
    // A minimal kickoff user turn so the first assistant message is the first question.
    messages = [{ role: 'user', content: 'Please begin the interview.' }];
    await runTurn();
  });

  ipcMain.handle(IPC.practiceAnswer, async (e, raw: unknown) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    if (!system) throw new Error('No practice session is running.');
    const { answer } = AnswerRequest.parse(raw);
    messages.push({ role: 'user', content: answer });
    await runTurn();
  });

  ipcMain.on(IPC.practiceCancel, (e) => {
    if (isFromWindow(e, getWin())) active?.abort();
  });
  ipcMain.handle(IPC.practiceEnd, (e) => {
    if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
    active?.abort();
    messages = [];
    system = '';
  });
}
