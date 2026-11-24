#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  console.log(`[1/7] Extracting assets/www and app icon from APK: ${apkPath}`);
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
        if not (info.flag_bits & 0x800):
            try:
                name = name.encode("cp437").decode("utf-8")
            except UnicodeDecodeError:
                pass
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
  console.log('[2/7] Removing Android-specific Cordova wrapper files & stripping BOM from data.js...');
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

  // Strip UTF-8 BOM (EF BB BF) from data.js so native WebKit XHR responseType="json" parses cleanly
  const dataJsPath = path.join(wwwDir, 'data.js');
  let buf = fs.readFileSync(dataJsPath);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    buf = buf.subarray(3);
    fs.writeFileSync(dataJsPath, buf);
    console.log('  Stripped UTF-8 BOM from data.js.');
  }

  // Fix button opacity: default instance variable 13 of t240 on Menu Inicial from 100 to 45 (translucent HUD buttons)
  let dataRaw = buf.toString('utf8');
  const opacityNeedle = '[[0],[0],[0],[0],[0],[0],[1],[1],[0],[0],[0],[0],[1],[100],[0],[2],[0],[0],[0]]';
  const opacityRepl = '[[0],[0],[0],[0],[0],[0],[1],[1],[0],[0],[0],[0],[1],[45],[0],[2],[0],[0],[0]]';
  if (dataRaw.includes(opacityNeedle)) {
    dataRaw = dataRaw.replace(opacityNeedle, opacityRepl);
    fs.writeFileSync(dataJsPath, dataRaw, 'utf8');
    console.log('  Patched default button opacity to 45% (semi-transparent HUD buttons).');
  }
}

function generateImageDimensionsMap(wwwDir) {
  console.log('[3/7] Generating precomputed PNG dimensions map (img_dims.js) for zero-RAM lazy texture streaming...');
  const imgDir = path.join(wwwDir, 'images');
  const dims = {};
  const files = fs.readdirSync(imgDir).filter(f => f.toLowerCase().endsWith('.png'));
  for (const f of files) {
    const fd = fs.openSync(path.join(imgDir, f), 'r');
    const hdr = Buffer.alloc(24);
    fs.readSync(fd, hdr, 0, 24, 0);
    fs.closeSync(fd);
    const w = hdr.readUInt32BE(16);
    const h = hdr.readUInt32BE(20);
    dims[`images/${f}`] = [w, h];
  }
  fs.writeFileSync(
    path.join(wwwDir, 'img_dims.js'),
    `window.__C2_IMG_DIMS = ${JSON.stringify(dims)};\n`,
    'utf8'
  );
  console.log(`  Indexed dimensions for ${files.length} sprite sheets.`);
}

function normalizeMediaFilenames(mediaDir) {
  console.log('[4/7] Normalizing media filenames (UTF-8 NFC + lowercase for iOS APFS)...');
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
      fs.renameSync(src, tmp);
      fs.renameSync(tmp, dst);
      renamed++;
    }
  }
  console.log(`  Normalized ${renamed} media filename(s).`);
}

async function convertAudioToM4a(mediaDir, skipAudio) {
  if (skipAudio) {
    console.log('[5/7] Skipping ffmpeg audio conversion (--skip-audio set).');
    return;
  }
  const files = fs.readdirSync(mediaDir).filter(f => /\.(ogg|mp3)$/i.test(f));
  if (files.length === 0) {
    console.log('[5/7] Audio files already converted to .m4a.');
    return;
  }
  console.log(`[5/7] Converting ${files.length} audio files (.ogg/.mp3 -> Apple AAC .m4a)...`);

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
        // Cap ultra-long looping OST tracks (>150s) smoothly at 120s with 3s fade-out (compact IPA + fallback safety)
        const srcSize = fs.statSync(inPath).size;
        let ffmpegArgs = [
          '-nostdin', '-y', '-loglevel', 'error',
          '-i', inPath,
          '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          outPath,
        ];
        if (srcSize > 1800 * 1024) {
          let durSec = 0;
          try {
            await execFileAsync('ffmpeg', ['-i', inPath]);
          } catch (probeErr) {
            const stderr = probeErr.stderr ? probeErr.stderr.toString() : '';
            const dm = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (dm) durSec = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]);
          }
          if (durSec > 150) {
            ffmpegArgs = [
              '-nostdin', '-y', '-loglevel', 'error',
              '-i', inPath,
              '-t', '120',
              '-af', 'afade=t=out:st=117:d=3',
              '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
              outPath,
            ];
          }
        }
        await execFileAsync('ffmpeg', ffmpegArgs);
      } catch (err) {
        fallbacks++;
        console.warn(`  [warn] Fallback silent audio for ${file}: ${err.message}`);
        await execFileAsync('ffmpeg', [
          '-nostdin', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.1',
          '-c:a', 'aac', '-b:a', '64k',
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

export function patchConstruct2RuntimeAndHtml(wwwDir) {
  console.log('[6/7] Patching Construct 2 runtime (Zero-Reload Fortress + Native Swift Audio + 3-Tier Hard VRAM Ceiling + Heap Trimming)...');
  const rtPath = path.join(wwwDir, 'c2runtime.js');
  let rt = fs.readFileSync(rtPath, 'utf8');

  // 1. iPadOS 13+ detection
  if (!rt.includes('navigator.maxTouchPoints > 1')) {
    const before = rt;
    rt = rt.replace(
      'this.isiPad = /ipad/i.test(navigator.userAgent);',
      'this.isiPad = /ipad/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);'
    );
    if (rt === before) throw new Error('Failed to patch isiPad detection');
  }

  // 2. Route Music tracks through WebAudio API only as fallback (when Native Swift Audio is unavailable)
  if (!rt.includes('this.runtime.isWKWebView || this.runtime.isiOS')) {
    const before = rt;
    rt = rt.replace(
      /if\s*\(this\.runtime\.isWKWebView\)\s*playMusicAsSoundWorkaround\s*=\s*true;/,
      'if (this.runtime.isWKWebView || this.runtime.isiOS) playMusicAsSoundWorkaround = true;'
    );
    if (rt === before) throw new Error('Failed to patch playMusicAsSoundWorkaround');
  }

  // 2b. Hybrid Native Swift Audio Bridge:
  //     - Music OST (42-85MB PCM) & long Dramatic Finish SFX (13-16MB PCM) -> Native Swift AVAudioPlayer (0MB in WebContent, 0 combat lag!)
  //     - Rapid short combat SFX (punches/ki blasts) -> low-latency WebAudio with strict 6-buffer LRU cap (~3MB total, 0ms IPC lag!)
  if (!rt.includes('__z3NativeAudio')) {
    const beforeNACnds = rt;
    rt = rt.replace(
      /Cnds\.prototype\.IsAnyPlaying\s*=\s*function\s*\(\)\s*\{/,
      `var __z3NA = {
		nextId: 1,
		active: {},
		lastId: 0,
		hasBridge: function () {
			return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.z3Audio);
		},
		shouldUseNative: function (src, isMusic) {
			if (!this.hasBridge()) return false;
			if (isMusic) return true;
			var s = String(src || "").toLowerCase();
			return s.indexOf("dramaticfinish") !== -1 || s.indexOf("theme") !== -1;
		},
		post: function (payload) {
			try {
				if (this.hasBridge()) window.webkit.messageHandlers.z3Audio.postMessage(payload);
			} catch (e) {}
		},
		play: function (src, tag, isMusic, looping, vol) {
			if (silent) return;
			if (isMusic) {
				for (var mk in this.active) {
					if (this.active.hasOwnProperty(mk) && this.active[mk].isMusic) {
						delete this.active[mk];
					}
				}
			}
			var id = this.nextId++;
			this.active[id] = { id: id, tag: tag || "", isMusic: !!isMusic, looping: !!looping, paused: false };
			this.lastId = id;
			this.post({ cmd: "play", id: id, src: src, tag: tag || "", isMusic: !!isMusic, looping: !!looping, volume: vol });
		},
		stop: function (tag) {
			var tLow = (tag || "").toLowerCase();
			if (!tLow) {
				if (this.lastId && this.active[this.lastId]) delete this.active[this.lastId];
			} else {
				for (var k in this.active) {
					if (this.active.hasOwnProperty(k) && this.active[k].tag.toLowerCase() === tLow) {
						delete this.active[k];
					}
				}
			}
			this.post({ cmd: "stop", tag: tag || "" });
		},
		stopAll: function () {
			this.active = {};
			this.lastId = 0;
			this.post({ cmd: "stopAll" });
		},
		isAnyPlaying: function () {
			for (var k in this.active) {
				if (this.active.hasOwnProperty(k) && !this.active[k].paused) return true;
			}
			return false;
		},
		isTagPlaying: function (tag) {
			var tLow = (tag || "").toLowerCase();
			if (!tLow) {
				return !!(this.lastId && this.active[this.lastId] && !this.active[this.lastId].paused);
			}
			for (var k in this.active) {
				if (this.active.hasOwnProperty(k) && !this.active[k].paused && this.active[k].tag.toLowerCase() === tLow) {
					return true;
				}
			}
			return false;
		}
	};
	window["__z3NativeAudio"] = __z3NA;
	window["__z3NativeAudioEnded"] = function (id) {
		var tr = __z3NA.active[id];
		if (!tr) return;
		var endedTag = tr.tag || "";
		delete __z3NA.active[id];
		if (__z3NA.lastId === id) __z3NA.lastId = 0;
		audTag = endedTag;
		if (audRuntime && audInst) {
			audRuntime.trigger(cr.plugins_.Audio.prototype.cnds.OnEnded, audInst);
		}
	};
	Cnds.prototype.IsAnyPlaying = function ()
	{
		if (__z3NA.hasBridge() && __z3NA.isAnyPlaying())
			return true;`
    );
    if (rt === beforeNACnds) throw new Error('Failed to patch Native Audio IsAnyPlaying');

    rt = rt.replace(
      /Cnds\.prototype\.IsTagPlaying\s*=\s*function\s*\(tag\)\s*\{/,
      `Cnds.prototype.IsTagPlaying = function (tag)
	{
		if (__z3NA.hasBridge() && __z3NA.isTagPlaying(tag))
			return true;`
    );

    rt = rt.replace(
      /Acts\.prototype\.Play\s*=\s*function\s*\(file,\s*looping,\s*vol,\s*tag\)\s*\{\s*\r?\n\t\tif\s*\(silent\)\s*\r?\n\t\t\treturn;\s*\r?\n\t\tvar v = dbToLinear\(vol\);\s*\r?\n\t\tvar is_music = file\[1\];\s*\r?\n\t\tvar src = this\.runtime\.files_subfolder \+ file\[0\] \+ \(useOgg \? "\.ogg" : "\.m4a"\);/,
      `Acts.prototype.Play = function (file, looping, vol, tag)
	{
		if (silent)
			return;
		var v = dbToLinear(vol);
		var is_music = file[1];
		var src = this.runtime.files_subfolder + file[0] + (useOgg ? ".ogg" : ".m4a");
		if (__z3NA.shouldUseNative(src, is_music)) { __z3NA.play(src, tag, is_music, looping !== 0, v); this.nextPlayTime = 0; return; }`
    );

    rt = rt.replace(
      /Acts\.prototype\.PlayByName\s*=\s*function\s*\(folder,\s*filename,\s*looping,\s*vol,\s*tag\)\s*\{\s*\r?\n\t\tif\s*\(silent\)\s*\r?\n\t\t\treturn;\s*\r?\n\t\tvar v = dbToLinear\(vol\);\s*\r?\n\t\tvar is_music = \(folder === 1\);\s*\r?\n\t\tvar src = this\.runtime\.files_subfolder \+ filename\.toLowerCase\(\) \+ \(useOgg \? "\.ogg" : "\.m4a"\);/,
      `Acts.prototype.PlayByName = function (folder, filename, looping, vol, tag)
	{
		if (silent)
			return;
		var v = dbToLinear(vol);
		var is_music = (folder === 1);
		var src = this.runtime.files_subfolder + filename.toLowerCase() + (useOgg ? ".ogg" : ".m4a");
		if (__z3NA.shouldUseNative(src, is_music)) { __z3NA.play(src, tag, is_music, looping !== 0, v); this.nextPlayTime = 0; return; }`
    );

    rt = rt.replace(
      /Acts\.prototype\.SetLooping\s*=\s*function\s*\(tag,\s*looping\)\s*\{/,
      `Acts.prototype.SetLooping = function (tag, looping)
	{
		if (__z3NA.hasBridge()) { __z3NA.post({ cmd: "setLooping", tag: tag || "", looping: looping === 0 }); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.SetMuted\s*=\s*function\s*\(tag,\s*muted\)\s*\{/,
      `Acts.prototype.SetMuted = function (tag, muted)
	{
		if (__z3NA.hasBridge()) { __z3NA.post({ cmd: "setMuted", tag: tag || "", muted: muted === 0 }); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.SetVolume\s*=\s*function\s*\(tag,\s*vol\)\s*\{/,
      `Acts.prototype.SetVolume = function (tag, vol)
	{
		if (__z3NA.hasBridge()) { __z3NA.post({ cmd: "setVolume", tag: tag || "", volume: dbToLinear(vol) }); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.Stop\s*=\s*function\s*\(tag\)\s*\{/,
      `Acts.prototype.Stop = function (tag)
	{
		if (__z3NA.hasBridge()) { __z3NA.stop(tag); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.StopAll\s*=\s*function\s*\(\)\s*\{/,
      `Acts.prototype.StopAll = function ()
	{
		if (__z3NA.hasBridge()) { __z3NA.stopAll(); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.SetPaused\s*=\s*function\s*\(tag,\s*state\)\s*\{/,
      `Acts.prototype.SetPaused = function (tag, state)
	{
		if (__z3NA.hasBridge()) {
			var p = (state === 0);
			var tLow = (tag || "").toLowerCase();
			for (var pk in __z3NA.active) {
				if (__z3NA.active.hasOwnProperty(pk) && (!tLow || __z3NA.active[pk].tag.toLowerCase() === tLow)) {
					__z3NA.active[pk].paused = p;
				}
			}
			__z3NA.post({ cmd: "setPaused", tag: tag || "", paused: p });
		}`
    );

    rt = rt.replace(
      /Acts\.prototype\.Seek\s*=\s*function\s*\(tag,\s*pos\)\s*\{/,
      `Acts.prototype.Seek = function (tag, pos)
	{
		if (__z3NA.hasBridge()) { __z3NA.post({ cmd: "seek", tag: tag || "", pos: pos }); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.SetSilent\s*=\s*function\s*\(s\)\s*\{\s*\r?\n\t\tvar i, len;\s*\r?\n\t\tif \(s === 2\)\s*\/\/ toggling\s*\r?\n\t\t\ts = \(silent \? 1 : 0\);\s*\/\/ choose opposite state/,
      `Acts.prototype.SetSilent = function (s)
	{
		var i, len;
		if (s === 2)
			s = (silent ? 1 : 0);
		if (__z3NA.hasBridge()) {
			__z3NA.post({ cmd: "setSilent", silent: (s === 0) });
		}`
    );

    rt = rt.replace(
      /Acts\.prototype\.SetMasterVolume\s*=\s*function\s*\(vol\)\s*\{\s*\r?\n\t\tmasterVolume = dbToLinear\(vol\);/,
      `Acts.prototype.SetMasterVolume = function (vol)
	{
		masterVolume = dbToLinear(vol);
		if (__z3NA.hasBridge()) { __z3NA.post({ cmd: "setMasterVolume", volume: masterVolume }); }`
    );

    rt = rt.replace(
      /Acts\.prototype\.UnloadAll\s*=\s*function\s*\(\)\s*\{/,
      `Acts.prototype.UnloadAll = function ()
	{
		if (__z3NA.hasBridge()) { __z3NA.post({ cmd: "unloadAll" }); }`
    );

    rt = rt.replace(
      /instanceProto\.onSuspend\s*=\s*function\s*\(s\)\s*\{\s*\r?\n\t\tif\s*\(this\.playinbackground\)\s*\r?\n\t\t\treturn;/,
      `instanceProto.onSuspend = function (s)
	{
		if (this.playinbackground)
			return;
		if (window["__z3NativeAudio"] && window["__z3NativeAudio"].hasBridge()) {
			window["__z3NativeAudio"].post({ cmd: "setSuspended", suspended: !!s });
		}`
    );
  }

  // 2c. STRICT JS RELOAD BAN: neutralize doContinuousPreviewReload & Browser Acts.prototype.Reload
  if (!rt.includes('/* __z3ReloadBlocked */')) {
    rt = rt.replace(
      /function doContinuousPreviewReload\(\)\s*\{[\s\S]*?window\.location = window\.location \+ "\?continuous";\s*\r?\n\t\t\}\s*\r?\n\t\};/,
      `function doContinuousPreviewReload() { /* __z3ReloadBlocked */ };`
    );
    rt = rt.replace(
      /Acts\.prototype\.Reload\s*=\s*function\s*\(\)\s*\{\s*\r?\n\t\tif\s*\(!this\.is_arcade && !this\.runtime\.isDomFree\)\s*\r?\n\t\t\twindow\.location\.reload\(\);\s*\r?\n\t\};/,
      `Acts.prototype.Reload = function () { /* __z3ReloadBlocked */ };`
    );
  }

  // 3. Always use hardware-decoded .m4a (AAC)
  if (rt.includes('audio/ogg; codecs="vorbis"')) {
    const before = rt;
    rt = rt.replace(
      /useOgg\s*=\s*!!\s*\(new Audio\(\)\.canPlayType\([^)]+\)\)\s*&&\s*!this\.runtime\.isWindows10;/,
      'useOgg = false;'
    );
    if (rt === before) throw new Error('Failed to patch useOgg');
  }

  // 4. Mark deferred non-loader-layout type initialization so 622 heavy character/stage sprite sheets
  //    are NOT decoded into 1.75 GB of CPU HTMLImageElement RAM at startup
  if (!rt.includes('this.__inDeferredTypeInit = true;')) {
    const before = rt;
    rt = rt.replace(
      /if\s*\(this\.uses_loader_layout\)\s*\{\s*for\s*\(i\s*=\s*0,\s*len\s*=\s*this\.types_by_index\.length;\s*i\s*<\s*len;\s*i\+\+\)/,
      'if (this.uses_loader_layout) {\n\t\t\tthis.__inDeferredTypeInit = true;\n\t\t\tfor (i = 0, len = this.types_by_index.length; i < len; i++)'
    );
    rt = rt.replace(
      /\}\s*else\s*this\.isloading\s*=\s*false;\s*for\s*\(i\s*=\s*0,\s*len\s*=\s*this\.layouts_by_index\.length;/,
      '\tthis.__inDeferredTypeInit = false;\n\t\t}\n\t\telse\n\t\t\tthis.isloading = false;\n\t\tfor (i = 0, len = this.layouts_by_index.length;'
    );
    if (rt === before) throw new Error('Failed to patch __inDeferredTypeInit');
  }

  // 4b. Free raw 60MB data.js JSON arrays immediately during loadProject BEFORE WebGL init!
  if (!rt.includes('/* __z3FreePmArrays */')) {
    const beforePm = rt;
    rt = rt.replace(
      /cr\.clearArray\(this\.objectRefTable\);\s*\r?\n\t\tthis\.initRendererAndLoader\(\);/,
      `/* __z3FreePmArrays */
		try {
			if (pm) {
				if (pm[5]) pm[5].length = 0;
				if (pm[6]) pm[6].length = 0;
			}
		} catch (e) {}
		cr.clearArray(this.objectRefTable);
		this.initRendererAndLoader();`
    );
    if (rt === beforePm) console.warn('  [warn] Optional pm array release pattern not matched');
  }

  // 5. Replace eager new Image() in Sprite.Type.prototype.onCreate with lightweight lazy descriptor + share empty arrays
  if (!rt.includes('__isLazyProxy')) {
    const before = rt;
    rt = rt.replace(
      /frameobj\.image_points = frame\[9\];\s*\r?\n\t\t\t\tframeobj\.poly_pts = frame\[10\];/,
      `var _emptySharedArr = window["__z3EmptyArr"] || (window["__z3EmptyArr"] = []);
				frameobj.image_points = (frame[9] && frame[9].length) ? frame[9] : _emptySharedArr;
				frameobj.poly_pts = (frame[10] && frame[10].length) ? frame[10] : _emptySharedArr;`
    );
    rt = rt.replace(
      /frameobj\.texture_img\s*=\s*new Image\(\);\s*frameobj\.texture_img\.cr_src\s*=\s*frame\[0\];\s*frameobj\.texture_img\.cr_filesize\s*=\s*frame\[1\];\s*frameobj\.texture_img\.c2webGL_texture\s*=\s*null;\s*this\.runtime\.waitForImageLoad\(frameobj\.texture_img,\s*frame\[0\]\);/,
      `if (this.runtime.__inDeferredTypeInit) {
						var _dims = (window["__C2_IMG_DIMS"] && window["__C2_IMG_DIMS"][frame[0]]) || [256, 256];
						frameobj.texture_img = {
							cr_src: frame[0],
							cr_filesize: frame[1],
							c2webGL_texture: null,
							src: frame[0],
							width: _dims[0],
							height: _dims[1],
							naturalWidth: _dims[0],
							naturalHeight: _dims[1],
							complete: true,
							c2error: false,
							__isLazyProxy: true
						};
						this.runtime.wait_for_textures.push(frameobj.texture_img);
					} else {
						frameobj.texture_img = new Image();
						frameobj.texture_img.cr_src = frame[0];
						frameobj.texture_img.cr_filesize = frame[1];
						frameobj.texture_img.c2webGL_texture = null;
						this.runtime.waitForImageLoad(frameobj.texture_img, frame[0]);
					}`
    );
    if (rt === before) throw new Error('Failed to patch Sprite lazy proxy');
  }

  // 5b. Cleanly clear texQueue on WebGL context lost so context restores smoothly without reload
  if (!rt.includes('__z3ContextLostClean')) {
    rt = rt.replace(
      /Runtime\.prototype\.onContextLost\s*=\s*function\s*\(\)\s*\{\s*\r?\n\t\tthis\.glwrap\.contextLost\(\);/,
      `Runtime.prototype.onContextLost = function ()
	{
		/* __z3ContextLostClean */
		if (window["__c2ClearTexQueue"]) window["__c2ClearTexQueue"]();
		this.glwrap.contextLost();`
    );
  }

  // 6. Cap DevicePixelRatio to 2.0 (100% sharp Retina quality without 3x framebuffer bloat)
  if (!rt.includes('Math.min(2.0, (this.isRetina')) {
    const beforeDpr = rt;
    rt = rt.replace(
      'this.devicePixelRatio = (this.isRetina ? (window["devicePixelRatio"] || window["webkitDevicePixelRatio"] || window["mozDevicePixelRatio"] || window["msDevicePixelRatio"] || 1) : 1);',
      'this.devicePixelRatio = Math.min(2.0, (this.isRetina ? (window["devicePixelRatio"] || window["webkitDevicePixelRatio"] || window["mozDevicePixelRatio"] || window["msDevicePixelRatio"] || 1) : 1));'
    );
    if (rt === beforeDpr) throw new Error('Failed to patch devicePixelRatio cap');
  }

  // 6b. Release XHR reference immediately after loadProject so 60MB data.js buffer is freed by GC
  if (!rt.includes('xhr.onload = null; xhr.onerror = null;')) {
    const beforeXhr = rt;
    rt = rt.replace(
      /self\.loadProject\(xhr\["response"\]\);\s*\/\/ already parsed by browser/,
      'var _resp = xhr["response"]; xhr.onload = null; xhr.onerror = null; xhr = null; self.loadProject(_resp); _resp = null;'
    );
    if (rt === beforeXhr) console.warn('  [warn] Optional XHR cleanup pattern not matched');
  }

  // 7. On-demand WebGL texture upload + Evict-BEFORE-Decode + 3-Tier Unbypassable Hard VRAM Ceiling (100% original full-res sprites!)
  if (!rt.includes('c2lazyLoadFunc')) {
    const beforeGL = rt;
    rt = rt.replace(
      /GLWrap_\.prototype\.loadTexture\s*=\s*function\s*\(img,\s*tiling,\s*linearsampling,\s*pixelformat,\s*tiletype,\s*nomip\)\s*\{/,
      `GLWrap_.prototype.loadTexture = function (img, tiling, linearsampling, pixelformat, tiletype, nomip)
	{
		if (img && img.__isLazyProxy)
		{
			tiling = !!tiling;
			linearsampling = !!linearsampling;
			var tex_key = img.cr_src + "," + tiling + "," + linearsampling + (tiling ? ("," + tiletype) : "");
			var webGL_texture = null;
			if (textures_by_src.hasOwnProperty(tex_key))
			{
				webGL_texture = textures_by_src[tex_key];
				webGL_texture.c2refcount++;
				return webGL_texture;
			}
			this.endBatch();
			var gl = this.gl;
			webGL_texture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, webGL_texture);
			gl.pixelStorei(gl["UNPACK_PREMULTIPLY_ALPHA_WEBGL"], false);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
			if (tiling)
			{
				if (tiletype === "repeat-x") {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				} else if (tiletype === "repeat-y") {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
				} else {
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
				}
			}
			else
			{
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			}
			if (linearsampling)
			{
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			}
			else
			{
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			}
			gl.bindTexture(gl.TEXTURE_2D, null);
			this.lastTexture0 = null;
			webGL_texture.c2width = img.width;
			webGL_texture.c2height = img.height;
			webGL_texture.c2bytes = (img.width || 256) * (img.height || 256) * 4;
			webGL_texture.c2refcount = 1;
			webGL_texture.c2texkey = tex_key;
			webGL_texture.c2deleted = false;
			webGL_texture.c2isLoaded = false;
			webGL_texture.c2loading = false;
			webGL_texture.c2lastUsedTime = Date.now();
			webGL_texture.c2lastTick = 0;
			all_textures.push(webGL_texture);
			textures_by_src[tex_key] = webGL_texture;

			var internalformat = gl.RGBA;
			var format = gl.RGBA;
			var type = gl.UNSIGNED_BYTE;
			if (pixelformat && !this.isIE)
			{
				switch (pixelformat) {
				case BF_RGB8: internalformat = gl.RGB; format = gl.RGB; break;
				case BF_RGBA4: type = gl.UNSIGNED_SHORT_4_4_4_4; break;
				case BF_RGB5_A1: type = gl.UNSIGNED_SHORT_5_5_5_1; break;
				case BF_RGB565: internalformat = gl.RGB; format = gl.RGB; type = gl.UNSIGNED_SHORT_5_6_5; break;
				}
			}
			var selfGL = this;
			var texSrc = img.cr_src;
			var uploadBytes = (img.width || 256) * (img.height || 256) * 4;
			webGL_texture.c2lazyLoadFunc = function (doneCb) {
				if (webGL_texture.c2deleted || webGL_texture.c2isLoaded) {
					if (doneCb) doneCb();
					return;
				}
				// Evict idle/over-budget textures BEFORE decode (non-blocking gl.flush only -> 0ms GPU stall!)
				if (selfGL.evictForBudget) {
					selfGL.evictForBudget(uploadBytes, webGL_texture);
				}
				function onUpload(source) {
					if (!webGL_texture.c2deleted) {
						if (selfGL.evictForBudget) {
							selfGL.evictForBudget(uploadBytes, webGL_texture);
						}
						selfGL.endBatch();
						gl.bindTexture(gl.TEXTURE_2D, webGL_texture);
						gl.pixelStorei(gl["UNPACK_PREMULTIPLY_ALPHA_WEBGL"], true);
						gl.texImage2D(gl.TEXTURE_2D, 0, internalformat, format, type, source);
						gl.bindTexture(gl.TEXTURE_2D, null);
						selfGL.lastTexture0 = null;
						webGL_texture.c2bytes = uploadBytes;
						webGL_texture.c2isLoaded = true;
						webGL_texture.c2loading = false;
						webGL_texture.c2lastUsedTime = Date.now();
						var rtInst = window["cr_getC2Runtime"] && window["cr_getC2Runtime"]();
						if (rtInst) {
							webGL_texture.c2lastTick = rtInst.tickcount || 0;
							rtInst.redraw = true;
						}
					}
					if (doneCb) doneCb();
				}
				if (typeof createImageBitmap === "function" && typeof fetch === "function") {
					fetch(texSrc, { cache: "no-store" })
						.then(function (res) {
							if (!res.ok) throw new Error("Fetch failed: " + res.status);
							return res.blob();
						})
						.then(function (blob) { return createImageBitmap(blob); })
						.then(function (bitmap) {
							try {
								onUpload(bitmap);
							} finally {
								if (bitmap && bitmap.close) bitmap.close();
							}
						})
						.catch(function () {
							fallbackImage();
						});
				} else {
					fallbackImage();
				}
				function fallbackImage() {
					var realImg = new Image();
					realImg.onload = function () {
						onUpload(realImg);
						realImg.onload = null;
						realImg.onerror = null;
						realImg.src = "";
						realImg = null;
					};
					realImg.onerror = function () {
						webGL_texture.c2loading = false;
						realImg.onload = null;
						realImg.onerror = null;
						realImg.src = "";
						realImg = null;
						if (doneCb) doneCb();
					};
					realImg.src = texSrc;
				}
			};
			return webGL_texture;
		}`
    );
    if (rt === beforeGL) throw new Error('Failed to patch GLWrap loadTexture');

    // 8. Load textures on demand when GLWrap_.setTexture is called + refresh lastUsedTime & lastTick
    const beforeST = rt;
    rt = rt.replace(
      /GLWrap_\.prototype\.setTexture\s*=\s*function\s*\(tex\)\s*\{/,
      `GLWrap_.prototype.setTexture = function (tex)
	{
		if (tex)
		{
			tex.c2lastUsedTime = Date.now();
			tex.c2lastTick = window["__z3CurTick"] || 0;
			if (!tex.c2isLoaded && !tex.c2loading && tex.c2lazyLoadFunc)
			{
				tex.c2loading = true;
				window["__c2EnqueueLazyTex"](tex.c2lazyLoadFunc, tex, true);
			}
		}`
    );
    if (rt === beforeST) throw new Error('Failed to patch setTexture');

    // 9. 3-Tier UNBYPASSABLE Hard VRAM Ceiling + Dynamic Pressure Scaling + Synchronous gl.finish() Metal Reclaim
    const beforeDel = rt;
    rt = rt.replace(
      /this\.gl\.deleteTexture\(tex\);\s*\r?\n\t\};/,
      `tex.c2deleted = true;
		this.gl.deleteTexture(tex);
	};
	var blankPixel1x1 = new Uint8Array([0, 0, 0, 0]);
	window["__c2MemPressure"] = 0;
	window["__c2SetMemoryPressure"] = function (lvl) {
		// Smooth clamp: never let background watchdog starve combat VRAM below Level 1
		window["__c2MemPressure"] = (lvl >= 1) ? 1 : 0;
	};
	GLWrap_.prototype.getEstimatedVRAM = function ()
	{
		var total = 0;
		for (var i = 0, len = all_textures.length; i < len; i++)
		{
			var t = all_textures[i];
			if (t && t.c2isLoaded && !t.c2deleted && t.c2lazyLoadFunc)
				total += (t.c2bytes || (t.c2width * t.c2height * 4) || 1048576);
		}
		return total;
	};
	GLWrap_.prototype.evictUnusedTextures = function (forceAll, incomingBytes, protectTex)
	{
		var now = Date.now();
		var curTick = window["__z3CurTick"] || 0;
		var pressure = window["__c2MemPressure"] || 0;
		var MB = 1024 * 1024;
		// Smooth 60FPS budgets (Native Swift Audio already freed 100-165MB in WebContent!):
		// Zero thrashing during normal fights + unbypassable PANIC ceiling during Ultimate/Cutscene bursts!
		var SOFT_BUDGET = (pressure >= 2) ? (72 * MB) : ((pressure === 1) ? (88 * MB) : (104 * MB));
		var HARD_CEILING = (pressure >= 2) ? (96 * MB) : ((pressure === 1) ? (116 * MB) : (136 * MB));
		var HARD_TARGET = (pressure >= 2) ? (76 * MB) : ((pressure === 1) ? (92 * MB) : (108 * MB));
		var PANIC_CEILING = (pressure >= 2) ? (116 * MB) : ((pressure === 1) ? (136 * MB) : (160 * MB));
		var PANIC_TARGET = (pressure >= 2) ? (84 * MB) : ((pressure === 1) ? (100 * MB) : (116 * MB));
		var UNUSED_THRESHOLD = (pressure >= 2) ? 2500 : ((pressure === 1) ? 5000 : (incomingBytes ? 8000 : 12000));

		var totalVRAM = incomingBytes || 0;
		var loadedList = [];
		var i, len, t;
		for (i = 0, len = all_textures.length; i < len; i++)
		{
			t = all_textures[i];
			if (t && t.c2isLoaded && !t.c2deleted && t.c2lazyLoadFunc)
			{
				totalVRAM += (t.c2bytes || (t.c2width * t.c2height * 4) || 1048576);
				loadedList.push(t);
			}
		}
		if (totalVRAM > SOFT_BUDGET || forceAll)
		{
			loadedList.sort(function (a, b) {
				var dtTick = (a.c2lastTick || 0) - (b.c2lastTick || 0);
				if (dtTick !== 0) return dtTick;
				return (a.c2lastUsedTime || 0) - (b.c2lastUsedTime || 0);
			});
			this.endBatch();
			var gl = this.gl;
			var evictedCount = 0;
			var selfGLRef = this;
			function evictOne(texObj) {
				gl.bindTexture(gl.TEXTURE_2D, texObj);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blankPixel1x1);
				texObj.c2isLoaded = false;
				texObj.c2loading = false;
				totalVRAM -= (texObj.c2bytes || (texObj.c2width * texObj.c2height * 4) || 1048576);
				evictedCount++;
				if (texObj === selfGLRef.lastTexture0)
					selfGLRef.lastTexture0 = null;
				if (texObj === selfGLRef.lastTexture1)
					selfGLRef.lastTexture1 = null;
			}
			// Pass 1: Smooth LRU eviction (only idle textures -> zero combat stutter or flicker)
			for (i = 0, len = loadedList.length; i < len; i++)
			{
				t = loadedList[i];
				if (t === protectTex) continue;
				var age = now - (t.c2lastUsedTime || 0);
				if (!forceAll && age < UNUSED_THRESHOLD)
					continue;
				evictOne(t);
				if (!forceAll && totalVRAM <= SOFT_BUDGET)
					break;
			}
			// Pass 2: Hard Ceiling (evict textures not drawn in last 500ms down to HARD_TARGET)
			if (!forceAll && totalVRAM > HARD_CEILING)
			{
				for (i = 0, len = loadedList.length; i < len; i++)
				{
					t = loadedList[i];
					if (!t.c2isLoaded || t === protectTex)
						continue;
					var age2 = now - (t.c2lastUsedTime || 0);
					if (age2 < 500)
						continue;
					evictOne(t);
					if (totalVRAM <= HARD_TARGET)
						break;
				}
			}
			// Pass 3: UNBYPASSABLE PANIC CEILING during heavy multi-sheet Ultimate/Cutscene bursts!
			if (!forceAll && totalVRAM > PANIC_CEILING)
			{
				for (i = 0, len = loadedList.length; i < len; i++)
				{
					t = loadedList[i];
					if (!t.c2isLoaded || t === protectTex)
						continue;
					if (curTick > 0 && t.c2lastTick === curTick)
						continue;
					evictOne(t);
					if (totalVRAM <= PANIC_TARGET)
						break;
				}
				if (totalVRAM > PANIC_CEILING)
				{
					for (i = 0, len = loadedList.length; i < len; i++)
					{
						t = loadedList[i];
						if (!t.c2isLoaded || t === protectTex)
							continue;
						evictOne(t);
						if (totalVRAM <= PANIC_TARGET)
							break;
					}
				}
			}
			gl.bindTexture(gl.TEXTURE_2D, null);
			// Non-blocking gl.flush() during gameplay (ZERO GPU stall!); gl.finish() ONLY on forceAll (background/layout switch)
			if (evictedCount > 0)
			{
				if (forceAll) {
					try { gl.finish(); } catch (e) { gl.flush(); }
				} else {
					gl.flush();
				}
			}
			return evictedCount > 0;
		}
		return false;
	};
	GLWrap_.prototype.evictForBudget = function (incomingBytes, protectTex)
	{
		return this.evictUnusedTextures(false, incomingBytes || 0, protectTex || null);
	};`
    );
    if (rt === beforeDel) throw new Error('Failed to patch GLWrap deleteTexture and evictUnusedTextures');

    // 10. Periodic VRAM eviction check in Runtime.prototype.tick (every 60 ticks ~1s) + track __z3CurTick
    const beforeTickSweep = rt;
    rt = rt.replace(
      /Runtime\.prototype\.tick\s*=\s*function\s*\(background_wake,\s*timestamp,\s*debug_step\)\s*\{\s*\r?\n\t\tif\s*\(!this\.running_layout\)\s*\r?\n\t\t\treturn;/,
      `Runtime.prototype.tick = function (background_wake, timestamp, debug_step)
	{
		if (!this.running_layout)
			return;
		window["__z3CurTick"] = this.tickcount || 0;
		if (this.glwrap && this.glwrap.evictUnusedTextures)
		{
			this.__vramCheckCounter = (this.__vramCheckCounter || 0) + 1;
			if (this.__vramCheckCounter >= 120)
			{
				this.__vramCheckCounter = 0;
				this.glwrap.evictUnusedTextures(false);
			}
		}
		if (window["__z3CheckMenuVisibility"])
		{
			window["__z3CheckMenuVisibility"](this.running_layout.name);
		}`
    );
    if (rt === beforeTickSweep) throw new Error('Failed to patch Runtime.prototype.tick VRAM sweep');

    // 11. Patch typeProto.loadTextures: pure on-demand loading (only tiny <=4 frame UI icons < 512KB load eagerly)
    const beforeLT = rt;
    rt = rt.replace(
      /typeProto\.loadTextures\s*=\s*function\s*\(\)\s*\{\s*\r?\n\t\tif\s*\(this\.is_family\s*\|\|\s*this\.has_loaded_textures\s*\|\|\s*!this\.runtime\.glwrap\)\s*\r?\n\t\t\treturn;\s*\r?\n\t\tvar\s*i,\s*len,\s*frame;\s*\r?\n\t\tfor\s*\(i\s*=\s*0,\s*len\s*=\s*this\.all_frames\.length;\s*i\s*<\s*len;\s*\+\+i\)\s*\{\s*\r?\n\t\t\tframe\s*=\s*this\.all_frames\[i\];\s*\r?\n\t\t\tframe\.webGL_texture\s*=\s*this\.runtime\.glwrap\.loadTexture\(frame\.texture_img,\s*false,\s*this\.runtime\.linearSampling,\s*frame\.pixelformat\);\s*\r?\n\t\t\}\s*\r?\n\t\tthis\.has_loaded_textures\s*=\s*true;\s*\r?\n\t\};/,
      `typeProto.loadTextures = function ()
	{
		if (this.is_family || this.has_loaded_textures || !this.runtime.glwrap)
			return;
		var i, len, frame;
		var tinyType = (this.all_frames.length <= 4);
		for (i = 0, len = this.all_frames.length; i < len; ++i)
		{
			frame = this.all_frames[i];
			frame.webGL_texture = this.runtime.glwrap.loadTexture(frame.texture_img, false, this.runtime.linearSampling, frame.pixelformat);
			if (tinyType && frame.webGL_texture && (frame.webGL_texture.c2bytes || 0) <= 1048576 && !frame.webGL_texture.c2isLoaded && !frame.webGL_texture.c2loading && frame.webGL_texture.c2lazyLoadFunc)
			{
				frame.webGL_texture.c2loading = true;
				window["__c2EnqueueLazyTex"](frame.webGL_texture.c2lazyLoadFunc, frame.webGL_texture);
			}
		}
		this.has_loaded_textures = true;
	};`
    );
    if (rt === beforeLT) throw new Error('Failed to patch typeProto.loadTextures');

    // 13. Preload max 2 upcoming frames in doChangeAnim ONLY if instance is visible (zero combo stutter!)
    const beforeDCA = rt;
    rt = rt.replace(
      /this\.OnFrameChanged\(prev_frame,\s*this\.cur_animation\.frames\[this\.cur_frame\]\);/,
      `if (this.visible && this.opacity > 0 && anim && anim.frames)
		{
			var _maxPre = Math.min(anim.frames.length, 2);
			for (var _ai = 0; _ai < _maxPre; _ai++)
			{
				var _atex = anim.frames[_ai].webGL_texture;
				if (_atex && !_atex.c2isLoaded && !_atex.c2loading && _atex.c2lazyLoadFunc)
				{
					_atex.c2loading = true;
					window["__c2EnqueueLazyTex"](_atex.c2lazyLoadFunc, _atex, _ai === 0);
				}
			}
		}
		this.OnFrameChanged(prev_frame, this.cur_animation.frames[this.cur_frame]);`
    );
    if (rt === beforeDCA) throw new Error('Failed to patch doChangeAnim');

    // 13b. Anti-flicker Hold-Last-Valid-Frame in Sprite drawGL (never blink invisible while a new sheet streams in!)
    const beforeDrawGL = rt;
    rt = rt.replace(
      /instanceProto\.drawGL\s*=\s*function\s*\(glw\)\s*\{\s*\r?\n\t\tglw\.setTexture\(this\.curWebGLTexture\);\s*\r?\n\t\tglw\.setOpacity\(this\.opacity\);\s*\r?\n\t\tvar cur_frame = this\.curFrame;/,
      `instanceProto.drawGL = function(glw)
	{
		var _drawTex = this.curWebGLTexture;
		var cur_frame = this.curFrame;
		if (_drawTex && _drawTex.c2lazyLoadFunc)
		{
			if (_drawTex.c2isLoaded && !_drawTex.c2deleted)
			{
				this.__lastLoadedTex = _drawTex;
				this.__lastLoadedFrame = cur_frame;
			}
			else
			{
				glw.setTexture(_drawTex);
				var _lt = this.__lastLoadedTex;
				var _lf = this.__lastLoadedFrame;
				if (_lt && _lt.c2isLoaded && !_lt.c2deleted && _lf && cur_frame &&
					Math.abs(_lf.width - cur_frame.width) <= cur_frame.width * 0.5 &&
					Math.abs(_lf.height - cur_frame.height) <= cur_frame.height * 0.5)
				{
					_drawTex = _lt;
					cur_frame = _lf;
				}
			}
		}
		glw.setTexture(_drawTex);
		glw.setOpacity(this.opacity);`
    );
    if (rt === beforeDrawGL) throw new Error('Failed to patch Sprite drawGL anti-flicker');

    // 14. Audio buffer LRU trimming (for desktop fallback) + Multi-Level Zero-Reload Emergency Purge (__c2EmergencyPurge / __c2PurgeMemory)
    const beforeAudio = rt;
    rt = rt.replace(
      /instanceProto\.getAudioBuffer\s*=\s*function\s*\(src_,\s*is_music,\s*dont_create\)\s*\{\s*\r?\n\t\tvar\s*i,\s*len,\s*a,\s*ret\s*=\s*null,\s*j,\s*k,\s*lenj,\s*ai;/,
      `window.__c2TrimAudioBuffers = function (forceAll) {
		var keepLimit = 3;
		for (var ti = audioBuffers.length - 1; ti >= 0; ti--) {
			var b = audioBuffers[ti];
			if (b && !b.is_music) {
				var inUse = false;
				for (var tj = 0; tj < audioInstances.length; tj++) {
					var inst = audioInstances[tj];
					if (inst && inst.buffer === b && inst.canBeRecycled && !inst.canBeRecycled()) {
						inUse = true;
						break;
					}
				}
				if (!inUse || forceAll) {
					b.release();
					audioBuffers.splice(ti, 1);
					if (!forceAll && audioBuffers.length <= keepLimit) break;
				}
			}
		}
	};
	var __z3LastAutoPurge = 0;
	window.__c2EmergencyPurge = function (level, isExplicit) {
		var lvl = (typeof level === "number") ? level : 2;
		// CRITICAL 60FPS GUARD: Never wipe active on-screen fighters during combat from periodic OS watchdog!
		// Full wipe (forceAll + gl.finish) ONLY runs when backgrounded (document.hidden), switching layouts, or user taps Clean.
		var allowFullWipe = (lvl >= 2) && (!!isExplicit || !!document.hidden);
		if (!allowFullWipe) {
			var _nowP = Date.now();
			if (!isExplicit && (_nowP - __z3LastAutoPurge) < 8000) return;
			__z3LastAutoPurge = _nowP;
		}
		if (allowFullWipe && window.__c2ClearTexQueue) {
			window.__c2ClearTexQueue();
		}
		var rt = window["cr_getC2Runtime"] && window["cr_getC2Runtime"]();
		if (rt) {
			if (allowFullWipe && rt.types_by_index) {
				for (var di = 0; di < rt.types_by_index.length; di++) {
					var dt = rt.types_by_index[di];
					if (dt && dt.deadCache && dt.deadCache.length > 0) {
						dt.deadCache.length = 0;
					}
				}
			}
			if (rt.glwrap && rt.glwrap.evictUnusedTextures) {
				if (allowFullWipe) {
					rt.glwrap.evictUnusedTextures(true);
				} else {
					rt.glwrap.evictUnusedTextures(false, 16 * 1024 * 1024);
				}
			}
		}
		if (window.__c2TrimAudioBuffers) {
			window.__c2TrimAudioBuffers(allowFullWipe);
		}
		if (allowFullWipe && window["__z3NativeAudio"] && window["__z3NativeAudio"].hasBridge()) {
			window["__z3NativeAudio"].post({ cmd: "purgeCache" });
		}
		if (rt && rt.gl) {
			try {
				if (allowFullWipe) { rt.gl.finish(); } else { rt.gl.flush(); }
			} catch (e) {}
		}
		try {
			if (window.performance && performance.clearResourceTimings) performance.clearResourceTimings();
		} catch (e) {}
	};
	window.__c2PurgeMemory = function () {
		window.__c2EmergencyPurge(2, true);
	};
	instanceProto.getAudioBuffer = function (src_, is_music, dont_create)
	{
		var i, len, a, ret = null, j, k, lenj, ai;`
    );
    rt = rt.replace(
      /if\s*\(!ret\s*&&\s*!dont_create\)\s*\{\s*\r?\n\t\t\tif\s*\(playMusicAsSoundWorkaround\s*&&\s*is_music\)\s*\r?\n\t\t\t\tthis\.releaseAllMusicBuffers\(\);\s*\r?\n\t\t\tret\s*=\s*new\s*C2AudioBuffer\(src_,\s*is_music\);\s*\r?\n\t\t\taudioBuffers\.push\(ret\);\s*\r?\n\t\t\}/,
      `if (!ret && !dont_create)
		{
			if (playMusicAsSoundWorkaround && is_music)
				this.releaseAllMusicBuffers();
			if (!is_music && audioBuffers.length >= 6 && window.__c2TrimAudioBuffers)
				window.__c2TrimAudioBuffers(false);
			ret = new C2AudioBuffer(src_, is_music);
			audioBuffers.push(ret);
		}`
    );
    if (rt === beforeAudio) throw new Error('Failed to patch AudioBuffer LRU trimming');

    // 15. Full VRAM + deadCache + Native WebKit cache purge on every layout switch
    const beforeCL = rt;
    rt = rt.replace(
      /this\.running_layout\.stopRunning\(\);/,
      `this.running_layout.stopRunning();
		if (window["__c2EmergencyPurge"]) window["__c2EmergencyPurge"](2, true);
		try {
			if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.z3NativeClean) {
				window.webkit.messageHandlers.z3NativeClean.postMessage("layout_switch");
			}
		} catch (e) {}
		if (window["__z3OnLayoutChange"]) window["__z3OnLayoutChange"]("");`
    );
    rt = rt.replace(
      /this\.running_layout\.startRunning\(\);/,
      `this.running_layout.startRunning();
		if (window["__z3OnLayoutChange"]) window["__z3OnLayoutChange"](this.running_layout.name);`
    );
    if (rt === beforeCL) throw new Error('Failed to patch changeLayout queue purge');
  }

  // 16. Smooth 1.5s loader layout progress so all async LocalStorage reads finish cleanly before Menu Inicial
  if (!rt.includes('_loaderElapsed')) {
    const beforeTick = rt;
    rt = rt.replace(
      /var done = this\.areAllTexturesAndSoundsLoaded\(\);\s*\/\/[^\r\n]*\r?\n\t\t\tthis\.loadingprogress = this\.progress;/,
      `var done = this.areAllTexturesAndSoundsLoaded();
			var _loaderElapsed = Date.now() - this.start_time;
			if (_loaderElapsed < 1500) {
				done = false;
				this.progress = Math.min(0.99, _loaderElapsed / 1500);
			}
			this.loadingprogress = this.progress;`
    );
    if (rt === beforeTick) throw new Error('Failed to patch loader progress tick');
  }

  // 17. Expose Construct 2 LocalForage storage for Z-Hub backup and mini-game
  if (!rt.includes('window["__c2LocalForage"] = localforage;')) {
    const beforeLF = rt;
    rt = rt.replace(
      /var pluginProto = cr\.plugins_\.LocalStorage\.prototype;/,
      'if (typeof localforage !== "undefined") window["__c2LocalForage"] = localforage;\n\tvar pluginProto = cr.plugins_.LocalStorage.prototype;'
    );
    if (rt === beforeLF) throw new Error('Failed to patch LocalStorage localforage exposure');
  }

  // 18. Isolate Z-Hub touch/mouse and keyboard events so modal interactions never leak to background or block inputs (e.g. key 'G')
  if (!rt.includes('__z3IsBlockedTarget')) {
    const helperFn = `
	function __z3IsBlockedTarget(info) {
		var t = info && info.target;
		if (t && (t.id === "z3-dock-bar" || t.id === "z3-clean-btn" || t.id === "z3-trigger-btn" || t.id === "z3-modal-overlay" || (t.closest && (t.closest("#z3-dock-bar") || t.closest("#z3-clean-btn") || t.closest("#z3-trigger-btn") || t.closest("#z3-modal-overlay")))))
			return true;
		var m = document.getElementById("z3-modal-overlay");
		if (m && m.classList && m.classList.contains("active"))
			return true;
		return false;
	}
	`;

    const beforeKD = rt;
    rt = rt.replace(
      /instanceProto\.onKeyDown\s*=\s*function\s*\(info\)\s*\{\s*\r?\n\t\tvar alreadyPreventedDefault = false;/,
      `instanceProto.onKeyDown = function (info)
	{
		var _t = info && info.target;
		if (_t && (_t.tagName === "INPUT" || _t.tagName === "TEXTAREA" || _t.isContentEditable))
			return;
		var _m = document.getElementById("z3-modal-overlay");
		if (_m && _m.classList && _m.classList.contains("active"))
			return;
		var alreadyPreventedDefault = false;`
    );
    if (rt === beforeKD) throw new Error('Failed to patch Keyboard onKeyDown');

    rt = rt.replace(
      /instanceProto\.onKeyUp\s*=\s*function\s*\(info\)\s*\{\s*\r?\n\t\tthis\.keyMap\[info\.which\] = false;/,
      `instanceProto.onKeyUp = function (info)
	{
		var _t = info && info.target;
		if (_t && (_t.tagName === "INPUT" || _t.tagName === "TEXTAREA" || _t.isContentEditable))
			return;
		var _m = document.getElementById("z3-modal-overlay");
		if (_m && _m.classList && _m.classList.contains("active"))
			return;
		this.keyMap[info.which] = false;`
    );

    const beforeTouch = rt;
    rt = rt.replace(
      /instanceProto\.onPointerStart\s*=\s*function\s*\(info\)\s*\{\s*\r?\n\t\tif\s*\(info\["pointerType"\] === info\["MSPOINTER_TYPE_MOUSE"\] \|\| info\["pointerType"\] === "mouse"\)\s*\r?\n\t\t\treturn;/,
      `${helperFn}instanceProto.onPointerStart = function (info)
	{
		if (__z3IsBlockedTarget(info)) return;
		if (info["pointerType"] === info["MSPOINTER_TYPE_MOUSE"] || info["pointerType"] === "mouse")
			return;`
    );
    rt = rt.replace(
      /instanceProto\.onTouchStart\s*=\s*function\s*\(info\)\s*\{\s*\r?\n\t\tif\s*\(info\.preventDefault && cr\.isCanvasInputEvent\(info\)\)\s*\r?\n\t\t\tinfo\.preventDefault\(\);/,
      `instanceProto.onTouchStart = function (info)
	{
		if (__z3IsBlockedTarget(info)) return;
		if (info.preventDefault && cr.isCanvasInputEvent(info))
			info.preventDefault();`
    );
    rt = rt.replace(
      /instanceProto\.onMouseDown\s*=\s*function\(info\)\s*\{\s*\r?\n\t\tif\s*\(isCompatibilityMouseEvent\(info\)\)\s*\r?\n\t\t\treturn;/,
      `instanceProto.onMouseDown = function(info)
	{
		if (__z3IsBlockedTarget(info)) return;
		if (isCompatibilityMouseEvent(info))
			return;`
    );
    if (rt === beforeTouch) throw new Error('Failed to patch Touch input listeners');
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
    <link rel="stylesheet" href="z3_hub.css" />
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
            background: #000;
            color: #fff;
            overflow: hidden;
            touch-action: none;
            -ms-touch-action: none;
        }
        canvas {
            touch-action: none;
            -ms-touch-action: none;
            display: block;
        }
    </style>
    <script>
    (function () {
        // 1. Clean up any legacy Low-RAM flag so graphics always stay 100% native sharp
        try { localStorage.removeItem("Z3_LOW_RAM_MODE"); } catch (e) {}

        // 2. STRICT JS RELOAD LOCKDOWN (combined with native WKNavigationDelegate reload cancellation)
        try {
            if (window.Location && Location.prototype) {
                Object.defineProperty(Location.prototype, "reload", {
                    value: function () { /* Strictly blocked */ },
                    writable: false,
                    configurable: false
                });
            }
        } catch (e) {}
        try {
            if (window.history && History.prototype) {
                var _origGo = History.prototype.go;
                History.prototype.go = function (delta) {
                    if (!delta || delta === 0) return;
                    return _origGo.apply(this, arguments);
                };
            }
        } catch (e) {}

        // 3. Smooth high-throughput on-demand GPU texture loader queue (concurrency 2, zero rAF stall!)
        var texQueue = [];
        var activeTexLoads = 0;
        var MAX_TEX_CONCURRENCY = 2;
        var MAX_TEX_QUEUE = 16;
        function pumpTexQueue() {
            while (activeTexLoads < MAX_TEX_CONCURRENCY && texQueue.length > 0) {
                activeTexLoads++;
                var job = texQueue.shift();
                job(function () {
                    activeTexLoads--;
                    if (texQueue.length > 0) {
                        setTimeout(pumpTexQueue, 0);
                    }
                });
            }
        }
        window.__c2EnqueueLazyTex = function (job, tex, highPriority) {
            for (var qi = 0; qi < texQueue.length; qi++) {
                if (texQueue[qi] && texQueue[qi].tex === tex) {
                    if (highPriority && qi > 0) {
                        var existing = texQueue.splice(qi, 1)[0];
                        texQueue.unshift(existing);
                    }
                    return;
                }
            }
            if (texQueue.length >= MAX_TEX_QUEUE) {
                var dropped = texQueue.pop();
                if (dropped && dropped.tex) dropped.tex.c2loading = false;
            }
            job.tex = tex;
            if (highPriority) {
                texQueue.unshift(job);
            } else {
                texQueue.push(job);
            }
            pumpTexQueue();
        };
        window.__c2TrimTexQueue = function () {
            while (texQueue.length > 2) {
                var dropped = texQueue.pop();
                if (dropped && dropped.tex) dropped.tex.c2loading = false;
            }
        };
        window.__c2ClearTexQueue = function () {
            for (var i = 0; i < texQueue.length; i++) {
                if (texQueue[i] && texQueue[i].tex) {
                    texQueue[i].tex.c2loading = false;
                }
            }
            texQueue.length = 0;
        };

        // 4. AudioContext resume helper (only used for Z-Hub mini-wheel synth or desktop fallback)
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
    <script src="img_dims.js"></script>
    <script src="jquery-3.4.1.min.js"></script>
    <script src="c2runtime.js"></script>
    <script src="z3_hub.js"></script>
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
            if (document.hidden && window.__c2EmergencyPurge) {
                window.__c2EmergencyPurge(2);
            }
        }, false);
    </script>
</body>
</html>
`;
  fs.writeFileSync(path.join(wwwDir, 'index.html'), indexHtml, 'utf8');

  // Copy Z-Hub overlay assets into www
  const hubCssSrc = path.join(__dirname, 'z3_hub.css');
  const hubJsSrc = path.join(__dirname, 'z3_hub.js');
  if (fs.existsSync(hubCssSrc)) {
    fs.copyFileSync(hubCssSrc, path.join(wwwDir, 'z3_hub.css'));
  }
  if (fs.existsSync(hubJsSrc)) {
    fs.copyFileSync(hubJsSrc, path.join(wwwDir, 'z3_hub.js'));
  }
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
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=black:s=${px}x${px}`,
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
  console.log('[7/7] Verifying 100% of game audio & image references...');
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

export { cleanAndroidCordovaFiles, generateImageDimensionsMap, verifyAssets };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  (async () => {
    const opts = parseArgs(process.argv);
    const iosDir = path.resolve(opts.iosDir);
    const wwwDir = path.join(iosDir, 'www');

    if (opts.apk) {
      extractApkWithPython(path.resolve(opts.apk), iosDir);
    } else if (!fs.existsSync(path.join(wwwDir, 'data.js'))) {
      throw new Error(`Neither --apk provided nor ${path.join(wwwDir, 'data.js')} found.`);
    }

    cleanAndroidCordovaFiles(wwwDir);
    generateImageDimensionsMap(wwwDir);
    normalizeMediaFilenames(path.join(wwwDir, 'media'));
    await convertAudioToM4a(path.join(wwwDir, 'media'), opts.skipAudio);
    patchConstruct2RuntimeAndHtml(wwwDir);
    await generateAppIcons(iosDir, wwwDir, opts.skipAudio);
    verifyAssets(wwwDir, opts.skipAudio);
    console.log('Game preparation completed successfully!');
  })().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
