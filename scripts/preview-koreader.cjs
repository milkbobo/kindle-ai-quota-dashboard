'use strict';
// Reuses the installed AppImage; never collects credentials or live data.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const context = path.join(root, 'docker/koreader-sim');
function run(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker exited with ${result.status}`);
}
const index = process.argv.indexOf('--data');
const data = index >= 0 ? path.resolve(process.argv[index + 1]) : path.join(root, 'examples/kindle.example.json');
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(root, 'state/koreader-preview');
if (!fs.existsSync(data)) throw new Error(`Missing snapshot: ${data}`);
fs.mkdirSync(out, { recursive: true });
if (process.argv.includes('--build') || spawnSync('docker', ['image', 'inspect', 'aiquota-sim'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
  if (!fs.existsSync(path.join(context, 'koreader.AppImage'))) throw new Error('请先将 KOReader Linux x86_64 AppImage 放到 docker/koreader-sim/koreader.AppImage');
  run(['build', '-t', 'aiquota-sim', '-f', path.join(context, 'Dockerfile'), root]);
}
run(['run', '--rm', '--network', 'none',
  '-v', `${path.join(root, 'kindle/koplugin/aiquota.koplugin')}:/opt/koreader/usr/lib/koreader/plugins/aiquota.koplugin:ro`,
  '-v', `${data}:/mnt/us/aiquota/data.json:ro`,
  '-v', `${path.join(context, 'preview.sh')}:/preview.sh:ro`,
  '-v', `${out}:/out`, '-e', `AIQUOTA_TEST=${process.argv.includes('--test') ? 1 : 0}`,
  '--entrypoint', 'bash', 'aiquota-sim', '/preview.sh']);
console.log(`KOReader 截图: ${path.join(out, 'shot.png')}`);
