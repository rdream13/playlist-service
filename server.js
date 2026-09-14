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
const DOWNLOAD_JOBS = new Map(); // jobId -> job object
const DOWNLOAD_QUEUE = [];
const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10) || 3
);
let ACTIVE_DOWNLOADS = 0;

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

function safeVideoPath(fileName) {
  const base = path.basename(fileName);
  const full = path.join(VIDEOS_DIR, base);
  if (!full.startsWith(VIDEOS_DIR)) {
    throw new Error('Invalid file path.');
  }
  return { base, full };
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

function normalizePlaylistName(name) {
  if (typeof name !== 'string') {
    return '';
  }
  return name.trim().replace(/\s+/g, ' ').slice(0, 80);
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
    .filter((file) => !hiddenSet.has(file.name))
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

    await fsp.rename(oldSafe.full, newSafe.full);
    await renameVideoInFavorites(oldSafe.base, newSafe.base);
    const videos = await listVideos();
    res.json({ message: 'Renamed.', videos });
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

app.post('/api/videos/move', async (req, res) => {
  res.status(400).json({
    error: 'Manual move is disabled. Videos are auto-sorted by download date.'
  });
});

app.get('/', (_req, res) => {
  res.redirect('/loveshack');
});

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
