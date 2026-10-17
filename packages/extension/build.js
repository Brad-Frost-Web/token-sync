// npm run build:extension — writes dist/extension/, ready to load unpacked
// (chrome://extensions → Load unpacked; about:debugging → Load Temporary Add-on).
//
// MV3 forbids remote code, so Eddie is copied in from the pinned packages
// rather than loaded from a CDN: the components' self-contained CDN build,
// and the bfw theme's tokens, base styles and fonts.

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { bundle, REPO_ROOT } from '../../tools/bundle.js';

const HERE = join(REPO_ROOT, 'packages/extension');
const require = createRequire(join(HERE, 'package.json'));
const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`));

export function buildExtension(out = join(REPO_ROOT, 'dist/extension')) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const script = (entry, file) => writeFileSync(join(out, file), bundle(join(HERE, 'src', entry)));
  script('background.js', 'background.js');
  script('content-entry.js', 'content.js');
  script('popup.js', 'popup.js');
  cpSync(join(HERE, 'manifest.json'), join(out, 'manifest.json'));
  cpSync(join(HERE, 'popup.html'), join(out, 'popup.html'));

  const components = packageRoot('@brad-frost-web/eddie-web-components');
  cpSync(join(components, 'cdn'), join(out, 'eddie/components/cdn'), { recursive: true });
  const tokens = packageRoot('@brad-frost-web/eddie-design-tokens');
  for (const path of ['bfw/build/css', 'bfw/css', 'core/css', 'core/fonts']) {
    cpSync(join(tokens, path), join(out, 'eddie/tokens', path), { recursive: true });
  }

  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log(`built ${buildExtension()}`);
}
