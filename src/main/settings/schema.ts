import { z } from 'zod';
import { APP_ACTIONS, chordProblem, keymapProblems, type Keymap } from '../../shared/keymap';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { AI_MODELS } from '../../shared/ai';
import { SPEAKER_MODES } from '../../shared/audio';
import { isValidGlobalAccelerator } from '../visibility/accelerator';

const Chord = z.string().max(40).superRefine((s, ctx) => {
  const p = chordProblem(s);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});

const d = DEFAULT_SETTINGS;

/** The whole settings file. Unknown keys are refused; missing sections get defaults. */
export const SettingsSchema = z
  .object({
    version: z.literal(1),
    terminal: z
      .object({
        fontSize: z.number().int().min(8).max(32).default(d.terminal.fontSize),
        scrollback: z.number().int().min(500).max(100_000).default(d.terminal.scrollback),
        defaultProfile: z.string().regex(/^[a-z0-9-]{1,64}$/).nullable().default(d.terminal.defaultProfile),
      })
      .strict()
      .prefault({}),
    shortcuts: z
      .object(Object.fromEntries(APP_ACTIONS.map((a) => [a, Chord.default(d.shortcuts[a])])) as Record<keyof Keymap, z.ZodDefault<typeof Chord>>)
      .strict()
      .prefault({})
      .superRefine((km, ctx) => {
        for (const [action, message] of Object.entries(keymapProblems(km as Keymap))) ctx.addIssue({ code: 'custom', path: [action], message: message! });
      }),
    library: z
      .object({
        mongoUri: z.string().min(1).max(2000).default(d.library.mongoUri),
        allowRemote: z.boolean().default(d.library.allowRemote),
      })
      .strict()
      .prefault({}),
    globalShortcut: z.string().refine(isValidGlobalAccelerator, 'not a valid global shortcut (needs a modifier)').nullable().default(d.globalShortcut),
    ai: z
      // A model ID that was removed from Groq (e.g. the retired Llama 3.x) falls back to the
      // default instead of invalidating the whole settings file.
      .object({
        model: z.enum(AI_MODELS).catch(d.ai.model).default(d.ai.model),
        autoExplainErrors: z.boolean().default(d.ai.autoExplainErrors),
      })
      .strict()
      .prefault({}),
    stt: z
      .object({
        modelPath: z.string().max(4096).nullable().default(d.stt.modelPath),
        binaryPath: z.string().max(4096).nullable().default(d.stt.binaryPath),
      })
      .strict()
      .prefault({}),
    tts: z
      .object({
        binaryPath: z.string().max(4096).nullable().default(d.tts.binaryPath),
        voice: z.string().max(64).nullable().default(d.tts.voice),
      })
      .strict()
      .prefault({}),
    companion: z
      .object({
        port: z
          .number()
          .int()
          .min(0)
          .max(65535)
          .refine((p) => p === 0 || p >= 1024, 'use 0 (random) or a port between 1024 and 65535')
          .default(d.companion.port),
        rememberPairing: z.boolean().default(d.companion.rememberPairing),
        autoStart: z.boolean().default(d.companion.autoStart),
        sendTranscript: z.boolean().default(d.companion.sendTranscript),
        mdns: z.boolean().default(d.companion.mdns),
      })
      .strict()
      .prefault({}),
    liveTranscript: z
      .object({
        source: z.string().max(256).nullable().default(d.liveTranscript.source),
        chunkSeconds: z.number().int().min(3).max(30).default(d.liveTranscript.chunkSeconds),
        tdrzModelPath: z.string().max(4096).nullable().default(d.liveTranscript.tdrzModelPath),
        speakerMode: z.enum(SPEAKER_MODES).catch(d.liveTranscript.speakerMode).default(d.liveTranscript.speakerMode),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** A patch from the settings UI: same shapes, every field optional, nothing extra. */
export const SettingsPatchSchema = z
  .object({
    terminal: z.object({ fontSize: z.number(), scrollback: z.number(), defaultProfile: z.string().nullable() }).partial().strict().optional(),
    shortcuts: z.object(Object.fromEntries(APP_ACTIONS.map((a) => [a, z.string().max(40)])) as Record<keyof Keymap, z.ZodString>).partial().strict().optional(),
    library: z.object({ mongoUri: z.string().max(2000), allowRemote: z.boolean() }).partial().strict().optional(),
    globalShortcut: z.string().max(60).nullable().optional(),
    ai: z.object({ model: z.enum(AI_MODELS), autoExplainErrors: z.boolean() }).partial().strict().optional(),
    stt: z.object({ modelPath: z.string().max(4096).nullable(), binaryPath: z.string().max(4096).nullable() }).partial().strict().optional(),
    tts: z.object({ binaryPath: z.string().max(4096).nullable(), voice: z.string().max(64).nullable() }).partial().strict().optional(),
    companion: z.object({ port: z.number().int().min(0).max(65535).refine((p) => p === 0 || p >= 1024, 'use 0 (random) or a port between 1024 and 65535'), rememberPairing: z.boolean(), autoStart: z.boolean(), sendTranscript: z.boolean(), mdns: z.boolean() }).partial().strict().optional(),
    liveTranscript: z.object({ source: z.string().max(256).nullable(), chunkSeconds: z.number().int().min(3).max(30), tdrzModelPath: z.string().max(4096).nullable(), speakerMode: z.enum(SPEAKER_MODES) }).partial().strict().optional(),
  })
  .strict();
