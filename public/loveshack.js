const state = {
  videos: [],
  playQueue: [],
  playingIndex: -1,
  playAllActive: false,
  currentVideoName: '',
  downloadJobs: new Map(),
  dismissedDownloadJobIds: new Set(),
  downloadPollInterval: null,
  favoritesPlaylists: [],
  selectedFavoriteVideo: ''
};

const el = {
  list: document.getElementById('videoList'),
  player: document.getElementById('player'),
  title: document.getElementById('nowPlayingTitle'),
  status: document.getElementById('statusText'),
  refreshBtn: document.getElementById('refreshBtn'),
  playAllBtn: document.getElementById('playAllBtn'),
  playlistPlayAllBtn: document.getElementById('playlistPlayAllBtn'),
  stopBtn: document.getElementById('stopBtn'),
  prevVideoBtn: document.getElementById('prevVideoBtn'),
  nextVideoBtn: document.getElementById('nextVideoBtn'),
  uploadForm: document.getElementById('uploadForm'),
  videoInput: document.getElementById('videoInput'),
  downloadForm: document.getElementById('downloadForm'),
  downloadUrl: document.getElementById('downloadUrl'),
  cookiesFile: document.getElementById('cookiesFile'),
  ytDlpPath: document.getElementById('ytDlpPath'),
  cookiesFromBrowser: document.getElementById('cookiesFromBrowser'),
  downloadPlaylist: document.getElementById('downloadPlaylist'),
  downloadBtn: document.getElementById('downloadBtn'),
  downloaderStatus: document.getElementById('downloaderStatus'),
  downloadStatusPanel: document.getElementById('downloadStatus'),
  downloadJobsList: document.getElementById('downloadJobsList'),
  favoriteDialog: document.getElementById('favoriteDialog'),
  favoriteForm: document.getElementById('favoriteForm'),
  favoriteVideoName: document.getElementById('favoriteVideoName'),
  favoritePlaylistSelect: document.getElementById('favoritePlaylistSelect'),
  favoriteNewPlaylist: document.getElementById('favoriteNewPlaylist'),
  favoriteMessage: document.getElementById('favoriteMessage'),
  favoriteCancelBtn: document.getElementById('favoriteCancelBtn'),
  tpl: document.getElementById('videoItemTemplate')
};

async function fetchFavoritesPlaylists() {
  const res = await fetch('/api/favorites/playlists');
  if (!res.ok) {
    throw new Error('Failed to fetch favorites playlists.');
  }
  const data = await res.json();
  state.favoritesPlaylists = data.playlists || [];
}

function populateFavoritesSelect() {
  if (!el.favoritePlaylistSelect) {
    return;
  }

  el.favoritePlaylistSelect.innerHTML = '<option value="">Choose existing playlist...</option>';

  state.favoritesPlaylists.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.name;
    option.textContent = `${playlist.name} (${playlist.count})`;
    el.favoritePlaylistSelect.appendChild(option);
  });
}

async function openFavoriteDialog(videoName) {
  state.selectedFavoriteVideo = videoName;
  el.favoriteVideoName.textContent = videoName;
  el.favoriteMessage.textContent = '';
  el.favoriteNewPlaylist.value = '';

  try {
    await fetchFavoritesPlaylists();
    populateFavoritesSelect();
  } catch {
    el.favoriteMessage.textContent = 'Could not load existing playlists. You can still create a new one.';
  }

  if (typeof el.favoriteDialog.showModal === 'function') {
    el.favoriteDialog.showModal();
  }
}

function closeFavoriteDialog() {
  if (el.favoriteDialog.open) {
    el.favoriteDialog.close();
  }
  el.favoriteMessage.textContent = '';
}

async function addVideoToFavorites(videoName, playlistName) {
  const res = await fetch('/api/favorites/add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ videoName, playlistName })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to add video to favorites playlist.');
  }

  state.favoritesPlaylists = data.playlists || state.favoritesPlaylists;
}

async function fetchVideos() {
  const res = await fetch('/api/videos');
  if (!res.ok) {
    throw new Error('Failed to fetch videos.');
  }
  const data = await res.json();
  state.videos = data.videos || [];
  renderList();
  el.status.textContent = `${state.videos.length} video(s) loaded (sorted by download date).`;
}

function setNowPlaying(video) {
  state.currentVideoName = video ? video.name : '';
  el.title.textContent = `Now Playing: ${video ? video.name : 'none'}`;
}

function skipInMainPlaylist(direction) {
  const usingPlayAllQueue = state.playAllActive && state.playQueue.length > 0;
  const queue = usingPlayAllQueue ? state.playQueue : state.videos;

  if (!queue.length) {
    el.status.textContent = 'No videos available in playlist.';
    return;
  }

  let currentIndex = queue.findIndex((video) => video.name === state.currentVideoName);
  if (currentIndex === -1) {
    currentIndex = direction === 'next' ? -1 : queue.length;
  }

  const nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= queue.length) {
    el.status.textContent = direction === 'next'
      ? 'Already at the last video.'
      : 'Already at the first video.';
    return;
  }

  if (usingPlayAllQueue) {
    state.playingIndex = nextIndex;
  }

  playVideo(queue[nextIndex]);
  el.status.textContent = direction === 'next' ? 'Skipped to next video.' : 'Skipped to previous video.';
}

function renderList() {
  el.list.innerHTML = '';

  if (!state.videos.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No videos found in the folder.';
    el.list.appendChild(empty);
    return;
  }

  state.videos.forEach((video) => {
    const node = el.tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.name').textContent = video.name;
    const moveUpBtn = node.querySelector('.move-up');
    const moveDownBtn = node.querySelector('.move-down');

    moveUpBtn.disabled = true;
    moveDownBtn.disabled = true;
    moveUpBtn.title = 'Auto-sorted by download date';
    moveDownBtn.title = 'Auto-sorted by download date';

    moveUpBtn.addEventListener('click', async () => {
      try {
        await moveVideo(video.name, 'up');
      } catch (err) {
        el.status.textContent = err.message;
      }
    });

    moveDownBtn.addEventListener('click', async () => {
      try {
        await moveVideo(video.name, 'down');
      } catch (err) {
        el.status.textContent = err.message;
      }
    });

    node.querySelector('.play-one').addEventListener('click', () => {
      state.playAllActive = false;
      playVideoByName(video.name);
    });

    node.querySelector('.favorite').addEventListener('click', () => {
      openFavoriteDialog(video.name).catch((err) => {
        el.status.textContent = err.message;
      });
    });

    node.querySelector('.delete').addEventListener('click', async () => {
      if (!confirm(`Delete ${video.name}?`)) {
        return;
      }
      await deleteVideo(video.name);
    });

    node.querySelector('.rename').addEventListener('click', async () => {
      const newName = prompt('Rename file to:', video.name);
      if (!newName || newName === video.name) {
        return;
      }
      await renameVideo(video.name, newName);
    });

    el.list.appendChild(node);
  });
}

function playVideo(video) {
  if (!video) {
    return;
  }
  el.player.src = video.url;
  setNowPlaying(video);
  el.player.play().catch(() => {
    el.status.textContent = 'Autoplay blocked by browser. Press play on the player.';
  });
}

function playVideoByName(name) {
  const video = state.videos.find((v) => v.name === name);
  if (!video) {
    el.status.textContent = 'Video not found.';
    return;
  }
  playVideo(video);
}

function startPlayAll() {
  if (!state.videos.length) {
    el.status.textContent = 'No videos to play.';
    return;
  }

  state.playQueue = [...state.videos];
  state.playingIndex = 0;
  state.playAllActive = true;
  el.status.textContent = 'Play All started.';
  playVideo(state.playQueue[state.playingIndex]);
}

function stopPlayback() {
  state.playAllActive = false;
  state.playQueue = [];
  state.playingIndex = -1;
  el.player.pause();
  el.player.removeAttribute('src');
  el.player.load();
  setNowPlaying(null);
  el.status.textContent = 'Playback stopped.';
}

el.player.addEventListener('ended', () => {
  if (!state.playAllActive) {
    return;
  }

  state.playingIndex += 1;
  if (state.playingIndex >= state.playQueue.length) {
    state.playAllActive = false;
    state.playingIndex = -1;
    el.status.textContent = 'Play All finished.';
    setNowPlaying(null);
    return;
  }

  playVideo(state.playQueue[state.playingIndex]);
});

async function uploadVideo(file) {
  const fd = new FormData();
  fd.append('video', file);

  const res = await fetch('/api/videos/upload', {
    method: 'POST',
    body: fd
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Upload failed.');
  }

  await fetchVideos();
  el.status.textContent = 'Upload complete.';
}

async function deleteVideo(name) {
  const res = await fetch(`/api/videos/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Delete failed.');
  }

  await fetchVideos();
  el.status.textContent = data.message || `${name} deleted.`;
}

async function renameVideo(oldName, newName) {
  const res = await fetch('/api/videos/rename', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ oldName, newName })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Rename failed.');
  }

  await fetchVideos();
  el.status.textContent = `${oldName} renamed to ${newName}.`;
}

async function moveVideo(name, direction) {
  const res = await fetch('/api/videos/move', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, direction })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Move failed.');
  }

  await fetchVideos();
}

async function pollDownloadJob(jobId) {
  const res = await fetch(`/api/videos/download-jobs/${jobId}`);
  if (!res.ok) {
    throw new Error('Failed to fetch job status.');
  }
  const job = await res.json();
  return job;
}

async function fetchDownloadJobs() {
  const res = await fetch('/api/videos/download-jobs');
  if (!res.ok) {
    throw new Error('Failed to fetch download jobs.');
  }
  return res.json();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderDownloadJobsUI() {
  const jobs = [...state.downloadJobs.values()].sort((a, b) => b.startTime - a.startTime);

  if (!jobs.length) {
    el.downloadStatusPanel.style.display = 'none';
    el.downloadJobsList.innerHTML = '';
    return;
  }

  el.downloadStatusPanel.style.display = 'block';
  el.downloadJobsList.innerHTML = jobs
    .map((job) => {
      const percent = Number.isFinite(job.progressPercent) ? job.progressPercent : 0;
      const statusLine = `Status: ${job.status} | ${percent.toFixed(0)}% | Elapsed: ${job.elapsedSeconds}s`;
      const title = job.url || `Job ${job.id}`;
      return `
        <article class="download-job">
          <div class="download-job-head">
            <p class="download-job-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p>
            <span class="download-job-meta">${escapeHtml(job.id)}</span>
          </div>
          <div class="download-progress-track">
            <div class="download-progress-fill" style="width:${Math.max(0, Math.min(100, percent))}%"></div>
          </div>
          <p class="download-job-status">${escapeHtml(statusLine)}</p>
        </article>
      `;
    })
    .join('');
}

async function downloadFromUrl(payload) {

  const res = await fetch('/api/videos/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.hint || 'URL download failed.');
  }

  return data;
}

async function refreshDownloadJobs() {
  const payload = await fetchDownloadJobs();
  const jobs = (payload.jobs || []).filter((job) => !state.dismissedDownloadJobIds.has(job.id));
  const previous = new Map(state.downloadJobs);
  const activeIds = new Set(jobs.map((job) => job.id));

  state.downloadJobs.clear();
  jobs.forEach((job) => {
    state.downloadJobs.set(job.id, job);
  });

  for (const jobId of previous.keys()) {
    if (!activeIds.has(jobId)) {
      state.downloadJobs.delete(jobId);
      state.dismissedDownloadJobIds.add(jobId);
    }
  }

  renderDownloadJobsUI();

  const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'downloading');
  if (!hasActive && state.downloadPollInterval) {
    clearInterval(state.downloadPollInterval);
    state.downloadPollInterval = null;
  }

  const newlyCompleted = jobs.filter((job) => {
    const prev = previous.get(job.id);
    return prev && prev.status !== 'completed' && job.status === 'completed';
  });

  if (newlyCompleted.length) {
    await fetchVideos();
    el.status.textContent = `${newlyCompleted.length} download(s) completed.`;

    // Hide completed jobs immediately so stale cards do not linger.
    newlyCompleted.forEach((job) => {
      state.dismissedDownloadJobIds.add(job.id);
      state.downloadJobs.delete(job.id);
    });

    renderDownloadJobsUI();
  }
}

function ensureDownloadPolling() {
  if (state.downloadPollInterval) {
    return;
  }

  state.downloadPollInterval = setInterval(() => {
    refreshDownloadJobs().catch(() => {
      // Keep polling; transient failures can happen.
    });
  }, 700);
}

async function fetchDownloaderStatus() {
  const res = await fetch('/api/videos/downloader-status');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data) {
    el.downloaderStatus.textContent = 'Downloader status check failed.';
    return;
  }

  if (data.ok) {
    el.downloaderStatus.textContent = `Downloader ready: ${data.downloader} ${data.version}`;
    return;
  }

  el.downloaderStatus.textContent = data.error || 'Downloader not configured.';
}

el.refreshBtn.addEventListener('click', () => {
  fetchVideos().catch((err) => {
    el.status.textContent = err.message;
  });
});

el.playAllBtn.addEventListener('click', () => {
  startPlayAll();
});

if (el.playlistPlayAllBtn) {
  el.playlistPlayAllBtn.addEventListener('click', () => {
    startPlayAll();
  });
}

el.stopBtn.addEventListener('click', () => {
  stopPlayback();
});

if (el.prevVideoBtn) {
  el.prevVideoBtn.addEventListener('click', () => {
    skipInMainPlaylist('previous');
  });
}

if (el.nextVideoBtn) {
  el.nextVideoBtn.addEventListener('click', () => {
    skipInMainPlaylist('next');
  });
}

el.uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = el.videoInput.files?.[0];
  if (!file) {
    el.status.textContent = 'Choose a video first.';
    return;
  }

  try {
    await uploadVideo(file);
    el.uploadForm.reset();
  } catch (err) {
    el.status.textContent = err.message;
  }
});

el.downloadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = el.downloadUrl.value.trim();
  if (!url) {
    el.status.textContent = 'Enter a URL first.';
    return;
  }

  const cookiesFile = el.cookiesFile.value;
  const ytDlpPath = el.ytDlpPath.value;
  const cookiesFromBrowser = el.cookiesFromBrowser.value;
  const downloadPlaylist = el.downloadPlaylist.checked;

  // Clear URL immediately so user can submit the next one without waiting.
  el.downloadUrl.value = '';
  el.downloadUrl.focus();
  el.status.textContent = 'Download queued.';

  try {
    const data = await downloadFromUrl({
      url,
      cookiesFile,
      ytDlpPath,
      cookiesFromBrowser,
      downloadPlaylist
    });

    // Keep options intact for next submit, only clear URL field immediately.
    state.downloadJobs.set(data.jobId, {
      id: data.jobId,
      url,
      status: 'queued',
      elapsedSeconds: 0,
      progressPercent: 0,
      logs: [],
      startTime: Date.now()
    });
    renderDownloadJobsUI();
    ensureDownloadPolling();
    refreshDownloadJobs().catch(() => {
      // best-effort immediate sync
    });
  } catch (err) {
    el.status.textContent = err.message;
  }
});

if (el.favoriteCancelBtn) {
  el.favoriteCancelBtn.addEventListener('click', () => {
    closeFavoriteDialog();
  });
}

if (el.favoriteForm) {
  el.favoriteForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const newPlaylist = (el.favoriteNewPlaylist.value || '').trim();
    const selectedExisting = el.favoritePlaylistSelect.value;
    const playlistName = newPlaylist || selectedExisting;

    if (!playlistName) {
      el.favoriteMessage.textContent = 'Pick an existing playlist or enter a new one.';
      return;
    }

    try {
      await addVideoToFavorites(state.selectedFavoriteVideo, playlistName);
      closeFavoriteDialog();
      el.status.textContent = `Added ${state.selectedFavoriteVideo} to ${playlistName}.`;
    } catch (err) {
      el.favoriteMessage.textContent = err.message;
    }
  });
}

fetchVideos().catch((err) => {
  el.status.textContent = err.message;
});

fetchFavoritesPlaylists()
  .then(() => {
    populateFavoritesSelect();
  })
  .catch(() => {
    // Ignore initial load errors because playlist creation can still proceed.
  });

fetchDownloaderStatus().catch(() => {
  el.downloaderStatus.textContent = 'Downloader status check failed.';
});

refreshDownloadJobs()
  .then(() => {
    ensureDownloadPolling();
  })
  .catch(() => {
    // Ignore if no jobs endpoint is temporarily unavailable.
  });
