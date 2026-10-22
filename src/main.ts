#!/usr/bin/env node
import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Server } from "./server.js";

export interface Io {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io?: Io,
): Promise<number> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;

  if (argv.length !== 1 || argv[0] !== "--stdio") {
    stderr.write("reading-stone --stdio\n");
    return 2;
  }

  if (stdout === process.stdout) {
    stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") {
        stdin.destroy();
      }
    });
  }

  await new Server(stdin, stdout, stderr).run();
  return 0;
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
