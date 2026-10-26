/**
 * A provider that returns scripted answers and records every request, for
 * testing the generator pipeline without an LLM.
 */

import { BaseLLMProvider } from '../../src/providers/base';

export type ScriptedAnswer = string | Error | ((system: string, prompt: string) => string);

export class ScriptedProvider extends BaseLLMProvider {
  readonly calls: Array<{ system: string; prompt: string }> = [];
  private readonly answers: ScriptedAnswer[];

  constructor(answers: ScriptedAnswer[] = []) {
    super({ provider: 'openai', apiKey: 'sk-scripted-test-key' });
    this.answers = [...answers];
  }

  /** Queue more answers. */
  push(...answers: ScriptedAnswer[]): this {
    this.answers.push(...answers);
    return this;
  }

  async generate(): Promise<string> {
    throw new Error('generate() should not be called: the generator uses generateWithSystem()');
  }

  async generateWithSystem(system: string, prompt: string): Promise<string> {
    this.calls.push({ system, prompt });
    const next = this.answers.shift();
    if (next === undefined) throw new Error(`No scripted answer left for call ${this.calls.length}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(system, prompt) : next;
  }

  async validateApiKey(): Promise<boolean> {
    return true;
  }

  getDefaultModel(): string {
    return 'scripted';
  }
}
