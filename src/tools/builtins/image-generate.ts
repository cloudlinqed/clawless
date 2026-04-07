import { defineTool, Type } from "../interface.js";

export const imageGenerateTool = defineTool({
  name: "image_generate",
  label: "Generate Image",
  description:
    "Generate an image from a text prompt using DALL-E or another image generation API. " +
    "Returns a URL to the generated image. " +
    "Be descriptive in your prompt for best results.",
  parameters: Type.Object({
    prompt: Type.String({ description: "Detailed description of the image to generate" }),
    size: Type.Optional(
      Type.String({ description: "Image size: 1024x1024, 1792x1024, 1024x1792. Defaults to 1024x1024" })
    ),
    quality: Type.Optional(
      Type.String({ description: "Quality: standard or hd. Defaults to standard" })
    ),
  }),
  execute: async (params, signal) => {
    const provider = process.env.IMAGE_PROVIDER ?? "openai";

    if (provider === "openai") {
      return openaiGenerate(params.prompt, params.size, params.quality, signal);
    }

    throw new Error(`Image generation not supported for provider: ${provider}. Set IMAGE_PROVIDER=openai.`);
  },
});

async function openaiGenerate(
  prompt: string, size?: string, quality?: string, signal?: AbortSignal
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for image generation");

  const model = process.env.IMAGE_MODEL ?? "dall-e-3";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: size ?? "1024x1024",
      quality: quality ?? "standard",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI Image error ${response.status}: ${error}`);
  }

  const data = await response.json() as any;
  const imageUrl = data.data?.[0]?.url;
  const revisedPrompt = data.data?.[0]?.revised_prompt;

  if (!imageUrl) throw new Error("No image URL returned");

  return JSON.stringify({
    url: imageUrl,
    revisedPrompt,
    size: size ?? "1024x1024",
  });
}
