#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const opts = { apk: '', iosDir: 'ios', skipAudio: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apk' && argv[i + 1]) opts.apk = argv[++i];
    else if (a === '--ios-dir' && argv[i + 1]) opts.iosDir = argv[++i];
    else if (a === '--skip-audio') opts.skipAudio = true;
  }
  return opts;
}

function fixMojibake(name) {
  let out = name;
  if (out.includes('Ã')) {
    try {
      const decoded = Buffer.from(out, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD')) {
        out = decoded;
      }
    } catch {}
  }
  return out.normalize('NFC');
}

function extractApkWithPython(apkPath, iosDir) {
  console.log(`[1/6] Extracting assets/www and app icon from APK: ${apkPath}`);
  const pyScript = `
import sys, os, zipfile, shutil

apk_path, ios_dir = sys.argv[1], sys.argv[2]
www_dir = os.path.join(ios_dir, "www")
if os.path.exists(www_dir):
    shutil.rmtree(www_dir)
os.makedirs(www_dir, exist_ok=True)

with zipfile.ZipFile(apk_path, "r") as z:
    count = 0
    for info in z.infolist():
        name = info.filename
        if name.startswith("assets/www/") and not name.endswith("/"):
            rel = name[len("assets/www/"):]
            dest = os.path.join(www_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            count += 1
    icon_candidates = [
        "res/mipmap-xxxhdpi-v4/icon.png",
        "res/mipmap-xxhdpi-v4/icon.png",
        "res/mipmap-xhdpi-v4/icon.png",
        "assets/www/icon-256.png",
    ]
    for ic in icon_candidates:
        if ic in z.namelist():
            with z.open(ic) as src, open(os.path.join(ios_dir, "app-icon.png"), "wb") as dst:
                shutil.copyfileobj(src, dst)
            print(f"Extracted icon: {ic}")
            break
    print(f"Extracted {count} files to {www_dir}")
`;
  execFileSync('python3', ['-c', pyScript, apkPath, iosDir], { stdio: 'inherit' });
}

function cleanAndroidCordovaFiles(wwwDir) {
  console.log('[2/6] Removing Android-specific Cordova wrapper files...');
  const toRemove = [
    'cordova.js',
    'cordova_plugins.js',
    'config.xml',
    'config.json',
    'cordova-js-src',
    'plugins',
    path.join('media', 'desktop.ini'),
  ];
  for (const rel of toRemove) {
    const p = path.join(wwwDir, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
}

function normalizeMediaFilenames(mediaDir) {
  console.log('[3/6] Normalizing media filenames (UTF-8 NFC + lowercase for iOS APFS)...');
  const files = fs.readdirSync(mediaDir);
  let renamed = 0;
  for (const f of files) {
    if (f.toLowerCase() === 'desktop.ini') {
      fs.rmSync(path.join(mediaDir, f), { force: true });
      continue;
    }
    const clean = fixMojibake(f).toLowerCase();
    if (clean !== f) {
      const src = path.join(mediaDir, f);
      const tmp = path.join(mediaDir, `__tmp_${Date.now()}_${Math.random().toString(36).slice(2)}_${clean}`);
      const dst = path.join(mediaDir, clean);
      // Two-step rename so case-only renames work on case-insensitive filesystems (macOS/Windows) too
      fs.renameSync(src, tmp);
      fs.renameSync(tmp, dst);
      renamed++;
    }
  }
  console.log(`  Normalized ${renamed} media filename(s).`);
}

async function convertAudioToM4a(mediaDir, skipAudio) {
  if (skipAudio) {
    console.log('[4/6] Skipping ffmpeg audio conversion (--skip-audio set).');
    return;
  }
  const files = fs.readdirSync(mediaDir).filter(f => /\.(ogg|mp3)$/i.test(f));
  console.log(`[4/6] Converting ${files.length} audio files (.ogg/.mp3 -> Apple AAC .m4a)...`);

  const concurrency = Math.max(4, Math.min(12, os.cpus().length * 2));
  let idx = 0;
  let completed = 0;
  let fallbacks = 0;

  async function worker() {
    while (true) {
      const current = idx++;
      if (current >= files.length) break;
      const file = files[current];
      const inPath = path.join(mediaDir, file);
      const base = file.replace(/\.(ogg|mp3)$/i, '').toLowerCase();
      const outPath = path.join(mediaDir, `${base}.m4a`);

      try {
        await execFileAsync('ffmpeg', [
          '-nostdin',
          '-y',
          '-loglevel', 'error',
          '-i', inPath,
          '-vn',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          outPath,
        ]);
      } catch (err) {
        fallbacks++;
        console.warn(`  [warn] Fallback silent audio for ${file}: ${err.message}`);
        await execFileAsync('ffmpeg', [
          '-nostdin',
          '-y',
          '-loglevel', 'error',
          '-f', 'lavfi',
          '-i', 'anullsrc=r=44100:cl=stereo',
          '-t', '0.1',
          '-c:a', 'aac',
          '-b:a', '64k',
          outPath,
        ]);
      }

      fs.rmSync(inPath, { force: true });
      completed++;
      if (completed % 500 === 0 || completed === files.length) {
        console.log(`  Converted ${completed}/${files.length} audio files...`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`  Audio conversion complete (${completed} .m4a files, ${fallbacks} fallbacks).`);
}

function patchConstruct2Runtime(wwwDir) {
  console.log('[5/6] Patching Construct 2 runtime & index.html for iOS WKWebView...');
  const rtPath = path.join(wwwDir, 'c2runtime.js');
  let rt = fs.readFileSync(rtPath, 'utf8');

  // 1. Detect modern iPadOS 13+ (where navigator.userAgent reports MacIntel with touch points)
  if (!rt.includes('navigator.maxTouchPoints > 1')) {
    const before = rt;
    rt = rt.replace(
      'this.isiPad = /ipad/i.test(navigator.userAgent);',
      'this.isiPad = /ipad/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);'
    );
    if (rt === before) throw new Error('Failed to patch isiPad detection in c2runtime.js');
  }

  // 2. Route Music tracks through WebAudio API XMLHttpRequest on iOS custom scheme
  if (!rt.includes('this.runtime.isWKWebView || this.runtime.isiOS')) {
    const before = rt;
    rt = rt.replace(
      /if\s*\(this\.runtime\.isWKWebView\)\s*playMusicAsSoundWorkaround\s*=\s*true;/,
      'if (this.runtime.isWKWebView || this.runtime.isiOS) playMusicAsSoundWorkaround = true;'
    );
    if (rt === before) throw new Error('Failed to patch playMusicAsSoundWorkaround in c2runtime.js');
  }

  // 3. Always use hardware-decoded .m4a (AAC) on iOS
  if (rt.includes('audio/ogg; codecs="vorbis"')) {
    const before = rt;
    rt = rt.replace(
      /useOgg\s*=\s*!!\s*\(new Audio\(\)\.canPlayType\([^)]+\)\)\s*&&\s*!this\.runtime\.isWindows10;/,
      'useOgg = false;'
    );
    if (rt === before) throw new Error('Failed to patch useOgg in c2runtime.js');
  }

  fs.writeFileSync(rtPath, rt, 'utf8');

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
    <title>Z Legends 3</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" sizes="256x256" href="icon-256.png" />
    <style type="text/css">
        * {
            padding: 0;
            margin: 0;
            -webkit-touch-callout: none;
            -webkit-user-select: none;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
        }
        html, body {
            width: 100%;
            height: 100%;
            background: #000;
            color: #fff;
            overflow: hidden;
            position: fixed;
            inset: 0;
            touch-action: none;
            -ms-touch-action: none;
        }
        #c2canvasdiv {
            width: 100%;
            height: 100%;
        }
        canvas {
            touch-action: none;
            -ms-touch-action: none;
            display: block;
        }
    </style>
    <script>
    (function () {
        var contexts = [];
        var OrigAC = window.AudioContext || window.webkitAudioContext;
        if (OrigAC) {
            var PatchedAC = function () {
                var ctx = new OrigAC();
                contexts.push(ctx);
                return ctx;
            };
            PatchedAC.prototype = OrigAC.prototype;
            window.AudioContext = PatchedAC;
            if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
        }
        function resumeAll() {
            for (var i = 0; i < contexts.length; i++) {
                var c = contexts[i];
                if (c && (c.state === "suspended" || c.state === "interrupted") && c.resume) {
                    c.resume().catch(function () {});
                }
            }
        }
        window.__resumeAllAudioContexts = resumeAll;
        ["touchstart", "touchend", "pointerdown", "mousedown", "keydown", "focus"].forEach(function (ev) {
            window.addEventListener(ev, resumeAll, { capture: true, passive: true });
        });
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden) resumeAll();
        });
    })();
    </script>
</head>
<body>
    <div id="fb-root"></div>
    <div id="c2canvasdiv">
        <canvas id="c2canvas" width="1084" height="580"></canvas>
    </div>
    <script src="jquery-3.4.1.min.js"></script>
    <script src="c2runtime.js"></script>
    <script>
        jQuery(window).resize(function () {
            cr_sizeCanvas(jQuery(window).width(), jQuery(window).height());
        });
        jQuery(document).ready(function () {
            cr_createRuntime("c2canvas");
        });
        document.addEventListener("visibilitychange", function () {
            if (window.cr_setSuspended) {
                cr_setSuspended(Boolean(document.hidden));
            }
        }, false);
    </script>
</body>
</html>
`;
  fs.writeFileSync(path.join(wwwDir, 'index.html'), indexHtml, 'utf8');
}

async function generateAppIcons(iosDir, wwwDir, skipAudio) {
  const xcassetsDir = path.join(iosDir, 'Assets.xcassets');
  const iconsetDir = path.join(xcassetsDir, 'AppIcon.appiconset');
  fs.mkdirSync(iconsetDir, { recursive: true });

  fs.writeFileSync(
    path.join(xcassetsDir, 'Contents.json'),
    JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2)
  );

  const srcIcon = fs.existsSync(path.join(iosDir, 'app-icon.png'))
    ? path.join(iosDir, 'app-icon.png')
    : path.join(wwwDir, 'icon-256.png');

  const specs = [
    { idiom: 'iphone', size: '20x20', scale: '2x', px: 40 },
    { idiom: 'iphone', size: '20x20', scale: '3x', px: 60 },
    { idiom: 'iphone', size: '29x29', scale: '2x', px: 58 },
    { idiom: 'iphone', size: '29x29', scale: '3x', px: 87 },
    { idiom: 'iphone', size: '40x40', scale: '2x', px: 80 },
    { idiom: 'iphone', size: '40x40', scale: '3x', px: 120 },
    { idiom: 'iphone', size: '60x60', scale: '2x', px: 120 },
    { idiom: 'iphone', size: '60x60', scale: '3x', px: 180 },
    { idiom: 'ipad', size: '20x20', scale: '1x', px: 20 },
    { idiom: 'ipad', size: '20x20', scale: '2x', px: 40 },
    { idiom: 'ipad', size: '29x29', scale: '1x', px: 29 },
    { idiom: 'ipad', size: '29x29', scale: '2x', px: 58 },
    { idiom: 'ipad', size: '40x40', scale: '1x', px: 40 },
    { idiom: 'ipad', size: '40x40', scale: '2x', px: 80 },
    { idiom: 'ipad', size: '76x76', scale: '1x', px: 76 },
    { idiom: 'ipad', size: '76x76', scale: '2x', px: 152 },
    { idiom: 'ipad', size: '83.5x83.5', scale: '2x', px: 167 },
    { idiom: 'ios-marketing', size: '1024x1024', scale: '1x', px: 1024 },
  ];

  const uniquePx = [...new Set(specs.map(s => s.px))];
  if (!skipAudio) {
    for (const px of uniquePx) {
      const outPng = path.join(iconsetDir, `icon-${px}.png`);
      await execFileAsync('ffmpeg', [
        '-nostdin',
        '-y',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `color=c=black:s=${px}x${px}`,
        '-i', srcIcon,
        '-filter_complex', `[1:v]scale=${px}:${px}:flags=neighbor[fg];[0:v][fg]overlay=0:0,format=rgb24`,
        '-frames:v', '1',
        outPng,
      ]);
    }
  }

  const images = specs.map(s => ({
    idiom: s.idiom,
    size: s.size,
    scale: s.scale,
    filename: `icon-${s.px}.png`,
  }));

  fs.writeFileSync(
    path.join(iconsetDir, 'Contents.json'),
    JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2)
  );
}

function verifyAssets(wwwDir, skipAudio) {
  console.log('[6/6] Verifying 100% of game audio & image references...');
  const raw = fs.readFileSync(path.join(wwwDir, 'data.js'), 'utf8');

  const audioRe = /\[2,\["([^"]+)",(true|false)\]\]/g;
  const audioRefs = new Set();
  let m;
  while ((m = audioRe.exec(raw)) !== null) audioRefs.add(m[1].toLowerCase());

  const extPattern = skipAudio ? /\.(ogg|mp3|m4a)$/i : /\.m4a$/i;
  const mediaOnDisk = new Set(
    fs.readdirSync(path.join(wwwDir, 'media'))
      .filter(f => extPattern.test(f))
      .map(f => f.replace(extPattern, '').normalize('NFC').toLowerCase())
  );

  const missingAudio = [...audioRefs].filter(r => !mediaOnDisk.has(r.normalize('NFC')));
  if (missingAudio.length > 0) {
    throw new Error(`Missing ${missingAudio.length} audio file(s): ${missingAudio.slice(0, 10).join(', ')}`);
  }

  const imgRefs = new Set([...raw.matchAll(/images\/([a-zA-Z0-9_.-]+\.png)/g)].map(x => x[1]));
  const imgsOnDisk = new Set(fs.readdirSync(path.join(wwwDir, 'images')));
  const missingImgs = [...imgRefs].filter(r => !imgsOnDisk.has(r));
  if (missingImgs.length > 0) {
    throw new Error(`Missing ${missingImgs.length} image file(s): ${missingImgs.slice(0, 10).join(', ')}`);
  }

  console.log(`  Verified OK: ${audioRefs.size} audio references & ${imgRefs.size} sprite sheets matched 100%!`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const iosDir = path.resolve(opts.iosDir);
  const wwwDir = path.join(iosDir, 'www');

  if (opts.apk) {
    extractApkWithPython(path.resolve(opts.apk), iosDir);
  } else if (!fs.existsSync(path.join(wwwDir, 'data.js'))) {
    throw new Error(`Neither --apk provided nor ${path.join(wwwDir, 'data.js')} found.`);
  }

  cleanAndroidCordovaFiles(wwwDir);
  normalizeMediaFilenames(path.join(wwwDir, 'media'));
  await convertAudioToM4a(path.join(wwwDir, 'media'), opts.skipAudio);
  patchConstruct2Runtime(wwwDir);
  await generateAppIcons(iosDir, wwwDir, opts.skipAudio);
  verifyAssets(wwwDir, opts.skipAudio);
  console.log('Game preparation completed successfully!');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
