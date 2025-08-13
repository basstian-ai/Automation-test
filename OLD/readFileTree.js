import fs from 'fs/promises';
import path from 'path';

const DEFAULT_IGNORED_DIRS = ['node_modules', '.git', '.next', '.vercel', '.vscode'];
const DEFAULT_IGNORED_FILES = ['package-lock.json', '.DS_Store'];

export async function readFileTree(
  dir = '.',
  {
    maxFiles = 50,
    ignoredDirs = DEFAULT_IGNORED_DIRS,
    ignoredFiles = DEFAULT_IGNORED_FILES,
  } = {},
) {
  const result = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      // Skip ignored directories or files
      if (
        ignoredDirs.includes(entry.name) ||
        ignoredFiles.includes(entry.name)
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        const shouldContinue = await walk(fullPath);
        if (!shouldContinue) return false;
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(fullPath, 'utf8');

          result.push({
            path: fullPath,
            content,
          });

          // Limit total number of files
          if (result.length >= maxFiles) return false;
        } catch (err) {
          console.warn(`Could not read file ${fullPath}: ${err.message}`);
        }
      }
    }

    return true;
  }

  await walk(dir);

  return result;
}
