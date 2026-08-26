import { readFile, readdir, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Hoists workspace package links into the root node_modules dependency volume.
 * The links remain valid when a mutable worktree bind replaces the image source.
 */
export async function linkWorkspacePackages(rootDirectory) {
  for (const group of ["apps", "packages"]) {
    const groupDirectory = join(rootDirectory, group);
    let entries;
    try {
      entries = await readdir(groupDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDirectory = join(groupDirectory, entry.name);
      let manifestText;
      try {
        manifestText = await readFile(
          join(packageDirectory, "package.json"),
          "utf8"
        );
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const manifest = JSON.parse(manifestText);
      if (!isSafePackageName(manifest.name)) {
        throw new Error(`Invalid workspace package name: ${String(manifest.name)}`);
      }
      const target = join(rootDirectory, "node_modules", ...manifest.name.split("/"));
      await mkdir(dirname(target), { recursive: true });
      // pnpm may already have linked a root dependency; replace only this known package path.
      await rm(target, { recursive: true, force: true });
      await symlink(relative(dirname(target), packageDirectory), target, "dir");
    }
  }
}

/** Package names become filesystem paths, so reject traversal and unsupported forms. */
function isSafePackageName(value) {
  return (
    typeof value === "string" &&
    (/^[a-z0-9][a-z0-9._-]*$/i.test(value) ||
      /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(value))
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await linkWorkspacePackages(process.cwd());
}
