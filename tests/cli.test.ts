import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { main } from "../src/main.js";

interface Sink {
  stream: Writable;
  text(): string;
}

function sink(): Sink {
  let buffer = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

function io(lines: string[]): { stdin: Readable; stdout: Writable; stderr: Writable } {
  const out = sink();
  const err = sink();
  return { stdin: Readable.from(lines), stdout: out.stream, stderr: err.stream };
}

describe("main", () => {
  it("prints usage to stderr and returns 2 without --stdio", async () => {
    const streams = io([]);
    const err = sink();
    const code = await main([], {
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: err.stream,
    });
    expect(code).toBe(2);
    expect(err.text()).toBe("reading-stone --stdio\n");
  });

  it.each([["--stdio", "extra"], ["--verbose"], ["stdio"]])(
    "rejects argv %p with usage and exit code 2",
    async (...argv) => {
      const streams = io([]);
      const err = sink();
      const code = await main(argv as string[], {
        stdin: streams.stdin,
        stdout: streams.stdout,
        stderr: err.stream,
      });
      expect(code).toBe(2);
      expect(err.text()).toBe("reading-stone --stdio\n");
    },
  );

  it("runs the server on --stdio and returns 0", async () => {
    const out = sink();
    const err = sink();
    const code = await main(["--stdio"], {
      stdin: Readable.from([
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"/abs/project"}}\n{"jsonrpc":"2.0","id":2,"method":"shutdown"}',
      ]),
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    const responses = out
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toHaveLength(2);
    expect((responses[0]?.result as Record<string, unknown>)?.analyzer_name).toBe(
      "reading-stone",
    );
    expect(responses[1]?.result).toEqual({});
  });
});

describe("package metadata", () => {
  it("exposes VERSION 0.1.0", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("declares the expected package.json fields", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBe("reading-stone");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ "reading-stone": "dist/main.js" });
    expect((pkg as { engines?: { node?: string } }).engines?.node).toBe(">=22");
    // Exact pin (review dispatch 44e85014): the runtime consumes the
    // typescript/unstable/* surface, which carries no semver stability
    // guarantee, so a caret range could resolve a breaking 7.x.
    expect(pkg.dependencies).toEqual({ typescript: "7.0.2" });
  });

  it("contains the exact NOTICE attribution text", () => {
    const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");
    expect(notice).toBe(`reading-stone
Copyright 2026 zero-dot-force

This product includes software originally developed in snake-eyes
(https://github.com/zero-dot-force/snake-eyes), licensed under
Apache License 2.0. The JSON-RPC protocol layer is ported from
snake-eyes' Python implementation of the Gaze analyzer protocol.
`);
  });
});

const mainJs = fileURLToPath(new URL("../dist/main.js", import.meta.url));

describe.skipIf(!existsSync(mainJs))("subprocess", () => {
  function readLine(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const index = buffer.indexOf("\n");
        if (index >= 0) {
          stream.off("data", onData);
          resolve(buffer.slice(0, index));
        }
      };
      stream.on("data", onData);
      stream.on("error", reject);
    });
  }

  it("runs the initialize/shutdown lifecycle over real stdio", async () => {
    const child = spawn(process.execPath, [mainJs, "--stdio"]);
    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"/abs/project"}}\n',
    );
    const line = await readLine(child.stdout);
    const response = JSON.parse(line) as {
      result: { analyzer_name: string };
    };
    expect(response.result.analyzer_name).toBe("reading-stone");
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"shutdown"}\n');
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);
  });

  it("exits 2 with usage when --stdio is missing", async () => {
    const child = spawn(process.execPath, [mainJs]);
    const stderr = await new Promise<string>((resolve) => {
      let buffer = "";
      child.stderr.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
      });
      child.stderr.on("end", () => resolve(buffer));
    });
    expect(stderr).toBe("reading-stone --stdio\n");
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(2);
  });
});
