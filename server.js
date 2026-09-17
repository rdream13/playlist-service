const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const VIDEOS_DIR = path.join(ROOT_DIR, 'videos');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LOCALAPPDATA_DIR = process.env.LOCALAPPDATA || '';
const WINGET_PACKAGES_DIR = path.join(LOCALAPPDATA_DIR, 'Microsoft', 'WinGet', 'Packages');

const ALLOWED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.ogg',
  '.ogv',
  '.mkv'
]);
const PLAYLIST_FILE = path.join(ROOT_DIR, 'playlist.json');
const FAVORITES_FILE = path.join(ROOT_DIR, 'favorites-playlists.json');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const TRIM_DEBUG_LOG = path.join(LOG_DIR, 'trim-debug.log');
const DOWNLOAD_JOBS = new Map(); // jobId -> job object
const DOWNLOAD_QUEUE = [];
const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10) || 3
);
let ACTIVE_DOWNLOADS = 0;
const ACTIVE_TRIMS = new Set();
const ACTIVE_MIXES = new Set();
const MAIN_PLAYLIST_KEY = '__main__';

function createDownloadJob(url) {
  const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  const job = {
    id: jobId,
    url,
    status: 'pending',
    logs: [],
    downloadedFile: null,
    error: null,
    progressPercent: 0,
    startTime: Date.now(),
    endTime: null
  };
  DOWNLOAD_JOBS.set(jobId, job);
  return job;
}

function extractProgressPercent(line) {
  if (typeof line !== 'string') {
    return null;
  }

  const match = line.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, value));
}

function updateJobStatus(jobId, status, data = {}) {
  const job = DOWNLOAD_JOBS.get(jobId);
  if (!job) return;
  job.status = status;

  if (status === 'queued') {
    job.progressPercent = 0;
  }
  if (status === 'completed') {
    job.progressPercent = 100;
  }

  if (data.log) {
    job.logs.push(data.log);
    if (job.logs.length > 500) {
      job.logs.shift();
    }

    const parsed = extractProgressPercent(data.log);
    if (parsed !== null) {
      job.progressPercent = parsed;
    }
  }
  if (data.file) job.downloadedFile = data.file;
  if (data.error) job.error = data.error;
  if (data.endTime) job.endTime = data.endTime;
}

function getJobInfo(jobId) {
  const job = DOWNLOAD_JOBS.get(jobId);
  if (!job) return null;
  const elapsed = (job.endTime || Date.now()) - job.startTime;
  return {
    ...job,
    elapsedSeconds: Math.round(elapsed / 1000)
  };
}

function listJobInfos() {
  return [...DOWNLOAD_JOBS.values()]
    .map((job) => getJobInfo(job.id))
    .filter(Boolean)
    .filter((job) => job.status === 'pending' || job.status === 'queued' || job.status === 'downloading')
    .sort((a, b) => b.startTime - a.startTime);
}

async function ensureDirectories() {
  await fsp.mkdir(VIDEOS_DIR, { recursive: true });
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
}

async function appendTrimDebugLog(entry) {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      ...entry
    };
    await fsp.appendFile(TRIM_DEBUG_LOG, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Best-effort logging only.
  }
}

function isAllowedVideo(fileName) {
  return ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSimpleBrowserSpec(value) {
  return /^[a-z0-9._:-]+$/i.test(value);
}

function findWingetYtDlpBin() {
  const candidate = path.join(
    WINGET_PACKAGES_DIR,
    'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'yt-dlp.exe'
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function findWingetFfmpegDir() {
  const root = path.join(
    WINGET_PACKAGES_DIR,
    'yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe'
  );

  if (!fs.existsSync(root)) {
    return null;
  }

  const subdirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => b.localeCompare(a));

  for (const dir of subdirs) {
    const binDir = path.join(root, dir, 'bin');
    const ffmpegExe = path.join(binDir, 'ffmpeg.exe');
    if (fs.existsSync(ffmpegExe)) {
      return binDir;
    }
  }

  return null;
}

function resolveYtDlpBin(ytDlpPath) {
  if (ytDlpPath) {
    return ytDlpPath;
  }
  if (process.env.YT_DLP_BIN) {
    return process.env.YT_DLP_BIN;
  }
  return findWingetYtDlpBin() || 'yt-dlp';
}

function resolveFfmpegBin() {
  if (process.env.FFMPEG_BIN) {
    return process.env.FFMPEG_BIN;
  }

  const winDir = findWingetFfmpegDir();
  if (winDir) {
    return path.join(winDir, 'ffmpeg.exe');
  }

  return 'ffmpeg';
}

function resolveFfprobeBin() {
  if (process.env.FFPROBE_BIN) {
    return process.env.FFPROBE_BIN;
  }

  const winDir = findWingetFfmpegDir();
  if (winDir) {
    return path.join(winDir, 'ffprobe.exe');
  }

  return 'ffprobe';
}

function safeVideoPath(fileName) {
  const base = path.basename(fileName);
  const full = path.join(VIDEOS_DIR, base);
  if (!full.startsWith(VIDEOS_DIR)) {
    throw new Error('Invalid file path.');
  }
  return { base, full };
}

function isUsableVideoFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < 64) {
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    const buffer = Buffer.alloc(64);
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, 64, 0);
      if (bytesRead < 8) {
        return false;
      }

      const sig = buffer.slice(0, bytesRead).toString('ascii', 0, bytesRead);
      if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
        return sig.includes('ftyp') && (stats.size > 4096 || sig.includes('moov') || sig.includes('mdat'));
      }
      if (ext === '.webm') {
        return sig.startsWith('RIFF') && sig.includes('WEBM');
      }
      if (ext === '.ogg' || ext === '.ogv') {
        return sig.startsWith('OggS');
      }
      if (ext === '.mkv') {
        return sig.includes('matroska');
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function probeVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const ffprobeBin = resolveFfprobeBin();
    const child = spawn(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filePath], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', () => {
      resolve(false);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }

      try {
        const parsed = JSON.parse(stdout || '{}');
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const duration = Number(parsed.format?.duration);
        if (streams.length === 0) {
          resolve(false);
          return;
        }

        if (Number.isFinite(duration) && duration > 0) {
          resolve(true);
          return;
        }

        resolve(streams.some((stream) => stream.codec_type === 'video' || stream.codec_type === 'audio'));
      } catch {
        resolve(false);
      }
    });
  });
}

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    const child = spawn(resolveFfprobeBin(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const duration = Number.parseFloat(stdout.trim());
      resolve(code === 0 && Number.isFinite(duration) ? duration : null);
    });
  });
}

function parseTimeToSeconds(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(',', '.');
  const parts = normalized.split(':').map((part) => Number.parseFloat(part));

  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

function formatTrimStamp(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  return [hours, minutes, secs]
    .map((value) => String(value).padStart(2, '0'))
    .join('-');
}

function isTrimmedVideoName(fileName) {
  const name = (fileName || '').trim();
  return /\s\[trim\s+\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\]\.[a-z0-9]+$/i.test(name);
}

function isTemporaryTrimFile(fileName) {
  const name = (fileName || '').trim();
  return (
    /\.tmp-\d+-\d+\.[a-z0-9]+$/i.test(name) ||
    /\]\.tmp-\d+-\d+\.[a-z0-9]+$/i.test(name)
  );
}

function buildTrimmedVideoName(fileName, startSeconds, endSeconds) {
  const parsed = path.parse(fileName);
  const stem = (parsed.name || 'video').trim();
  const ext = parsed.ext || '.mp4';
  const startStamp = formatTrimStamp(startSeconds);
  const endStamp = formatTrimStamp(endSeconds);
  const nextStem = `${stem} [trim ${startStamp}_${endStamp}]`;
  return `${nextStem}${ext}`;
}

function removePartialTrimFile(targetPath) {
  const candidates = new Set();

  if (targetPath) {
    candidates.add(targetPath);

    try {
      const parsed = path.parse(targetPath);
      if (parsed.dir && parsed.name) {
        const entries = fs.readdirSync(parsed.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const full = path.join(parsed.dir, entry.name);
          const entryParsed = path.parse(entry.name);
          if (
            entryParsed.name.startsWith(parsed.name) &&
            entryParsed.ext === parsed.ext &&
            entry.name.includes('.tmp-')
          ) {
            candidates.add(full);
          }
        }
      }
    } catch {
      // Ignore directory scan failures; the main target is always attempted first.
    }
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    } catch {
      // Ignore cleanup failures; the important part is not leaving a corrupt partial output behind.
    }
  }
}

async function trimVideoFile(sourcePath, targetPath, startSeconds, endSeconds) {
  const ffmpegBin = resolveFfmpegBin();
  const duration = Math.max(0.1, endSeconds - startSeconds);
  const trimTimeoutMs = 2 * 60 * 1000;
  const parsedTarget = path.parse(targetPath);
  const tempTargetPath = path.join(
    parsedTarget.dir,
    `${parsedTarget.name}.tmp-${process.pid}-${Date.now()}${parsedTarget.ext || '.mp4'}`
  );

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss',
      String(startSeconds),
      '-i',
      sourcePath,
      '-t',
      String(duration),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      '-sn',
      '-dn',
      '-avoid_negative_ts',
      'make_zero',
      tempTargetPath
    ];

    const child = spawn(ffmpegBin, args, { windowsHide: true });
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, trimTimeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      removePartialTrimFile(tempTargetPath);
      const message = err && err.code === 'ENOENT'
        ? `ffmpeg executable not found at ${ffmpegBin}. Install ffmpeg or set FFMPEG_BIN.`
        : err && err.message
          ? err.message
          : 'ffmpeg trim failed.';
      const wrapped = new Error(message);
      wrapped.code = err && err.code ? err.code : 'FFMPEG_ERROR';
      wrapped.stderr = stderr;
      reject(wrapped);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        removePartialTrimFile(tempTargetPath);
        const err = new Error('ffmpeg trim timed out after 5 minutes.');
        err.code = 'FFMPEG_TIMEOUT';
        err.stderr = stderr;
        reject(err);
        return;
      }

      if (code === 0) {
        try {
          fs.renameSync(tempTargetPath, targetPath);
          resolve();
          return;
        } catch (err) {
          removePartialTrimFile(tempTargetPath);
          reject(err);
          return;
        }
      }

      removePartialTrimFile(tempTargetPath);
      const err = new Error(stderr.trim() || `ffmpeg trim failed with exit code ${code}.`);
      err.code = code;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function buildMultiSceneVideoName(fileName, mode, segments) {
  const parsed = path.parse(fileName);
  const ext = parsed.ext || '.mp4';
  const stamps = segments
    .map((segment) => `${formatTrimStamp(segment.start)}_${formatTrimStamp(segment.end)}`)
    .join('__');
  const label = mode === 'remove-scene' ? 'remove' : 'scenes';
  return `${parsed.name} [${label} ${stamps}]${ext}`;
}

async function stitchVideoSegments(sourcePath, targetPath, segments, mode) {
  const parsedTarget = path.parse(targetPath);
  const tempTargetPath = path.join(
    parsedTarget.dir,
    `${parsedTarget.name}.tmp-${process.pid}-${Date.now()}${parsedTarget.ext || '.mp4'}`
  );
  const keptSegments = mode === 'remove-scene'
    ? [{ start: 0, end: segments[0].start }, { start: segments[1].end, end: Number.MAX_SAFE_INTEGER }]
    : segments;
  const segmentPaths = keptSegments.map((_segment, index) =>
    path.join(parsedTarget.dir, `${parsedTarget.name}.part-${index}-${process.pid}-${Date.now()}${parsedTarget.ext || '.mp4'}`)
  );
  const cleanup = () => {
    removePartialTrimFile(tempTargetPath);
    segmentPaths.forEach((segmentPath) => {
      try {
        if (fs.existsSync(segmentPath)) {
          fs.unlinkSync(segmentPath);
        }
      } catch {
        // Best-effort cleanup of failed segment files.
      }
    });
  };
  const runFfmpeg = (args, timeoutMs, stage) => new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegBin(), args, { windowsHide: true });
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        const error = new Error(`ffmpeg ${stage} timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(stderr.trim() || `ffmpeg stitch failed with exit code ${code}.`);
      error.stderr = stderr;
      reject(error);
    });
  });

  try {
    for (let index = 0; index < keptSegments.length; index += 1) {
      const segment = keptSegments[index];
      const duration = Number.isFinite(segment.end) && segment.end !== Number.MAX_SAFE_INTEGER
        ? Math.max(0.1, segment.end - segment.start)
        : null;
      const args = ['-y', '-ss', String(segment.start), '-i', sourcePath];
      if (duration !== null) {
        args.push('-t', String(duration));
      }
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      if (mode === 'keep-scenes') {
        args.push(
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '28',
          '-c:a', 'copy',
          '-movflags', '+faststart'
        );
      } else {
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
      }
      args.push(segmentPaths[index]);
      const segmentTimeoutMs = mode === 'keep-scenes'
        ? Math.max(10 * 60 * 1000, duration * 8 * 1000)
        : Math.max(5 * 60 * 1000, (duration || 1800) * 2 * 1000);
      await appendTrimDebugLog({
        stage: 'stitch_segment_started',
        segmentIndex: index,
        segment,
        duration,
        timeoutMinutes: Math.round(segmentTimeoutMs / 60000),
        output: segmentPaths[index]
      });
      await runFfmpeg(args, segmentTimeoutMs, `segment ${index + 1}`);
      await appendTrimDebugLog({
        stage: 'stitch_segment_finished',
        segmentIndex: index,
        output: segmentPaths[index],
        outputSize: fs.existsSync(segmentPaths[index]) ? fs.statSync(segmentPaths[index]).size : 0
      });
    }

    const concatListPath = path.join(parsedTarget.dir, `${parsedTarget.name}.concat-${process.pid}-${Date.now()}.txt`);
    const concatList = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join('\n');
    try {
      fs.writeFileSync(concatListPath, `${concatList}\n`, 'utf8');
      await runFfmpeg(
        ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', tempTargetPath],
        5 * 60 * 1000,
        'final concat'
      );
    } finally {
      try { fs.unlinkSync(concatListPath); } catch {}
    }

    fs.renameSync(tempTargetPath, targetPath);
  } catch (error) {
    cleanup();
    throw error;
  }

  segmentPaths.forEach((segmentPath) => {
    try {
      if (fs.existsSync(segmentPath)) {
        fs.unlinkSync(segmentPath);
      }
    } catch {
      // Best-effort cleanup after a successful stitch.
    }
  });
}

function computeVideoSegments(duration, clipSeconds) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(clipSeconds) || clipSeconds <= 0) {
    return [];
  }

  if (duration <= clipSeconds) {
    return [{ position: 'begin', start: 0, end: duration }];
  }

  const begin = { position: 'begin', start: 0, end: clipSeconds };
  const end = { position: 'end', start: Math.max(0, duration - clipSeconds), end: duration };
  const midStart = Math.max(0, (duration - clipSeconds) / 2);
  const middle = { position: 'middle', start: midStart, end: midStart + clipSeconds };
  return [begin, middle, end];
}

function shuffleClips(clips) {
  const shuffled = clips.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function buildMixPlan(videos, { clipSeconds, totalSeconds, arrangement, mixedOrder }) {
  const perVideoSegments = (videos || [])
    .filter((video) => Number.isFinite(video?.duration) && video.duration > 0)
    .map((video) => ({
      name: video.name,
      segments: computeVideoSegments(video.duration, clipSeconds)
    }));

  let clips = [];

  if (arrangement === 'mixed') {
    ['begin', 'middle', 'end'].forEach((position) => {
      perVideoSegments.forEach((video) => {
        const segment = video.segments.find((seg) => seg.position === position);
        if (segment) {
          clips.push({ videoName: video.name, start: segment.start, end: segment.end });
        }
      });
    });
  } else {
    perVideoSegments.forEach((video) => {
      video.segments.forEach((segment) => {
        clips.push({ videoName: video.name, start: segment.start, end: segment.end });
      });
    });
  }

  if (mixedOrder) {
    clips = shuffleClips(clips);
  }

  const result = [];
  let accumulated = 0;

  for (const clip of clips) {
    if (accumulated >= totalSeconds) {
      break;
    }

    const clipLength = clip.end - clip.start;
    const remaining = totalSeconds - accumulated;

    if (clipLength <= remaining) {
      result.push(clip);
      accumulated += clipLength;
    } else if (remaining > 0.5) {
      result.push({ ...clip, end: clip.start + remaining });
      accumulated += remaining;
      break;
    } else {
      break;
    }
  }

  return result;
}

function formatMixDateStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function buildMixVideoName(date) {
  return `mix-${formatMixDateStamp(date)}.mp4`;
}

async function buildMixVideoFile(clipPlans, targetPath) {
  const parsedTarget = path.parse(targetPath);
  const tempTargetPath = path.join(
    parsedTarget.dir,
    `${parsedTarget.name}.tmp-${process.pid}-${Date.now()}${parsedTarget.ext || '.mp4'}`
  );
  const segmentPaths = clipPlans.map((_clip, index) =>
    path.join(parsedTarget.dir, `${parsedTarget.name}.part-${index}-${process.pid}-${Date.now()}${parsedTarget.ext || '.mp4'}`)
  );

  const cleanup = () => {
    removePartialTrimFile(tempTargetPath);
    segmentPaths.forEach((segmentPath) => {
      try {
        if (fs.existsSync(segmentPath)) {
          fs.unlinkSync(segmentPath);
        }
      } catch {
        // Best-effort cleanup of failed segment files.
      }
    });
  };

  const runFfmpeg = (args, timeoutMs, stage) => new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegBin(), args, { windowsHide: true });
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        const error = new Error(`ffmpeg ${stage} timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(stderr.trim() || `ffmpeg ${stage} failed with exit code ${code}.`);
      error.stderr = stderr;
      reject(error);
    });
  });

  try {
    for (let index = 0; index < clipPlans.length; index += 1) {
      const clip = clipPlans[index];
      const duration = Math.max(0.1, clip.end - clip.start);
      const args = [
        '-y',
        '-ss', String(clip.start),
        '-i', clip.fullPath,
        '-t', String(duration),
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        segmentPaths[index]
      ];
      const timeoutMs = Math.max(3 * 60 * 1000, duration * 8 * 1000);
      await runFfmpeg(args, timeoutMs, `mix segment ${index + 1}`);
    }

    const concatListPath = path.join(parsedTarget.dir, `${parsedTarget.name}.concat-${process.pid}-${Date.now()}.txt`);
    const concatList = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join('\n');
    try {
      fs.writeFileSync(concatListPath, `${concatList}\n`, 'utf8');
      await runFfmpeg(
        ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', tempTargetPath],
        5 * 60 * 1000,
        'mix final concat'
      );
    } finally {
      try { fs.unlinkSync(concatListPath); } catch {}
    }

    fs.renameSync(tempTargetPath, targetPath);
  } catch (error) {
    cleanup();
    throw error;
  }

  segmentPaths.forEach((segmentPath) => {
    try {
      if (fs.existsSync(segmentPath)) {
        fs.unlinkSync(segmentPath);
      }
    } catch {
      // Best-effort cleanup after a successful mix build.
    }
  });
}

async function loadPlaylistOrder() {
  const state = await loadPlaylistState();
  return state.order;
}

async function loadPlaylistState() {
  try {
    if (!fs.existsSync(PLAYLIST_FILE)) {
      return { order: [], hidden: [] };
    }
    const data = await fsp.readFile(PLAYLIST_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const order = Array.isArray(parsed?.order)
      ? parsed.order.filter((value) => typeof value === 'string')
      : [];
    const hidden = Array.isArray(parsed?.hidden)
      ? parsed.hidden.filter((value) => typeof value === 'string')
      : [];
    return { order, hidden };
  } catch {
    return { order: [], hidden: [] };
  }
}

async function savePlaylistOrder(order) {
  const state = await loadPlaylistState();
  await savePlaylistState({ order, hidden: state.hidden });
}

async function savePlaylistState(state) {
  await fsp.writeFile(
    PLAYLIST_FILE,
    JSON.stringify({ order: state.order || [], hidden: state.hidden || [] }, null, 2),
    'utf8'
  );
}

async function isVideoInFavorites(videoName) {
  const store = await loadFavoritesStore();
  return Object.values(store.playlists).some((playlist) =>
    Array.isArray(playlist?.items) && playlist.items.includes(videoName)
  );
}

async function removeFromMainPlaylistOnly(videoName) {
  const state = await loadPlaylistState();
  const order = (state.order || []).filter((name) => name !== videoName);
  const hidden = new Set(state.hidden || []);
  hidden.add(videoName);
  await savePlaylistState({ order, hidden: Array.from(hidden) });
}

async function sendToMainPlaylist(videoName) {
  const state = await loadPlaylistState();
  const order = (state.order || []).filter((name) => name !== videoName);
  order.unshift(videoName);
  const hidden = (state.hidden || []).filter((name) => name !== videoName);
  await savePlaylistState({ order, hidden });
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizePlaylistName(name) {
  if (typeof name !== 'string') {
    return '';
  }
  const safe = name.trim().replace(/\s+/g, ' ').slice(0, 80);
  return UNSAFE_OBJECT_KEYS.has(safe) ? '' : safe;
}

function defaultFavoritesStore() {
  return { playlists: {} };
}

function normalizePlaylistRecord(record) {
  const createdAt = record && typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString();
  const updatedAt = record && typeof record.updatedAt === 'string' ? record.updatedAt : createdAt;
  const items = Array.isArray(record?.items)
    ? record.items.filter((value) => typeof value === 'string')
    : [];
  return {
    createdAt,
    updatedAt,
    items
  };
}

async function loadFavoritesStore() {
  try {
    if (!fs.existsSync(FAVORITES_FILE)) {
      return defaultFavoritesStore();
    }

    const raw = await fsp.readFile(FAVORITES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const playlists = parsed && typeof parsed === 'object' && parsed.playlists && typeof parsed.playlists === 'object'
      ? parsed.playlists
      : {};

    const normalizedPlaylists = {};
    for (const [name, value] of Object.entries(playlists)) {
      const safeName = normalizePlaylistName(name);
      if (!safeName) {
        continue;
      }

      // Backward compatibility if a playlist was stored as an array of names.
      if (Array.isArray(value)) {
        normalizedPlaylists[safeName] = normalizePlaylistRecord({
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          items: value
        });
        continue;
      }

      normalizedPlaylists[safeName] = normalizePlaylistRecord(value);
    }

    return { playlists: normalizedPlaylists };
  } catch {
    return defaultFavoritesStore();
  }
}

async function saveFavoritesStore(store) {
  await fsp.writeFile(FAVORITES_FILE, JSON.stringify(store, null, 2), 'utf8');
}

async function buildFavoritesResponse() {
  const allVideos = await listAllVideoFiles();
  const byName = new Map(allVideos.map((video) => [video.name, video]));
  const store = await loadFavoritesStore();
  const playlists = [];

  for (const [name, record] of Object.entries(store.playlists)) {
    const items = [];
    const seen = new Set();

    for (const videoName of record.items) {
      if (seen.has(videoName)) {
        continue;
      }
      const video = byName.get(videoName);
      if (video) {
        items.push({
          name: video.name,
          url: video.url
        });
        seen.add(videoName);
      }
    }

    playlists.push({
      name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      count: items.length,
      items
    });
  }

  // Sort playlists by creation order, maintaining consistent order regardless of updates
  playlists.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { playlists };
}

async function removeVideoFromFavorites(videoName) {
  const store = await loadFavoritesStore();
  let changed = false;

  for (const playlist of Object.values(store.playlists)) {
    const before = playlist.items.length;
    playlist.items = playlist.items.filter((name) => name !== videoName);
    if (playlist.items.length !== before) {
      playlist.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await saveFavoritesStore(store);
  }
}

async function renameVideoInFavorites(oldName, newName) {
  const store = await loadFavoritesStore();
  let changed = false;

  for (const playlist of Object.values(store.playlists)) {
    const nextItems = playlist.items.map((name) => (name === oldName ? newName : name));
    if (nextItems.join('\0') !== playlist.items.join('\0')) {
      playlist.items = Array.from(new Set(nextItems));
      playlist.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    await saveFavoritesStore(store);
  }
}

async function renameVideoInPlaylistState(oldName, newName) {
  const state = await loadPlaylistState();
  const order = state.order.map((name) => name === oldName ? newName : name);
  const hidden = state.hidden.map((name) => name === oldName ? newName : name);

  if (order.join('\0') !== state.order.join('\0') || hidden.join('\0') !== state.hidden.join('\0')) {
    await savePlaylistState({ order, hidden });
  }
}

async function listVideos() {
  const dirents = await fsp.readdir(VIDEOS_DIR, { withFileTypes: true });
  const fsFilesWithDates = await Promise.all(
    dirents
      .filter((d) => d.isFile() && isAllowedVideo(d.name))
      .map(async (d) => {
        const fullPath = path.join(VIDEOS_DIR, d.name);
        const stats = await fsp.stat(fullPath);
        const downloadedAtMs =
          Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
            ? stats.birthtimeMs
            : stats.mtimeMs;

        return {
          name: d.name,
          downloadedAtMs
        };
      })
  );

  const { hidden } = await loadPlaylistState();
  const hiddenSet = new Set(hidden);
  const ordered = fsFilesWithDates
    .sort((a, b) => {
      if (b.downloadedAtMs !== a.downloadedAtMs) {
        return b.downloadedAtMs - a.downloadedAtMs;
      }
      return a.name.localeCompare(b.name);
    })
    .filter((file) =>
      !hiddenSet.has(file.name) &&
      !isTrimmedVideoName(file.name) &&
      !isTemporaryTrimFile(file.name) &&
      isUsableVideoFile(path.join(VIDEOS_DIR, file.name))
    )
    .map((file) => file.name);

  return ordered.map((name) => ({
    name,
    url: `/media/${encodeURIComponent(name)}`
  }));
}

async function listAllVideoFiles() {
  const dirents = await fsp.readdir(VIDEOS_DIR, { withFileTypes: true });
  const filesWithDates = await Promise.all(
    dirents
      .filter((d) => d.isFile() && isAllowedVideo(d.name))
      .map(async (d) => {
        const fullPath = path.join(VIDEOS_DIR, d.name);
        const stats = await fsp.stat(fullPath);
        const downloadedAtMs =
          Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
            ? stats.birthtimeMs
            : stats.mtimeMs;

        return {
          name: d.name,
          downloadedAtMs
        };
      })
  );

  return filesWithDates
    .sort((a, b) => {
      if (b.downloadedAtMs !== a.downloadedAtMs) {
        return b.downloadedAtMs - a.downloadedAtMs;
      }
      return a.name.localeCompare(b.name);
    })
    .filter((file) => !isTemporaryTrimFile(file.name) && isUsableVideoFile(path.join(VIDEOS_DIR, file.name)))
    .map((file) => ({
      name: file.name,
      url: `/media/${encodeURIComponent(file.name)}`
    }));
}

function runYtDlpDownload({
  videoUrl,
  cookiesFile,
  cookiesFromBrowser,
  downloadPlaylist,
  ytDlpPath
}) {
  const bin = resolveYtDlpBin(ytDlpPath);
  const ffmpegDir = findWingetFfmpegDir();
  const args = [
    '--no-warnings',
    '--newline',
    '--paths',
    VIDEOS_DIR,
    '--output',
    '%(title).180B [%(id)s].%(ext)s',
    '--format',
    'bv*+ba/b',
    '--merge-output-format',
    'mp4'
  ];

  if (ffmpegDir) {
    args.push('--ffmpeg-location', ffmpegDir);
  }

  if (downloadPlaylist) {
    args.push('--yes-playlist');
  } else {
    args.push('--no-playlist');
  }

  if (cookiesFromBrowser) {
    args.push('--cookies-from-browser', cookiesFromBrowser);
  }

  if (cookiesFile) {
    args.push('--cookies', cookiesFile);
  }

  args.push(videoUrl);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const e = new Error('yt-dlp exited with a non-zero code.');
      e.code = code;
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
  });
}

function enqueueDownloadJob(jobId, payload) {
  DOWNLOAD_QUEUE.push({ jobId, payload });
  processDownloadQueue();
}

function processDownloadQueue() {
  while (ACTIVE_DOWNLOADS < MAX_CONCURRENT_DOWNLOADS && DOWNLOAD_QUEUE.length > 0) {
    const next = DOWNLOAD_QUEUE.shift();
    ACTIVE_DOWNLOADS += 1;
    runDownloadJob(next.jobId, next.payload)
      .catch(() => {
        // Errors are handled and stored on the job itself.
      })
      .finally(() => {
        ACTIVE_DOWNLOADS = Math.max(0, ACTIVE_DOWNLOADS - 1);
        processDownloadQueue();
      });
  }
}

async function runDownloadJob(jobId, payload) {
  const { url, cookiesFile, cookiesFromBrowser, downloadPlaylist, ytDlpPath } = payload;

  try {
    updateJobStatus(jobId, 'downloading', { log: 'Initializing yt-dlp...' });

    const result = await runYtDlpDownload({
      videoUrl: url,
      cookiesFile,
      cookiesFromBrowser,
      downloadPlaylist,
      ytDlpPath
    });

    const logs = `${result.stdout}\n${result.stderr}`.trim();
    logs.split('\n').forEach((line) => {
      if (line.trim()) {
        updateJobStatus(jobId, 'downloading', { log: line });
      }
    });

    await listVideos();
    updateJobStatus(jobId, 'completed', {
      log: 'Download complete. Video added to playlist.',
      endTime: Date.now()
    });
  } catch (err) {
    let errorMsg = 'Download failed.';
    if (err.code === 'ENOENT') {
      errorMsg =
        'yt-dlp executable was not found. Install yt-dlp and ffmpeg, or set YT_DLP_BIN to the yt-dlp executable path.';
    }

    const logs = `${err.stdout || ''}\n${err.stderr || ''}`.trim();
    logs.split('\n').forEach((line) => {
      if (line.trim()) {
        updateJobStatus(jobId, 'downloading', { log: line });
      }
    });

    updateJobStatus(jobId, 'failed', {
      error: errorMsg,
      log: `Error: ${errorMsg}`,
      endTime: Date.now()
    });
  }
}

function getYtDlpVersion(ytDlpPath) {
  const bin = resolveYtDlpBin(ytDlpPath);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version'], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve((stdout || '').trim());
        return;
      }

      const e = new Error('yt-dlp --version failed.');
      e.code = code;
      e.stderr = stderr;
      reject(e);
    });
  });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, VIDEOS_DIR),
  filename: (_req, file, cb) => {
    const base = path.basename(file.originalname);
    cb(null, base);
  }
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (!isAllowedVideo(file.originalname)) {
      cb(new Error('Only video files are allowed.'));
      return;
    }
    cb(null, true);
  }
});

app.use(express.json());
app.use('/assets', express.static(PUBLIC_DIR));
app.use('/media', express.static(VIDEOS_DIR));

app.get('/loveshack', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'loveshack.html'));
});

app.get('/loveshack-favorites', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'loveshack-favorites.html'));
});

app.get('/loveshack-edit', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'loveshack-edit.html'));
});

app.get('/mix-vid', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'mix-vid.html'));
});

app.get('/api/videos', async (_req, res) => {
  try {
    const videos = await listVideos();
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: 'Could not list videos.' });
  }
});

app.post('/api/videos/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded.' });
    return;
  }

  try {
    const videos = await listVideos();
    res.status(201).json({ message: 'Uploaded.', videos });
  } catch (err) {
    res.status(500).json({ error: 'Upload succeeded but listing failed.' });
  }
});

app.delete('/api/videos/:name', async (req, res) => {
  try {
    const { base, full } = safeVideoPath(req.params.name);
    if (!isAllowedVideo(base)) {
      res.status(400).json({ error: 'Unsupported file type.' });
      return;
    }

    const inFavorites = await isVideoInFavorites(base);
    if (inFavorites) {
      await removeFromMainPlaylistOnly(base);
      const videos = await listVideos();
      res.json({
        message: 'Removed from main playlist only. File was kept because it exists in favorites.',
        videos
      });
      return;
    }

    await fsp.unlink(full);
    const videos = await listVideos();
    res.json({ message: 'Deleted.', videos });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found.' });
      return;
    }
    res.status(500).json({ error: 'Could not delete video.' });
  }
});

app.post('/api/videos/rename', async (req, res) => {
  const { oldName, newName } = req.body || {};

  if (!oldName || !newName) {
    res.status(400).json({ error: 'oldName and newName are required.' });
    return;
  }

  try {
    const oldSafe = safeVideoPath(oldName);
    const newSafe = safeVideoPath(newName);

    if (!isAllowedVideo(oldSafe.base) || !isAllowedVideo(newSafe.base)) {
      res.status(400).json({ error: 'Unsupported file type.' });
      return;
    }

    if (oldSafe.base === newSafe.base) {
      res.status(400).json({ error: 'The new name must be different.' });
      return;
    }
    if (!fs.existsSync(oldSafe.full)) {
      res.status(404).json({ error: 'Source file not found.' });
      return;
    }
    if (fs.existsSync(newSafe.full)) {
      res.status(409).json({ error: 'Target file already exists.' });
      return;
    }

    await fsp.rename(oldSafe.full, newSafe.full);
    await renameVideoInFavorites(oldSafe.base, newSafe.base);
    await renameVideoInPlaylistState(oldSafe.base, newSafe.base);
    const videos = await listVideos();
    const favorites = await buildFavoritesResponse();
    res.json({ message: 'Renamed.', videos, ...favorites });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Source file not found.' });
      return;
    }
    if (err.code === 'EEXIST') {
      res.status(409).json({ error: 'Target file already exists.' });
      return;
    }
    res.status(500).json({ error: 'Could not rename video.' });
  }
});

app.get('/api/videos/downloader-status', async (req, res) => {
  const ytDlpPath = req.query?.ytDlpPath;

  try {
    const version = await getYtDlpVersion(ytDlpPath);
    res.json({
      ok: true,
      downloader: 'yt-dlp',
      version
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(200).json({
        ok: false,
        downloader: 'yt-dlp',
        error:
          'yt-dlp was not found. Install yt-dlp + ffmpeg, or set YT_DLP_BIN to yt-dlp executable path.'
      });
      return;
    }

    res.status(200).json({
      ok: false,
      downloader: 'yt-dlp',
      error: 'Downloader check failed.'
    });
  }
});

app.post('/api/videos/download', async (req, res) => {
  const {
    url,
    cookiesFile,
    cookiesFromBrowser,
    downloadPlaylist,
    ytDlpPath
  } = req.body || {};

  if (!url || !isHttpUrl(url)) {
    res.status(400).json({ error: 'A valid http(s) URL is required.' });
    return;
  }

  if (cookiesFromBrowser && !isSimpleBrowserSpec(cookiesFromBrowser)) {
    res.status(400).json({ error: 'cookiesFromBrowser contains invalid characters.' });
    return;
  }

  if (cookiesFile) {
    const cookiePath = path.resolve(ROOT_DIR, cookiesFile);
    if (!cookiePath.startsWith(ROOT_DIR)) {
      res.status(400).json({ error: 'cookiesFile must be within this workspace.' });
      return;
    }

    if (!fs.existsSync(cookiePath)) {
      res.status(400).json({ error: `cookiesFile not found: ${cookiesFile}` });
      return;
    }
  }

  const job = createDownloadJob(url);
  updateJobStatus(job.id, 'queued', { log: `Queued download: ${url}` });

  res.status(202).json({
    message: 'Download job started.',
    jobId: job.id,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS
  });

  enqueueDownloadJob(job.id, {
    url,
    cookiesFile: cookiesFile ? path.resolve(ROOT_DIR, cookiesFile) : undefined,
    cookiesFromBrowser,
    downloadPlaylist: Boolean(downloadPlaylist),
    ytDlpPath
  });
});

app.get('/api/videos/download-jobs', (_req, res) => {
  res.json({
    jobs: listJobInfos(),
    activeDownloads: ACTIVE_DOWNLOADS,
    queuedDownloads: DOWNLOAD_QUEUE.length,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS
  });
});

app.get('/api/videos/download-jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = getJobInfo(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  res.json(job);
});

app.get('/api/favorites/playlists', async (_req, res) => {
  try {
    const data = await buildFavoritesResponse();
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Could not load favorites playlists.' });
  }
});

app.post('/api/favorites/add', async (req, res) => {
  const { videoName, playlistName } = req.body || {};
  const safePlaylistName = normalizePlaylistName(playlistName);

  if (!videoName || !safePlaylistName) {
    res.status(400).json({ error: 'videoName and playlistName are required.' });
    return;
  }

  try {
    const { base, full } = safeVideoPath(videoName);
    if (!isAllowedVideo(base)) {
      res.status(400).json({ error: 'Unsupported file type.' });
      return;
    }

    if (!fs.existsSync(full)) {
      res.status(404).json({ error: 'Video not found.' });
      return;
    }

    const store = await loadFavoritesStore();
    const now = new Date().toISOString();
    if (!store.playlists[safePlaylistName]) {
      store.playlists[safePlaylistName] = {
        createdAt: now,
        updatedAt: now,
        items: []
      };
    }

    const playlist = store.playlists[safePlaylistName];
    if (!playlist.items.includes(base)) {
      playlist.items.push(base);
      playlist.updatedAt = now;
      await saveFavoritesStore(store);
    }

    const data = await buildFavoritesResponse();
    res.json({ message: 'Added to favorites playlist.', ...data });
  } catch {
    res.status(500).json({ error: 'Could not add video to favorites playlist.' });
  }
});

app.delete('/api/favorites/playlists/:playlistName', async (req, res) => {
  const playlistName = normalizePlaylistName(req.params.playlistName || '');

  if (!playlistName) {
    res.status(400).json({ error: 'playlistName is required.' });
    return;
  }

  try {
    const store = await loadFavoritesStore();
    if (!store.playlists[playlistName]) {
      res.status(404).json({ error: 'Favorites playlist not found.' });
      return;
    }

    delete store.playlists[playlistName];
    await saveFavoritesStore(store);

    const data = await buildFavoritesResponse();
    res.json({ message: 'Deleted favorites playlist.', ...data });
  } catch {
    res.status(500).json({ error: 'Could not delete favorites playlist.' });
  }
});

app.delete('/api/favorites/playlists/:playlistName/videos/:videoName', async (req, res) => {
  const playlistName = normalizePlaylistName(req.params.playlistName || '');
  const videoName = path.basename(req.params.videoName || '');

  if (!playlistName || !videoName) {
    res.status(400).json({ error: 'playlistName and videoName are required.' });
    return;
  }

  try {
    const store = await loadFavoritesStore();
    const playlist = store.playlists[playlistName];

    if (!playlist) {
      res.status(404).json({ error: 'Favorites playlist not found.' });
      return;
    }

    const before = playlist.items.length;
    playlist.items = playlist.items.filter((name) => name !== videoName);
    if (playlist.items.length !== before) {
      playlist.updatedAt = new Date().toISOString();
      await saveFavoritesStore(store);
    }

    const data = await buildFavoritesResponse();
    res.json({ message: 'Removed from favorites playlist.', ...data });
  } catch {
    res.status(500).json({ error: 'Could not remove video from favorites playlist.' });
  }
});

app.post('/api/favorites/playlists/:playlistName/move', async (req, res) => {
  const playlistName = normalizePlaylistName(req.params.playlistName || '');
  const { videoName, direction } = req.body || {};

  if (!playlistName || !videoName || !['up', 'down'].includes(direction)) {
    res.status(400).json({ error: 'playlistName, videoName, and direction (up|down) are required.' });
    return;
  }

  try {
    const safeVideoName = path.basename(videoName);
    const store = await loadFavoritesStore();
    const playlist = store.playlists[playlistName];

    if (!playlist) {
      res.status(404).json({ error: 'Favorites playlist not found.' });
      return;
    }

    const idx = playlist.items.indexOf(safeVideoName);
    if (idx === -1) {
      res.status(404).json({ error: 'Video not found in favorites playlist.' });
      return;
    }

    if (direction === 'up' && idx === 0) {
      res.status(400).json({ error: 'Already at the top.' });
      return;
    }

    if (direction === 'down' && idx === playlist.items.length - 1) {
      res.status(400).json({ error: 'Already at the bottom.' });
      return;
    }

    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    [playlist.items[idx], playlist.items[newIdx]] = [playlist.items[newIdx], playlist.items[idx]];
    playlist.updatedAt = new Date().toISOString();

    await saveFavoritesStore(store);
    const data = await buildFavoritesResponse();
    res.json({ message: 'Favorites playlist reordered.', ...data });
  } catch {
    res.status(500).json({ error: 'Could not reorder favorites playlist.' });
  }
});

app.post('/api/favorites/to-main', async (req, res) => {
  const { videoName } = req.body || {};

  if (!videoName) {
    res.status(400).json({ error: 'videoName is required.' });
    return;
  }

  try {
    const { base, full } = safeVideoPath(videoName);
    if (!isAllowedVideo(base)) {
      res.status(400).json({ error: 'Unsupported file type.' });
      return;
    }

    if (!fs.existsSync(full)) {
      res.status(404).json({ error: 'Video not found.' });
      return;
    }

    await sendToMainPlaylist(base);
    const updatedVideos = await listVideos();
    res.json({
      message: 'Video moved to top of main playlist.',
      videos: updatedVideos
    });
  } catch {
    res.status(500).json({ error: 'Could not move video to main playlist.' });
  }
});

app.post('/api/videos/trim', async (req, res) => {
  const { videoName, start, end, playlistName, mode = 'single', segments } = req.body || {};
  const safePlaylistName = normalizePlaylistName(playlistName);
  let base = null;
  let full = null;
  let outputName = null;
  let outputFull = null;
  let startSeconds = null;
  let endSeconds = null;
  let trimLockKey = null;

  await appendTrimDebugLog({
    stage: 'request_received',
    videoName,
    start,
    end,
    playlistName,
    safePlaylistName
  });

  if (!videoName || !safePlaylistName || !start || !end) {
    await appendTrimDebugLog({
      stage: 'request_invalid',
      reason: 'missing_required_fields',
      videoName,
      start,
      end,
      playlistName: safePlaylistName
    });
    res.status(400).json({ error: 'videoName, start, end, and playlistName are required.' });
    return;
  }

  startSeconds = parseTimeToSeconds(start);
  endSeconds = parseTimeToSeconds(end);

  await appendTrimDebugLog({
    stage: 'parsed_times',
    startSeconds,
    endSeconds,
    start,
    end
  });

  if (startSeconds === null || endSeconds === null) {
    await appendTrimDebugLog({
      stage: 'request_invalid',
      reason: 'invalid_time_values',
      start,
      end,
      startSeconds,
      endSeconds
    });
    res.status(400).json({ error: 'start and end must be valid time values such as 00:15 or 01:02:30.' });
    return;
  }

  if (startSeconds >= endSeconds) {
    await appendTrimDebugLog({
      stage: 'request_invalid',
      reason: 'start_after_end',
      startSeconds,
      endSeconds
    });
    res.status(400).json({ error: 'Cut end time must be after the start time.' });
    return;
  }

  if (!['single', 'keep-scenes', 'remove-scene'].includes(mode)) {
    res.status(400).json({ error: 'Unsupported edit mode.' });
    return;
  }

  const normalizedSegments = Array.isArray(segments)
    ? segments.map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end)
    })).sort((a, b) => a.start - b.start)
    : [];
  if (mode !== 'single' && normalizedSegments.length !== 2) {
    res.status(400).json({ error: 'Two valid scene ranges are required.' });
    return;
  }
  if (mode !== 'single' && normalizedSegments.some((segment) =>
    !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
    segment.start < 0 || segment.end <= segment.start
  )) {
    res.status(400).json({ error: 'Scene ranges must have valid start and end times.' });
    return;
  }
  if (mode !== 'single' && normalizedSegments[1].start < normalizedSegments[0].end &&
    normalizedSegments[0].start < normalizedSegments[1].end) {
    res.status(400).json({ error: 'Scene ranges must not overlap.' });
    return;
  }

  try {
    const resolved = safeVideoPath(videoName);
    base = resolved.base;
    full = resolved.full;

    await appendTrimDebugLog({
      stage: 'source_resolved',
      base,
      full,
      exists: fs.existsSync(full)
    });

    if (!isAllowedVideo(base)) {
      await appendTrimDebugLog({
        stage: 'request_invalid',
        reason: 'unsupported_extension',
        base
      });
      res.status(400).json({ error: 'Unsupported file type.' });
      return;
    }

    if (isTrimmedVideoName(base)) {
      await appendTrimDebugLog({
        stage: 'request_invalid',
        reason: 'already_trimmed_clip',
        base
      });
      res.status(400).json({ error: 'Please choose an original video, not an already-trimmed clip.' });
      return;
    }

    if (!fs.existsSync(full)) {
      await appendTrimDebugLog({
        stage: 'request_invalid',
        reason: 'video_not_found',
        full
      });
      res.status(404).json({ error: 'Video not found.' });
      return;
    }

    outputName = mode === 'single'
      ? buildTrimmedVideoName(base, startSeconds, endSeconds)
      : buildMultiSceneVideoName(base, mode, normalizedSegments);
    outputFull = path.join(VIDEOS_DIR, outputName);
    trimLockKey = outputFull.toLowerCase();

    if (ACTIVE_TRIMS.has(trimLockKey)) {
      await appendTrimDebugLog({
        stage: 'trim_rejected',
        reason: 'duplicate_trim_in_progress',
        outputName,
        outputFull
      });
      res.status(409).json({ error: 'This trim is already in progress. Wait for it to finish.' });
      return;
    }

    ACTIVE_TRIMS.add(trimLockKey);
    await appendTrimDebugLog({
      stage: 'trim_started',
      outputName,
      outputFull,
      ffmpeg: resolveFfmpegBin(),
      startSeconds,
      endSeconds
    });

    const sourceUsable = isUsableVideoFile(full) || (await probeVideoFile(full));
    await appendTrimDebugLog({
      stage: 'trim_target_ready',
      outputName,
      outputFull,
      sourceUsable,
      outputExists: fs.existsSync(outputFull),
      outputUsable: fs.existsSync(outputFull) ? (isUsableVideoFile(outputFull) || (await probeVideoFile(outputFull))) : false
    });

    if (!sourceUsable) {
      await appendTrimDebugLog({
        stage: 'request_invalid',
        reason: 'source_not_usable',
        full,
        sourceUsable
      });
      res.status(400).json({ error: 'Source video is missing or not a valid media file.' });
      return;
    }

    if (mode !== 'single') {
      const sourceDuration = await getVideoDuration(full);
      if (!Number.isFinite(sourceDuration) || normalizedSegments.some((segment) => segment.end > sourceDuration)) {
        await appendTrimDebugLog({
          stage: 'request_invalid',
          reason: 'scene_outside_source_duration',
          sourceDuration,
          segments: normalizedSegments
        });
        res.status(400).json({ error: 'Both scene ranges must stay within the source video duration.' });
        return;
      }
    }

    const outputUsableBefore = fs.existsSync(outputFull) ? (isUsableVideoFile(outputFull) || (await probeVideoFile(outputFull))) : false;

    if (fs.existsSync(outputFull) && outputUsableBefore) {
      await appendTrimDebugLog({
        stage: 'reusing_existing_trim',
        reason: 'output_already_exists_and_usable',
        outputName,
        outputFull
      });
    } else if (fs.existsSync(outputFull) && !outputUsableBefore) {
      await appendTrimDebugLog({
        stage: 'cleanup_partial_output',
        outputName,
        outputFull
      });
      removePartialTrimFile(outputFull);

      await appendTrimDebugLog({
        stage: 'calling_ffmpeg',
        source: full,
        output: outputFull,
        startSeconds,
        endSeconds
      });

      if (mode === 'single') {
        await trimVideoFile(full, outputFull, startSeconds, endSeconds);
      } else {
        await stitchVideoSegments(full, outputFull, normalizedSegments, mode);
      }
    } else {
      await appendTrimDebugLog({
        stage: 'calling_ffmpeg',
        source: full,
        output: outputFull,
        startSeconds,
        endSeconds
      });

      if (mode === 'single') {
        await trimVideoFile(full, outputFull, startSeconds, endSeconds);
      } else {
        await stitchVideoSegments(full, outputFull, normalizedSegments, mode);
      }
    }

    const trimmedUsable = await probeVideoFile(outputFull);
    await appendTrimDebugLog({
      stage: 'post_trim_validation',
      outputFull,
      trimmedUsable,
      outputExists: fs.existsSync(outputFull),
      outputSize: fs.existsSync(outputFull) ? fs.statSync(outputFull).size : 0
    });

    if (!trimmedUsable) {
      throw new Error('Trim output was created but is not a valid media file.');
    }

    await removeFromMainPlaylistOnly(outputName);

    const store = await loadFavoritesStore();
    const now = new Date().toISOString();
    if (!store.playlists[safePlaylistName]) {
      store.playlists[safePlaylistName] = {
        createdAt: now,
        updatedAt: now,
        items: []
      };
    }

    const playlist = store.playlists[safePlaylistName];
    if (!playlist.items.includes(outputName)) {
      playlist.items.push(outputName);
      playlist.updatedAt = now;
    }

    await saveFavoritesStore(store);
    const data = await buildFavoritesResponse();

    await appendTrimDebugLog({
      stage: 'saved_to_favorites',
      playlistName: safePlaylistName,
      outputName,
      playlistItemsCount: playlist.items.length,
      favoritesResponsePlaylists: data.playlists.map((p) => p.name)
    });

    res.status(201).json({
      message: 'Trimmed clip saved to favorites playlist.',
      videoName: outputName,
      playlistName: safePlaylistName,
      ...data
    });
  } catch (err) {
    const partialTarget = outputFull || path.join(VIDEOS_DIR, buildTrimmedVideoName(base || videoName, startSeconds ?? 0, endSeconds ?? 0));
    removePartialTrimFile(partialTarget);
    const message = err && err.stderr
      ? String(err.stderr).trim() || 'Could not trim video.'
      : err && err.message
        ? err.message
        : 'Could not trim video.';

    await appendTrimDebugLog({
      stage: 'trim_failed',
      reason: 'exception_thrown',
      videoName,
      base,
      full,
      outputName,
      outputFull,
      startSeconds,
      endSeconds,
      playlistName: safePlaylistName,
      errorMessage: message,
      errorStack: err && err.stack ? err.stack : null
    });

    res.status(500).json({ error: message });
  } finally {
    if (trimLockKey) {
      ACTIVE_TRIMS.delete(trimLockKey);
    }
  }
});

async function getVideosForMixSource(playlistSource) {
  if (playlistSource === MAIN_PLAYLIST_KEY) {
    return listVideos();
  }

  const safeName = normalizePlaylistName(playlistSource);
  const store = await loadFavoritesStore();
  const playlist = store.playlists[safeName];
  if (!playlist) {
    return null;
  }

  const allVideos = await listAllVideoFiles();
  const byName = new Map(allVideos.map((video) => [video.name, video]));
  return playlist.items
    .map((name) => byName.get(name))
    .filter(Boolean);
}

app.post('/api/videos/mix', async (req, res) => {
  const { playlistSource, clipSeconds, totalSeconds, arrangement, mixedOrder } = req.body || {};
  const safeArrangement = arrangement === 'mixed' ? 'mixed' : 'linear';
  const clipSecondsNum = Number(clipSeconds);
  const totalSecondsNum = Number(totalSeconds);

  if (!playlistSource || typeof playlistSource !== 'string') {
    res.status(400).json({ error: 'playlistSource is required.' });
    return;
  }

  if (!Number.isFinite(clipSecondsNum) || clipSecondsNum <= 0) {
    res.status(400).json({ error: 'clipSeconds must be a positive number.' });
    return;
  }

  if (!Number.isFinite(totalSecondsNum) || totalSecondsNum <= 0) {
    res.status(400).json({ error: 'totalSeconds must be a positive number.' });
    return;
  }

  let mixLockKey = null;

  try {
    const sourceVideos = await getVideosForMixSource(playlistSource);
    if (!sourceVideos) {
      res.status(404).json({ error: 'Playlist not found.' });
      return;
    }

    if (sourceVideos.length === 0) {
      res.status(400).json({ error: 'The selected playlist has no videos.' });
      return;
    }

    const videosWithDuration = [];
    for (const video of sourceVideos) {
      const fullPath = path.join(VIDEOS_DIR, video.name);
      const duration = await getVideoDuration(fullPath);
      if (Number.isFinite(duration) && duration > 0) {
        videosWithDuration.push({ name: video.name, fullPath, duration });
      }
    }

    if (videosWithDuration.length === 0) {
      res.status(400).json({ error: 'Could not read durations for any videos in this playlist.' });
      return;
    }

    const plan = buildMixPlan(videosWithDuration, {
      clipSeconds: clipSecondsNum,
      totalSeconds: totalSecondsNum,
      arrangement: safeArrangement,
      mixedOrder: Boolean(mixedOrder)
    });

    if (plan.length === 0) {
      res.status(400).json({ error: 'Could not build a mix from this playlist with the given options.' });
      return;
    }

    const byName = new Map(videosWithDuration.map((video) => [video.name, video.fullPath]));
    const clipPlans = plan.map((clip) => ({
      ...clip,
      fullPath: byName.get(clip.videoName)
    }));

    const outputName = buildMixVideoName(new Date());
    const outputFull = path.join(VIDEOS_DIR, outputName);
    mixLockKey = outputFull.toLowerCase();

    if (ACTIVE_MIXES.has(mixLockKey)) {
      res.status(409).json({ error: 'A mix with this name is already being created. Try again in a moment.' });
      return;
    }

    ACTIVE_MIXES.add(mixLockKey);

    await buildMixVideoFile(clipPlans, outputFull);

    const mixUsable = await probeVideoFile(outputFull);
    if (!mixUsable) {
      throw new Error('Mix video was created but is not a valid media file.');
    }

    let favorites = null;
    if (playlistSource === MAIN_PLAYLIST_KEY) {
      await sendToMainPlaylist(outputName);
    } else {
      const safePlaylistName = normalizePlaylistName(playlistSource);
      await removeFromMainPlaylistOnly(outputName);
      const store = await loadFavoritesStore();
      const now = new Date().toISOString();
      if (!store.playlists[safePlaylistName]) {
        store.playlists[safePlaylistName] = { createdAt: now, updatedAt: now, items: [] };
      }
      const playlist = store.playlists[safePlaylistName];
      if (!playlist.items.includes(outputName)) {
        playlist.items.push(outputName);
        playlist.updatedAt = now;
      }
      await saveFavoritesStore(store);
      favorites = await buildFavoritesResponse();
    }

    const videos = await listVideos();
    res.status(201).json({
      message: `Mix video created and added to the playlist as ${outputName}.`,
      videoName: outputName,
      videos,
      ...(favorites ? favorites : {})
    });
  } catch (err) {
    const message = err && err.stderr
      ? String(err.stderr).trim() || 'Could not create mix video.'
      : err && err.message
        ? err.message
        : 'Could not create mix video.';
    res.status(500).json({ error: message });
  } finally {
    if (mixLockKey) {
      ACTIVE_MIXES.delete(mixLockKey);
    }
  }
});

app.post('/api/videos/move', async (req, res) => {
  res.status(400).json({
    error: 'Manual move is disabled. Videos are auto-sorted by download date.'
  });
});

app.get('/', (_req, res) => {
  res.redirect('/loveshack');
});

if (require.main === module) {
  ensureDirectories()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Playlist service running at http://localhost:${PORT}/loveshack`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize directories:', err);
      process.exit(1);
    });
}

module.exports = {
  app,
  buildTrimmedVideoName,
  buildMultiSceneVideoName,
  formatTrimStamp,
  isTemporaryTrimFile,
  isTrimmedVideoName,
  parseTimeToSeconds,
  removePartialTrimFile,
  resolveFfmpegBin,
  resolveFfprobeBin,
  trimVideoFile,
  stitchVideoSegments,
  computeVideoSegments,
  buildMixPlan,
  buildMixVideoName,
  formatMixDateStamp,
  safeVideoPath,
  isUsableVideoFile,
  probeVideoFile
};
