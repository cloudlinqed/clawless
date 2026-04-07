import { defineTool, Type } from "../interface.js";

export const ttsTool = defineTool({
  name: "text_to_speech",
  label: "Text to Speech",
  description:
    "Convert text to speech audio. Returns a URL or base64 audio data. " +
    "Use this when the user asks to hear something spoken aloud " +
    "or needs an audio version of text content.",
  parameters: Type.Object({
    text: Type.String({ description: "The text to convert to speech" }),
    voice: Type.Optional(
      Type.String({ description: "Voice to use. OpenAI voices: alloy, echo, fable, onyx, nova, shimmer. Defaults to alloy" })
    ),
    speed: Type.Optional(
      Type.Number({ description: "Speed multiplier (0.25 to 4.0). Defaults to 1.0" })
    ),
  }),
  execute: async (params, signal) => {
    const provider = process.env.TTS_PROVIDER ?? "openai";

    if (provider === "openai") {
      return openaiTts(params.text, params.voice, params.speed, signal);
    }

    throw new Error(`TTS not supported for provider: ${provider}. Set TTS_PROVIDER=openai.`);
  },
});

async function openaiTts(
  text: string, voice?: string, speed?: number, signal?: AbortSignal
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for TTS");

  const model = process.env.TTS_MODEL ?? "tts-1";

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: voice ?? "alloy",
      speed: speed ?? 1.0,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI TTS error ${response.status}: ${error}`);
  }

  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  return JSON.stringify({
    format: "mp3",
    encoding: "base64",
    data: base64,
    textLength: text.length,
    voice: voice ?? "alloy",
  });
}
