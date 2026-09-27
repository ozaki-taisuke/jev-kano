#!/usr/bin/env node
/**
 * 単体テストをまとめて走らせる: このフォルダの *.test.mjs を全部読み込む（node:test は読み込まれた時点で走る）。
 * `node --test` に任せないのは、Node の版でフォルダの渡し方が違うのと、作業用の写し（.claude/worktrees）の中まで拾うため。
 *   node test/run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort()) await import(pathToFileURL(path.join(here, f)).href);
