import { exec as execCb } from "child_process";
import { promisify } from "util";
import { logger } from "./logger.js";

const execAsync = promisify(execCb);

export interface ShellOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  ignoreErrors?: boolean;
  label?: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function shell(
  command: string,
  options: ShellOptions = {}
): Promise<string> {
  const {
    timeout = 10_000,
    retries = 0,
    retryDelay = 1_000,
    ignoreErrors = false,
    label,
  } = options;

  const tag = label || command.slice(0, 60);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        logger.debug(`Retry ${attempt}/${retries} for "${tag}" after ${delay}ms`);
        await sleep(delay);
      }

      logger.debug(`Executing: "${tag}"`, { timeout, attempt });

      const result = await execAsync(command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB — large schema dumps
        env: { ...process.env },
      });

      return result.stdout.trim();
    } catch (error: any) {
      const isLastAttempt = attempt >= retries;

      if (error.killed) {
        logger.warn(`Command timed out after ${timeout}ms: "${tag}"`);
      } else {
        logger.debug(`Command failed: "${tag}"`, {
          code: error.code,
          stderr: error.stderr?.slice(0, 200),
        });
      }

      if (isLastAttempt) {
        if (ignoreErrors) {
          logger.debug(`Ignoring error for "${tag}"`);
          return "";
        }
        throw new Error(
          `Shell command failed: ${tag}\n${error.message || error.stderr || "Unknown error"}`
        );
      }
    }
  }

  // Unreachable, but TypeScript needs it
  return "";
}
