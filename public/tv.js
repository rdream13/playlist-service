const DEFAULT_CLIP_SECONDS = 75;
const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 3600;

const state = {
  mainVideos: [],
  favoritesPlaylists: [],
  pool: [],
  active: false,
  clipEndTime: 0,
  currentVideoName: '',
  // Played (and pre-fetched-by-navigation) clips, so Previous can replay the exact same clip.
  history: [],
  historyIndex: -1
};

const el = {
  sourceList: document.getElementById('tvSourceList'),
  refreshBtn: document.getElementById('refreshTvBtn'),
  startBtn: document.getElementById('tvStartBtn'),
  stopBtn: document.getElementById('tvStopBtn'),
  prevBtn: document.getElementById('tvPrevBtn'),
  nextBtn: document.getElementById('tvNextBtn'),
  player: document.getElementById('tvPlayer'),
  nowPlaying: document.getElementById('tvNowPlaying'),
  status: document.getElementById('tvStatus'),
  clipSeconds: document.getElementById('tvClipSeconds')
};

function getClipSeconds() {
  const parsed = Number.parseInt(el.clipSeconds?.value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CLIP_SECONDS;
  }
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, parsed));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchMainVideos() {
  const res = await fetch('/api/videos');
  if (!res.ok) {
    throw new Error('Failed to fetch main playlist.');
  }
  const data = await res.json();
  state.mainVideos = data.videos || [];
}

async function fetchFavoritesPlaylists() {
  const res = await fetch('/api/favorites/playlists');
  if (!res.ok) {
    throw new Error('Failed to fetch favorites playlists.');
  }
  const data = await res.json();
  state.favoritesPlaylists = data.playlists || [];
}

function renderSourceList() {
  // Keep prior checked state across refreshes so a running channel selection isn't reset.
  const previouslyChecked = new Set(
    [...el.sourceList.querySelectorAll('.tv-source-checkbox:checked')].map((cb) => cb.value)
  );
  const isFirstRender = el.sourceList.dataset.rendered !== 'true';

  const rows = [];
  rows.push(`
    <label class="tv-source-row">
      <input type="checkbox" value="__main__" class="tv-source-checkbox" ${
        isFirstRender || previouslyChecked.has('__main__') ? 'checked' : ''
      } />
      Main Playlist (${state.mainVideos.length})
    </label>
  `);

  state.favoritesPlaylists.forEach((playlist) => {
    rows.push(`
      <label class="tv-source-row">
        <input type="checkbox" value="${escapeHtml(playlist.name)}" class="tv-source-checkbox" ${
          previouslyChecked.has(playlist.name) ? 'checked' : ''
        } />
        ${escapeHtml(playlist.name)} (${playlist.count})
      </label>
    `);
  });

  el.sourceList.innerHTML = rows.join('');
  el.sourceList.dataset.rendered = 'true';
}

function buildPool() {
  const selectedValues = [...el.sourceList.querySelectorAll('.tv-source-checkbox:checked')].map(
    (cb) => cb.value
  );

  const byName = new Map();

  if (selectedValues.includes('__main__')) {
    state.mainVideos.forEach((video) => byName.set(video.name, video));
  }

  state.favoritesPlaylists
    .filter((playlist) => selectedValues.includes(playlist.name))
    .forEach((playlist) => {
      (playlist.items || []).forEach((video) => byName.set(video.name, video));
    });

  return [...byName.values()];
}

function setNowPlaying(name) {
  state.currentVideoName = name || '';
  el.nowPlaying.textContent = `Now Playing: ${name || 'none'}`;
}

function pickRandomVideo() {
  if (!state.pool.length) {
    return null;
  }
  const index = Math.floor(Math.random() * state.pool.length);
  return state.pool[index];
}

function playHistoryEntry(index) {
  const entry = state.history[index];
  if (!entry) {
    return;
  }

  state.historyIndex = index;
  state.clipEndTime = 0;
  setNowPlaying(entry.video.name);
  el.player.src = entry.video.url;
  el.player.load();
}

// Moves forward: replays existing history if Previous was used, otherwise picks a new random clip.
function advanceToNextClip() {
  if (!state.active) {
    return;
  }

  if (state.historyIndex < state.history.length - 1) {
    playHistoryEntry(state.historyIndex + 1);
    return;
  }

  const video = pickRandomVideo();
  if (!video) {
    el.status.textContent = 'No videos available to play.';
    stopTv();
    return;
  }

  // start/clipSeconds are filled in once metadata loads, so Previous can later replay this exact clip.
  state.history.push({ video, start: undefined, clipSeconds: undefined });
  playHistoryEntry(state.history.length - 1);
}

function goToPreviousClip() {
  if (!state.active) {
    return;
  }

  if (state.historyIndex <= 0) {
    el.status.textContent = 'Already at the first clip.';
    return;
  }

  playHistoryEntry(state.historyIndex - 1);
}

function startTv() {
  const pool = buildPool();
  if (!pool.length) {
    el.status.textContent = 'Select at least one playlist with videos.';
    return;
  }

  state.pool = pool;
  state.active = true;
  state.history = [];
  state.historyIndex = -1;
  el.startBtn.disabled = true;
  el.stopBtn.disabled = false;
  el.prevBtn.disabled = false;
  el.nextBtn.disabled = false;
  el.status.textContent = `TV started with ${pool.length} video(s) in rotation, ${getClipSeconds()}s clips.`;
  advanceToNextClip();
}

function stopTv() {
  state.active = false;
  state.clipEndTime = 0;
  state.history = [];
  state.historyIndex = -1;
  el.player.pause();
  el.player.removeAttribute('src');
  el.player.load();
  setNowPlaying('');
  el.startBtn.disabled = false;
  el.stopBtn.disabled = true;
  el.prevBtn.disabled = true;
  el.nextBtn.disabled = true;
  el.status.textContent = 'Stopped.';
}

el.player.addEventListener('loadedmetadata', () => {
  if (!state.active) {
    return;
  }

  const entry = state.history[state.historyIndex];
  if (!entry) {
    return;
  }

  const duration = Number.isFinite(el.player.duration) ? el.player.duration : 0;

  if (entry.start === undefined) {
    const clipSeconds = getClipSeconds();
    entry.start = duration > clipSeconds ? Math.random() * (duration - clipSeconds) : 0;
    entry.clipSeconds = clipSeconds;
  }

  state.clipEndTime = duration > 0 ? Math.min(duration, entry.start + entry.clipSeconds) : entry.start + entry.clipSeconds;

  el.player.currentTime = entry.start;
  el.player.play().catch(() => {
    el.status.textContent = 'Autoplay blocked. Press play on the player to continue TV playback.';
  });
});

el.player.addEventListener('timeupdate', () => {
  if (!state.active || !state.clipEndTime) {
    return;
  }
  if (el.player.currentTime >= state.clipEndTime - 0.15) {
    advanceToNextClip();
  }
});

el.player.addEventListener('ended', () => {
  if (state.active) {
    advanceToNextClip();
  }
});

el.player.addEventListener('error', () => {
  if (state.active) {
    advanceToNextClip();
  }
});

el.startBtn.addEventListener('click', () => {
  startTv();
});

el.stopBtn.addEventListener('click', () => {
  stopTv();
});

el.prevBtn.addEventListener('click', () => {
  goToPreviousClip();
});

el.nextBtn.addEventListener('click', () => {
  advanceToNextClip();
});

el.refreshBtn.addEventListener('click', () => {
  loadSources().catch((err) => {
    el.status.textContent = err.message;
  });
});

async function loadSources() {
  await Promise.all([fetchMainVideos(), fetchFavoritesPlaylists()]);
  renderSourceList();
}

loadSources().catch((err) => {
  el.status.textContent = err.message;
});
