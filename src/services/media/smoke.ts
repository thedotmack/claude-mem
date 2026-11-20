import { convertMedia } from './converter.js';

// Synthetic 1x1 PNG, independent of original files or production screenshots.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DQAAAEgQGADgLFJAAAAABJRU5ErkJggg==';
export async function runMediaRuntimeSmoke(): Promise<void> {
  const result = await convertMedia(Buffer.from(PNG, 'base64'), 'image/png');
  console.log(JSON.stringify({
    mediaRuntime: 'ok', encoder: result.encoderVersion, recipe: result.recipe,
    viewer: { width: result.viewer.width, height: result.viewer.height, bytes: result.viewer.byteLength },
    llm: { width: result.llm.width, height: result.llm.height, bytes: result.llm.byteLength },
  }));
}
