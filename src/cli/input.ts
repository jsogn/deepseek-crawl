import { open } from "node:fs/promises";

const MAX_CLI_INPUT_BYTES = 8 * 1024 * 1024;

function oversized(label: string): Error {
  return new Error(`${label} exceeds the 8 MiB input limit.`);
}

export async function readTextFileBounded(path: string, label: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (metadata.size > MAX_CLI_INPUT_BYTES) {
      throw oversized(label);
    }
    const content = await handle.readFile();
    if (content.byteLength > MAX_CLI_INPUT_BYTES) {
      throw oversized(label);
    }
    return content.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readStdinBounded(
  stream: NodeJS.ReadableStream,
  label: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > MAX_CLI_INPUT_BYTES) {
      throw oversized(label);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonFileBounded(path: string, label: string): Promise<unknown> {
  const text = await readTextFileBounded(path, label);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}
