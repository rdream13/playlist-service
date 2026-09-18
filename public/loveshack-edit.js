const state = {
  videos: [],
  playlists: [],
  currentDuration: 0
};

const el = {
  refreshBtn: document.getElementById('refreshTrimBtn'),
  trimForm: document.getElementById('trimForm'),
  trimVideoSelect: document.getElementById('trimVideoSelect'),
  trimStart: document.getElementById('trimStart'),
  trimEnd: document.getElementById('trimEnd'),
  trimStartLabel: document.getElementById('trimStartLabel'),
  trimEndLabel: document.getElementById('trimEndLabel'),
  trimEditMode: document.getElementById('trimEditMode'),
  extraScenes: document.getElementById('extraScenes'),
  addSceneBtn: document.getElementById('addSceneBtn'),
  trimSubmit: null,
  trimPlaylistSelect: document.getElementById('trimPlaylistSelect'),
  trimNewPlaylist: document.getElementById('trimNewPlaylist'),
  trimPreview: document.getElementById('trimPreview'),
  trimDuration: document.getElementById('trimDuration'),
  trimStatus: document.getElementById('trimStatus'),
  trimPresetButtons: Array.from(document.querySelectorAll('.trim-preset'))
};

el.trimSubmit = el.trimForm.querySelector('button[type="submit"]');


function setTrimStatus(message, kind = 'neutral') {
  const allowed = new Set(['neutral', 'success', 'error']);
  const level = allowed.has(kind) ? kind : 'neutral';
  el.trimStatus.textContent = message;
  el.trimStatus.classList.remove('success', 'error', 'neutral');
  el.trimStatus.classList.add(level);
}

function formatTimeLabel(totalSeconds) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function parseTimeString(value) {
  const raw = (value || '').trim();
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

async function fetchVideos() {
  const res = await fetch('/api/videos/all');
  if (!res.ok) {
    throw new Error('Unable to load videos.');
  }

  const data = await res.json();
  state.videos = data.videos || [];
  populateVideoSelect();
}

async function fetchFavoritesPlaylists() {
  const res = await fetch('/api/favorites/playlists');
  if (!res.ok) {
    throw new Error('Unable to load favorites playlists.');
  }

  const data = await res.json();
  state.playlists = data.playlists || [];
  populateFavoritesSelect();
}

function populateVideoSelect() {
  const selected = el.trimVideoSelect.value || getSelectedVideoFromQuery();
  el.trimVideoSelect.innerHTML = '<option value="">Choose a video...</option>';

  state.videos.forEach((video) => {
    const option = document.createElement('option');
    option.value = video.name;
    option.textContent = video.name;
    el.trimVideoSelect.appendChild(option);
  });

  if (selected && state.videos.some((video) => video.name === selected)) {
    el.trimVideoSelect.value = selected;
  }
}

function getSelectedVideoFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('video');
  return name && name.trim() ? name.trim() : '';
}

function populateFavoritesSelect() {
  el.trimPlaylistSelect.innerHTML = '<option value="">Choose existing playlist...</option>';

  state.playlists.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.name;
    option.textContent = `${playlist.name} (${playlist.count})`;
    el.trimPlaylistSelect.appendChild(option);
  });
}

function updateTrimRangeStatus() {
  const start = parseTimeString(el.trimStart.value);
  const end = parseTimeString(el.trimEnd.value);

  if (start === null || end === null || end <= start) {
    setTrimStatus(
      state.currentDuration
        ? `Duration: ${formatTimeLabel(state.currentDuration)}. Pick a valid range.`
        : 'Choose a video and set a valid time range.',
      'error'
    );
    return;
  }

  const rangeSeconds = end - start;
  setTrimStatus(
    `Trim range: ${formatTimeLabel(start)} to ${formatTimeLabel(end)} (${formatTimeLabel(rangeSeconds)} long).`,
    'neutral'
  );
}

function updateEditModeFields() {
  const removing = el.trimEditMode.value === 'remove-scene';
  el.extraScenes.hidden = removing;
  el.addSceneBtn.hidden = removing;
  el.trimSubmit.textContent = removing
    ? 'Remove scene and save'
    : getSceneRows().length > 1
      ? 'Stitch scenes and save'
      : 'Save trimmed clip';
  el.trimStartLabel.textContent = removing ? 'Scene to remove start' : 'Scene 1 start';
  el.trimEndLabel.textContent = removing ? 'Scene to remove end' : 'Scene 1 end';
  updateTrimRangeStatus();
}

function getSceneRows() {
  return Array.from(el.extraScenes.querySelectorAll('.scene-row'));
}

function renumberSceneRows() {
  getSceneRows().forEach((row, index) => {
    const sceneNumber = index + 2;
    row.querySelector('.scene-row-start-label').textContent = `Scene ${sceneNumber} start`;
    row.querySelector('.scene-row-end-label').textContent = `Scene ${sceneNumber} end`;
  });
}

function addSceneRow() {
  const sceneNumber = getSceneRows().length + 2;
  const row = document.createElement('div');
  row.className = 'scene-row';
  row.innerHTML = `
    <div>
      <label class="scene-row-start-label">Scene ${sceneNumber} start</label>
      <input class="scene-row-start" type="text" placeholder="00:01:00" />
    </div>
    <div>
      <label class="scene-row-end-label">Scene ${sceneNumber} end</label>
      <input class="scene-row-end" type="text" placeholder="00:02:00" />
    </div>
    <button class="btn tiny scene-row-remove" type="button" title="Remove this scene">Remove</button>
  `;
  row.querySelector('.scene-row-remove').addEventListener('click', () => {
    row.remove();
    renumberSceneRows();
    updateEditModeFields();
  });
  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', updateTrimRangeStatus);
  });
  el.extraScenes.appendChild(row);
  updateEditModeFields();
}

function parseSceneRange(startInput, endInput) {
  const start = parseTimeString(startInput);
  const end = parseTimeString(endInput);
  if (start === null || end === null || start >= end) {
    return null;
  }
  return { start, end };
}

function collectSceneRanges() {
  const first = parseSceneRange(el.trimStart.value, el.trimEnd.value);
  const extras = getSceneRows().map((row) =>
    parseSceneRange(row.querySelector('.scene-row-start').value, row.querySelector('.scene-row-end').value)
  );
  return [first, ...extras];
}


function previewSelectedVideo(videoName) {
  const video = state.videos.find((item) => item.name === videoName);

  if (!video) {
    el.trimPreview.removeAttribute('src');
    state.currentDuration = 0;
    el.trimDuration.textContent = 'Duration: --:--:--';
    return;
  }

  el.trimPreview.src = video.url;
  el.trimPreview.load();
  el.trimDuration.textContent = 'Duration: loading...';

  el.trimPreview.onloadedmetadata = () => {
    state.currentDuration = Number.isFinite(el.trimPreview.duration) ? el.trimPreview.duration : 0;
    const defaultEnd = state.currentDuration > 0 ? state.currentDuration : 30;
    el.trimEnd.value = formatTimeLabel(defaultEnd);
    el.trimStart.value = '00:00:00';
    el.trimDuration.textContent = `Duration: ${formatTimeLabel(state.currentDuration)}`;
    updateTrimRangeStatus();
  };
}

function selectedPlaylistName() {
  const typed = (el.trimNewPlaylist.value || '').trim();
  if (typed) {
    return typed;
  }

  const chosen = el.trimPlaylistSelect.value;
  return chosen || '';
}

async function handleTrimSubmit(event) {
  event.preventDefault();

  const videoName = el.trimVideoSelect.value;
  const start = el.trimStart.value;
  const end = el.trimEnd.value;
  const playlistName = selectedPlaylistName();

  if (!videoName || !playlistName) {
    setTrimStatus('Select a video and choose or create a favorites playlist.', 'error');
    return;
  }

  const startSeconds = parseTimeString(start);
  const endSeconds = parseTimeString(end);

  if (startSeconds === null || endSeconds === null) {
    setTrimStatus('Use valid times like 00:00:15 or 00:01:30.', 'error');
    return;
  }

  if (startSeconds >= endSeconds) {
    setTrimStatus('End time must be after the start time.', 'error');
    return;
  }

  if (startSeconds < 0 || endSeconds > state.currentDuration && state.currentDuration > 0) {
    setTrimStatus(
      `Trim range must stay within the video length of ${formatTimeLabel(state.currentDuration)}.`,
      'error'
    );
    return;
  }

  const mode = el.trimEditMode.value;
  const removing = mode === 'remove-scene';
  let segments = null;
  let effectiveMode = mode;
  if (!removing) {
    const candidateSegments = collectSceneRanges();
    if (candidateSegments.some((segment) => !segment)) {
      setTrimStatus('Enter valid start and end times for every scene.', 'error');
      return;
    }
    candidateSegments.sort((a, b) => a.start - b.start);
    if (candidateSegments.some((segment, index) => index > 0 && segment.start < candidateSegments[index - 1].end)) {
      setTrimStatus('Scene ranges must not overlap.', 'error');
      return;
    }
    if (state.currentDuration > 0 && candidateSegments.some((segment) => segment.end > state.currentDuration)) {
      setTrimStatus(
        `All selected times must stay within the video length of ${formatTimeLabel(state.currentDuration)}.`,
        'error'
      );
      return;
    }
    if (candidateSegments.length > 1) {
      segments = candidateSegments;
      effectiveMode = 'keep-scenes';
    } else {
      effectiveMode = 'single';
    }
  } else {
    segments = [parseSceneRange(start, end)];
    if (!segments[0]) {
      setTrimStatus('Enter the exact start and end times of the scene to remove.', 'error');
      return;
    }
  }

  try {
    const res = await fetch('/api/videos/trim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ videoName, start, end, playlistName, mode: effectiveMode, segments })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Trim failed.');
    }

    setTrimStatus(data.message || 'Trim saved to favorites successfully.', 'success');
    el.trimNewPlaylist.value = '';
    el.trimPlaylistSelect.value = '';
    el.extraScenes.innerHTML = '';
    updateEditModeFields();
    await fetchFavoritesPlaylists();
    await fetchVideos();
    if (videoName) {
      previewSelectedVideo(videoName);
    }
  } catch (error) {
    setTrimStatus(error.message || 'Trim failed.', 'error');
  }
}

async function init() {
  try {
    await Promise.all([fetchVideos(), fetchFavoritesPlaylists()]);
    const preferredVideo = getSelectedVideoFromQuery();
    const selectedVideo = state.videos.some((video) => video.name === preferredVideo)
      ? preferredVideo
      : state.videos[0]?.name || '';

    if (selectedVideo) {
      el.trimVideoSelect.value = selectedVideo;
      previewSelectedVideo(selectedVideo);
    }
  } catch (error) {
    setTrimStatus(error.message || 'Could not load the trim page.', 'error');
  }
}

el.refreshBtn.addEventListener('click', async () => {
  setTrimStatus('Refreshing videos and favorites...', 'neutral');
  try {
    await Promise.all([fetchVideos(), fetchFavoritesPlaylists()]);
    const preferredVideo = getSelectedVideoFromQuery();
    const selectedName = state.videos.some((video) => video.name === preferredVideo)
      ? preferredVideo
      : el.trimVideoSelect.value || (state.videos[0] && state.videos[0].name) || '';

    if (selectedName) {
      el.trimVideoSelect.value = selectedName;
      previewSelectedVideo(selectedName);
    }
    setTrimStatus('Ready.', 'neutral');
  } catch (error) {
    setTrimStatus(error.message || 'Refresh failed.', 'error');
  }
});

el.trimVideoSelect.addEventListener('change', (event) => {
  previewSelectedVideo(event.target.value);
});

el.trimEditMode.addEventListener('change', updateEditModeFields);

el.addSceneBtn.addEventListener('click', addSceneRow);

el.trimPresetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const videoName = el.trimVideoSelect.value;
    if (!videoName) {
      el.trimStatus.textContent = 'Choose a video before using a preset.';
      return;
    }

    const duration = state.currentDuration || 0;
    const presetSeconds = button.dataset.seconds;

    const start = 0;
    const end = presetSeconds === 'full' ? duration || 30 : Number(presetSeconds);

    if (!duration && presetSeconds !== 'full') {
      el.trimStatus.textContent = 'Video duration is still loading. Please wait a moment.';
      return;
    }

    if (presetSeconds === 'full') {
      el.trimStart.value = '00:00:00';
      el.trimEnd.value = formatTimeLabel(duration || 30);
    } else {
      const cappedEnd = Math.min(end, duration || end);
      el.trimStart.value = formatTimeLabel(start);
      el.trimEnd.value = formatTimeLabel(cappedEnd);
    }

    updateTrimRangeStatus();
  });
});

el.trimStart.addEventListener('input', () => {
  const start = parseTimeString(el.trimStart.value);
  const duration = state.currentDuration || 0;

  if (start !== null && duration > 0 && start > duration) {
    el.trimStart.value = formatTimeLabel(duration);
  }

  updateTrimRangeStatus();
});

el.trimEnd.addEventListener('input', () => {
  const end = parseTimeString(el.trimEnd.value);
  const duration = state.currentDuration || 0;

  if (end !== null && duration > 0 && end > duration) {
    el.trimEnd.value = formatTimeLabel(duration);
  }

  updateTrimRangeStatus();
});

el.trimForm.addEventListener('submit', handleTrimSubmit);

init();
updateEditModeFields();
