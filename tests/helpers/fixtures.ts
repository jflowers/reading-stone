import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FixtureTree {
  root: string;
  cleanup: () => Promise<void>;
}

export async function createFixtureTree(
  files: Readonly<Record<string, string>>,
): Promise<FixtureTree> {
  const root = await mkdtemp(join(tmpdir(), "reading-stone-"));
  await Promise.all(
    Object.entries(files).map(async ([relPath, contents]) => {
      const target = join(root, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
