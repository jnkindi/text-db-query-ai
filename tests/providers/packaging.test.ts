/**
 * Checks on a fresh `tsc` build of src/, run in a separate Node process:
 * - importing the package loads neither SDK; each loads when its provider is created
 * - the emitted .d.ts files never reference SDK types
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SDK_IMPORT = /(?:from\s+|import\(\s*|require\(\s*|reference\s+types=)['"](?:openai|@anthropic-ai\/sdk)(?:\/[^'"]*)?['"]/;

let outDir: string;

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-db-query-ai-build-'));
  const tsc = require.resolve('typescript/bin/tsc');
  const build = spawnSync(
    process.execPath,
    [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', outDir, '--sourceMap', 'false', '--declarationMap', 'false'],
    { encoding: 'utf8' }
  );
  if (build.status !== 0) {
    throw new Error(`tsc failed:\n${build.stdout}${build.stderr}`);
  }
  // Let the build resolve the SDKs the way an installed package would.
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(outDir, 'node_modules'), 'junction');
}, 120000);

afterAll(() => {
  if (!outDir) return;
  // Remove the link itself first, so the cleanup can never reach the real node_modules.
  fs.rmSync(path.join(outDir, 'node_modules'), { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

function declarationFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : declarationFiles(file);
    return entry.name.endsWith('.d.ts') ? [file] : [];
  });
}

describe('package build', () => {
  it('loads each SDK only when its provider is created', () => {
    const script = `
      const loaded = () => [...new Set(Object.keys(require.cache)
        .map((file) => (file.match(/node_modules[\\\\/](openai|@anthropic-ai[\\\\/]sdk)[\\\\/]/) || [])[1])
        .filter(Boolean)
        .map((name) => name.replace('\\\\', '/')))].sort();
      const pkg = require(process.argv[1]);
      const stages = { afterImport: loaded() };
      new pkg.ClaudeProvider({ provider: 'claude', apiKey: 'test' });
      stages.afterClaude = loaded();
      pkg.createLLMProvider({ provider: 'openai', apiKey: 'test' });
      stages.afterOpenAI = loaded();
      console.log(JSON.stringify(stages));
    `;
    const run = spawnSync(process.execPath, ['-e', script, outDir], { cwd: outDir, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      afterImport: [],
      afterClaude: ['@anthropic-ai/sdk'],
      afterOpenAI: ['@anthropic-ai/sdk', 'openai'],
    });
  });

  it('emits provider declarations without SDK types', () => {
    const files = declarationFiles(outDir);
    for (const name of ['base.d.ts', 'openai.d.ts', 'claude.d.ts', 'index.d.ts']) {
      expect(files).toContain(path.join(outDir, 'providers', name));
    }
    const offending = files.filter((file) => SDK_IMPORT.test(fs.readFileSync(file, 'utf8')));
    expect(offending.map((file) => path.relative(outDir, file))).toEqual([]);
  });
});
