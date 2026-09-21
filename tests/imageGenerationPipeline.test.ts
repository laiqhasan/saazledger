import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  generateStyledImage,
  generateModelImage,
  generateWithProvider,
  callOpenAiImageGeneration,
} from '../server/services/media/imageGenerationProvider';
import { getItemBuffer } from '../server/services/media/galleryPackService';
import { extractBufferFromSource } from '../server/services/media/modelImageGeneratorService';
import { generateControlledModelImage } from '../server/services/media/modelImageGeneratorService';
import { failedSlotResult } from '../server/services/media/productImageGenerationPipeline';
import { analyzeAiDesignAccuracy } from '../server/services/media/accuracyAnalyzerService';

afterEach(() => {
  vi.restoreAllMocks();
});

async function jewelleryBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 212, g: 175, b: 55 } },
  })
    .jpeg()
    .toBuffer();
}

describe('Product-locked image generation pipeline', () => {
  it('never generates jewellery without a source buffer and returns empty URLs', async () => {
    const styled = await generateStyledImage({ productTitle: 'Gold Pendant Set' });
    expect(styled.success).toBe(false);
    expect(styled.generatedImageUrl).toBeFalsy();

    const model = await generateModelImage({ productTitle: 'Gold Pendant Set' });
    expect(model.success).toBe(false);
    expect(model.generatedImageUrl).toBeFalsy();

    const controlled = await generateControlledModelImage({
      sourceImageUrl: '',
      productTitle: 'Gold Pendant Set',
      targetSlot: 'model_1',
    });
    expect(controlled.success).toBe(false);
    expect(controlled.generatedImageUrl).toBeFalsy();

    const failed = failedSlotResult('no source');
    expect(failed.success).toBe(false);
    expect(failed.generatedImageUrl).toBeFalsy();
  });

  it('OpenAI product-locked generation uses images/edits with the source attached, never generations', async () => {
    const source = await jewelleryBuffer();
    const out = await jewelleryBuffer();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: out.toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAiImageGeneration(
      'edit jewellery',
      source,
      'test-openai-key',
      'gpt-image-2.5-sunburst'
    );
    expect(result?.buffer.length).toBeGreaterThan(100);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/images/edits');
    expect(String(url)).not.toContain('/generations');
    const entries = Array.from((init?.body as FormData).entries());
    expect(entries.some(([key]) => key === 'image')).toBe(true);

    const noSource = await generateWithProvider({
      provider: 'openai',
      prompt: 'invent a necklace',
      sourceBuffer: Buffer.alloc(0),
      openaiApiKey: 'test-openai-key',
    });
    expect(noSource).toBeNull();
  });

  it('getItemBuffer rejects path traversal and non-app remote URLs', async () => {
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-secret-'));
    const secretFile = path.join(secretDir, 'secret.png');
    const png = await jewelleryBuffer();
    fs.writeFileSync(secretFile, png);

    expect(getItemBuffer({ url: secretFile })).toBeNull();
    expect(getItemBuffer({ localPath: secretFile })).toBeNull();
    expect(getItemBuffer({ url: '../../../etc/passwd' })).toBeNull();
    expect(getItemBuffer({ url: 'https://evil.example/steal.png' })).toBeNull();

    const remote = await extractBufferFromSource('https://evil.example/steal.png');
    expect(remote).toBeNull();
  });

  it('does not copy request-body keys onto process.env and ignores mockScore outside test production handling', async () => {
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const src = readServerSnippet();
    expect(src).not.toMatch(/process\.env\.GEMINI_API_KEY\s*=\s*geminiApiKey/);
    expect(src).not.toMatch(/process\.env\.OPENAI_API_KEY\s*=\s*openaiApiKey/);
    expect(src).toMatch(/mockScoreForTests: process\.env\.NODE_ENV === 'test' \? mockScoreForTests : undefined/);

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const analysis = await analyzeAiDesignAccuracy({
      mockScoreForTests: 12,
      originalBase64: `data:image/jpeg;base64,${(await jewelleryBuffer()).toString('base64')}`,
      generatedBase64: `data:image/jpeg;base64,${(await jewelleryBuffer()).toString('base64')}`,
      productTitle: 'Gold Pendant',
    });
    expect(analysis.accuracyScore).not.toBe(12);
    process.env.NODE_ENV = originalNodeEnv;

    if (previousGemini) process.env.GEMINI_API_KEY = previousGemini;
    if (previousOpenAi) process.env.OPENAI_API_KEY = previousOpenAi;
  });
});

function readServerSnippet(): string {
  return fs.readFileSync('/workspace/server/server.ts', 'utf8');
}
