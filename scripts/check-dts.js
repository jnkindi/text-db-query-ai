#!/usr/bin/env node
'use strict';

/**
 * Fails when the public type declarations expose types from the LLM SDKs.
 *
 * The package loads `openai` and `@anthropic-ai/sdk` at runtime only. If an
 * emitted .d.ts imported them, every TypeScript consumer would type-check
 * against whatever SDK version npm resolved for them, and an SDK release could
 * break their build. Optional peer packages (pg, mysql2, ...) are reported as
 * warnings, because consumers who do not install them get missing-type errors.
 *
 * src/ is compiled with the project tsconfig, emitting declarations only and
 * keeping them in memory, so dist/ is neither needed nor touched.
 *
 * Usage: node scripts/check-dts.js
 */

const path = require('path');
const { builtinModules } = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = /^(?:openai|@anthropic-ai\/sdk)(?:\/|$)/;
const BUILTINS = new Set(builtinModules);

/** True for a bare specifier of a package other than Node itself (built-ins, @types/node). */
function isExternal(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return false;
  }
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return !BUILTINS.has(name) && name !== 'node';
}

function loadCompilerOptions() {
  const configPath = path.join(ROOT, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, configPath);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  }
  return {
    fileNames: parsed.fileNames,
    options: {
      ...parsed.options,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      sourceMap: false,
      noEmit: false,
      noEmitOnError: false,
    },
  };
}

function main() {
  const { fileNames, options } = loadCompilerOptions();
  const program = ts.createProgram(fileNames, options);

  const declarations = [];
  const result = program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith('.d.ts')) {
      declarations.push({ file: path.relative(options.outDir || ROOT, fileName), text });
    }
  });

  if (result.emitSkipped || result.diagnostics.length > 0) {
    const host = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    };
    console.error(ts.formatDiagnostics(result.diagnostics, host));
    console.error('check-dts: declaration emit failed');
    process.exit(1);
  }

  const errors = [];
  const warnings = [];
  for (const { file, text } of declarations) {
    // preProcessFile reads import/export/require/import() specifiers and
    // /// <reference types> directives, and skips comments (JSDoc examples).
    const info = ts.preProcessFile(text, true, true);
    for (const ref of [...info.importedFiles, ...info.typeReferenceDirectives]) {
      if (!isExternal(ref.fileName)) continue;
      if (FORBIDDEN.test(ref.fileName)) {
        errors.push(`${file}: references '${ref.fileName}'`);
      } else {
        warnings.push(`${file}: references '${ref.fileName}'`);
      }
    }
  }

  for (const w of warnings) console.warn(`check-dts: warning: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`check-dts: ${e}`);
    console.error('check-dts: public declarations must not expose openai or @anthropic-ai/sdk types');
    process.exit(1);
  }
  console.log(`check-dts: ${declarations.length} declaration files, no SDK types exposed`);
}

main();
