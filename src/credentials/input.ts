interface SecretInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

interface SecretOutput {
  write(value: string): unknown;
}

export interface SecretReaderOptions {
  stdin?: SecretInput;
  stderr?: SecretOutput;
  label?: string;
}

function validateSecret(value: string, label: string): string {
  const secret = value.trim();
  if (!secret) {
    throw new Error(`${label} is required.`);
  }
  if (/[\r\n]/.test(secret)) {
    throw new Error(`${label} must be a single line.`);
  }
  return secret;
}

async function readPipedSecret(stdin: SecretInput, label: string): Promise<string> {
  let value = "";
  for await (const chunk of stdin) {
    value += String(chunk);
  }
  return validateSecret(value, label);
}

function readTerminalSecret(
  stdin: SecretInput,
  stderr: SecretOutput,
  label: string,
): Promise<string> {
  if (!stdin.setRawMode) {
    throw new Error("Terminal does not support hidden input.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    stderr.write(`${label}: `);
    stdin.setEncoding?.("utf8");
    stdin.setRawMode?.(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    const finish = (): void => {
      cleanup();
      stderr.write("\n");
      try {
        resolve(validateSecret(value, label));
      } catch (error) {
        reject(error);
      }
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          stderr.write("\n");
          reject(new Error("Authentication cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
}

export function readSecret(options: SecretReaderOptions = {}): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const label = options.label ?? "DeepSeek API key";
  return stdin.isTTY ? readTerminalSecret(stdin, stderr, label) : readPipedSecret(stdin, label);
}
