#!/usr/bin/env node
// Builds "SMS Automation.app" and a drag-to-install DMG for macOS.
//
//   npm run package:mac
//
// The app bundles the dashboard, the server and an official Node.js runtime for
// Apple Silicon and Intel Macs, so nothing else needs to be installed.
// On macOS the DMG is made with hdiutil; elsewhere (e.g. Linux CI) it needs
// `xorriso` for the HFS+ filesystem and uses scripts/macos/udif.mjs for the DMG.
//
// Environment:
//   MAC_NODE_VERSION  Node.js version to bundle: "22" (latest 22.x, default) or e.g. "v22.23.4"
//   MAC_ARCHS         "arm64,x64" (default), "arm64" or "x64"
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { releaseOrphanBlocks } from './macos/hfs.mjs';
import { readUdif, writeUdif } from './macos/udif.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = 'SMS Automation';
const BUNDLE_ID = 'app.smsautomation.desktop';
const OUT = path.join(ROOT, 'build', 'macos');
const CACHE = path.join(OUT, 'cache');
const APP = path.join(OUT, `${APP_NAME}.app`);
const STAGING = path.join(OUT, 'dmg');
const DMG = path.join(OUT, `SMS-Automation-${PKG.version}.dmg`);
const ASSETS = path.join(ROOT, 'packaging', 'macos');
const ARCHS = (process.env.MAC_ARCHS ?? 'arm64,x64').split(',').map((a) => a.trim());

const log = (msg) => console.log(`• ${msg}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function which(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveNodeVersion() {
  const wanted = process.env.MAC_NODE_VERSION ?? '22';
  if (/^v?\d+\.\d+\.\d+$/.test(wanted)) return wanted.startsWith('v') ? wanted : `v${wanted}`;
  const index = JSON.parse((await fetchBuffer('https://nodejs.org/dist/index.json')).toString('utf8'));
  const match = index.find((r) => r.version.startsWith(`v${wanted}.`) && r.files.includes('osx-arm64-tar') && r.files.includes('osx-x64-tar'));
  if (!match) throw new Error(`No Node.js ${wanted}.x release with macOS builds found`);
  return match.version;
}

async function nodeRuntime(version, arch) {
  mkdirSync(CACHE, { recursive: true });
  const name = `node-${version}-darwin-${arch}`;
  const tarball = path.join(CACHE, `${name}.tar.gz`);
  if (!existsSync(tarball)) {
    log(`Downloading Node.js ${version} for macOS ${arch}`);
    writeFileSync(tarball, await fetchBuffer(`https://nodejs.org/dist/${version}/${name}.tar.gz`));
  }
  const sums = path.join(CACHE, `SHASUMS256-${version}.txt`);
  if (!existsSync(sums)) writeFileSync(sums, await fetchBuffer(`https://nodejs.org/dist/${version}/SHASUMS256.txt`));
  const expected = readFileSync(sums, 'utf8')
    .split('\n')
    .find((line) => line.endsWith(`  ${name}.tar.gz`))
    ?.split(' ')[0];
  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (!expected || expected !== actual) {
    rmSync(tarball, { force: true });
    throw new Error(`Checksum mismatch for ${name}.tar.gz`);
  }
  const extractTo = path.join(CACHE, name);
  if (!existsSync(path.join(extractTo, name, 'bin', 'node'))) {
    mkdirSync(extractTo, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', extractTo, `${name}/bin/node`, `${name}/LICENSE`]);
  }
  return path.join(extractTo, name);
}

function infoPlist() {
  const v = PKG.version;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${APP_NAME}</string>
	<key>CFBundleExecutable</key>
	<string>${APP_NAME}</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>${BUNDLE_ID}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${APP_NAME}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${v}</string>
	<key>CFBundleVersion</key>
	<string>${v}</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
`;
}

/** Makes every directory 755 and every file 644, except the given executables (755). */
function normalizePermissions(dir, executables) {
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const entry of execFileSync('ls', ['-A', p], { encoding: 'utf8' }).split('\n').filter(Boolean)) walk(path.join(p, entry));
    } else {
      chmodSync(p, executables.has(p) ? 0o755 : 0o644);
    }
  };
  walk(dir);
}

async function buildApp() {
  if (!existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) {
    throw new Error('dist/web is missing. Run "npm run build:web" first (npm run package:mac does this for you).');
  }
  rmSync(APP, { recursive: true, force: true });
  const contents = path.join(APP, 'Contents');
  const resources = path.join(contents, 'Resources');
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  mkdirSync(path.join(resources, 'server'), { recursive: true });

  log('Bundling the server');
  await build({
    entryPoints: [path.join(ROOT, 'server', 'index.ts')],
    outfile: path.join(resources, 'server', 'server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'eof',
    logLevel: 'warning',
  });
  cpSync(path.join(ASSETS, 'detach.cjs'), path.join(resources, 'server', 'detach.cjs'));
  cpSync(path.join(ROOT, 'dist', 'web'), path.join(resources, 'web'), { recursive: true });
  cpSync(path.join(ASSETS, 'AppIcon.icns'), path.join(resources, 'AppIcon.icns'));
  writeFileSync(path.join(contents, 'Info.plist'), infoPlist());
  writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
  const launcher = path.join(contents, 'MacOS', APP_NAME);
  cpSync(path.join(ASSETS, 'launcher.sh'), launcher);

  const version = await resolveNodeVersion();
  const executables = new Set([launcher]);
  for (const arch of ARCHS) {
    const runtime = await nodeRuntime(version, arch);
    const dest = path.join(resources, 'runtime', `darwin-${arch}`);
    mkdirSync(dest, { recursive: true });
    cpSync(path.join(runtime, 'bin', 'node'), path.join(dest, 'node'));
    cpSync(path.join(runtime, 'LICENSE'), path.join(dest, 'LICENSE'));
    executables.add(path.join(dest, 'node'));
  }
  normalizePermissions(APP, executables);
  log(`Built ${path.relative(ROOT, APP)} with Node.js ${version} (${ARCHS.join(', ')})`);
  return version;
}

function buildDmg() {
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  cpSync(APP, path.join(STAGING, `${APP_NAME}.app`), { recursive: true, preserveTimestamps: true });
  cpSync(path.join(ASSETS, 'How to install.txt'), path.join(STAGING, 'How to install.txt'));
  chmodSync(path.join(STAGING, 'How to install.txt'), 0o644);
  symlinkSync('/Applications', path.join(STAGING, 'Applications'));
  rmSync(DMG, { force: true });

  if (process.platform === 'darwin' && which('hdiutil')) {
    log('Creating DMG with hdiutil');
    execFileSync('hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', STAGING, '-ov', '-format', 'UDZO', DMG], { stdio: 'inherit' });
    return;
  }
  if (!which('xorriso')) throw new Error('Building a DMG on this platform needs xorriso (e.g. "apt-get install xorriso").');
  log('Creating HFS+ disk image with xorriso');
  const raw = path.join(OUT, 'dmg.raw');
  rmSync(raw, { force: true });
  execFileSync(
    'xorriso',
    ['-as', 'mkisofs', '-quiet', '-V', APP_NAME, '-hfsplus', '-apm-block-size', '512', '-R', '-o', raw, STAGING],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  // xorriso writes an ISO 9660 + HFS+ hybrid behind an Apple partition map. Keep only the HFS+
  // volume, so the DMG holds a plain HFS+ disk, the same layout as `hdiutil create -layout NONE`.
  const hfs = path.join(OUT, 'dmg.hfs');
  extractHfsPartition(raw, hfs);
  rmSync(raw, { force: true });
  releaseOrphanBlocks(hfs);
  log('Compressing into DMG');
  writeUdif(hfs, DMG);
  const check = readUdif(readFileSync(DMG));
  if (check.problems.length) throw new Error(`DMG self-check failed: ${check.problems.join('; ')}`);
  if (Buffer.compare(check.disk, readFileSync(hfs)) !== 0) throw new Error('DMG self-check failed: contents differ');
  rmSync(hfs, { force: true });
}

/** Copies the Apple_HFS partition out of an image that has an Apple partition map. */
function extractHfsPartition(imagePath, outPath) {
  const image = readFileSync(imagePath);
  if (image.toString('latin1', 0, 2) !== 'ER') throw new Error('No Apple partition map in the xorriso image');
  const blockSize = image.readUInt16BE(2);
  const entries = image.readUInt32BE(blockSize + 4);
  for (let i = 1; i <= entries; i++) {
    const e = image.subarray(i * blockSize, (i + 1) * blockSize);
    if (e.toString('latin1', 0, 2) !== 'PM') break;
    const type = e.toString('latin1', 48, 80).replace(/\0.*$/s, '');
    if (type !== 'Apple_HFS') continue;
    const start = e.readUInt32BE(8) * blockSize;
    const length = e.readUInt32BE(12) * blockSize;
    const volume = image.subarray(start, start + length);
    if (volume.toString('latin1', 1024, 1026) !== 'H+') throw new Error('Apple_HFS partition has no HFS+ volume header');
    writeFileSync(outPath, volume);
    return;
  }
  throw new Error('No Apple_HFS partition found in the xorriso image');
}

const nodeVersion = await buildApp();
buildDmg();
rmSync(STAGING, { recursive: true, force: true });
console.log(`\nDone: ${path.relative(ROOT, DMG)} (${mb(statSync(DMG).size)}), Node.js ${nodeVersion}`);
