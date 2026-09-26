/**
 * .env を「他のモジュールより先に」読むためのモジュール。
 * import は本文より先に評価されるので、server.mjs の先頭で loadEnv() を呼んでも lib/tts.mjs 等の既定値（TTS_VOICE など）には間に合わない。
 * これを最初の import に置くと、以後の import は .env を読んだ状態で評価される。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
loadEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
