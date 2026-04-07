import { defineTool, Type } from "../interface.js";

export const imageAnalyzeTool = defineTool({
  name: "image_analyze",
  label: "Analyze Image",
  description:
    "Analyze an image from a URL using a vision model. " +
    "Describe what's in the image, extract text (OCR), identify objects, " +
    "or answer questions about the image content. " +
    "Supports JPEG, PNG, GIF, and WebP.",
  parameters: Type.Object({
    url: Type.String({ description: "URL of the image to analyze" }),
    prompt: Type.Optional(
      Type.String({ description: "What to look for or describe. Defaults to general description." })
    ),
  }),
  execute: async (params, signal) => {
    const prompt = params.prompt ?? "Describe this image in detail.";
    const provider = process.env.VISION_PROVIDER ?? process.env.DEFAULT_PROVIDER ?? "openai";

    // Fetch image as base64
    const imgResponse = await fetch(params.url, { signal });
    if (!imgResponse.ok) throw new Error(`Failed to fetch image: ${imgResponse.status}`);

    const contentType = imgResponse.headers.get("content-type") ?? "image/jpeg";
    const buffer = await imgResponse.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const dataUrl = `data:${contentType};base64,${base64}`;

    if (provider === "openai") {
      return openaiVision(params.url, prompt, signal);
    }
    if (provider === "anthropic") {
      return anthropicVision(base64, contentType, prompt, signal);
    }

    throw new Error(`Vision not supported for provider: ${provider}. Set VISION_PROVIDER to openai or anthropic.`);
  },
});

async function openaiVision(imageUrl: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for vision");

  const model = process.env.VISION_MODEL ?? "gpt-4o";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }],
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI Vision error ${response.status}: ${error}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content ?? "No analysis returned";
}

async function anthropicVision(
  base64: string, mediaType: string, prompt: string, signal?: AbortSignal
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required for vision");

  const model = process.env.VISION_MODEL ?? "claude-sonnet-4-5-20250514";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic Vision error ${response.status}: ${error}`);
  }

  const data = await response.json() as any;
  return data.content?.[0]?.text ?? "No analysis returned";
}
