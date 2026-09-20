const state = {
  videos: [],
  mainVideos: [],
  playlists: [],
  currentDuration: 0
};

const el = {
  refreshBtn: document.getElementById('refreshTrimBtn'),
  trimForm: document.getElementById('trimForm'),
  singleVideoSelectGroup: document.getElementById('singleVideoSelectGroup'),
  trimVideoSelect: document.getElementById('trimVideoSelect'),
  trimTimeGrid: document.getElementById('trimTimeGrid'),
  trimStart: document.getElementById('trimStart'),
  trimEnd: document.getElementById('trimEnd'),
  trimStartLabel: document.getElementById('trimStartLabel'),
  trimEndLabel: document.getElementById('trimEndLabel'),
  trimEditMode: document.getElementById('trimEditMode'),
  extraScenes: document.getElementById('extraScenes'),
  addSceneBtn: document.getElementById('addSceneBtn'),
  trimPresets: document.getElementById('trimPresets'),
  trimSubmit: null,
  globalPlaylistGroup: document.getElementById('globalPlaylistGroup'),
  trimPlaylistSelect: document.getElementById('trimPlaylistSelect'),
  trimNewPlaylist: document.getElementById('trimNewPlaylist'),
  scene1PlaylistGroup: document.getElementById('scene1PlaylistGroup'),
  scene1PlaylistSelect: document.getElementById('scene1PlaylistSelect'),
  scene1PlaylistNew: document.getElementById('scene1PlaylistNew'),
  stitchClipsGroup: document.getElementById('stitchClipsGroup'),
  stitchClipRows: document.getElementById('stitchClipRows'),
  addStitchClipBtn: document.getElementById('addStitchClipBtn'),
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

async function fetchMainVideos() {
  const res = await fetch('/api/videos');
  if (!res.ok) {
    throw new Error('Unable to load the main playlist.');
  }

  const data = await res.json();
  state.mainVideos = data.videos || [];
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

function fillPlaylistSelect(selectEl) {
  if (!selectEl) {
    return;
  }

  const previous = selectEl.value;
  selectEl.innerHTML = '<option value="">Choose existing playlist...</option>';

  state.playlists.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.name;
    option.textContent = `${playlist.name} (${playlist.count})`;
    selectEl.appendChild(option);
  });

  if (previous && state.playlists.some((playlist) => playlist.name === previous)) {
    selectEl.value = previous;
  }
}

function populateFavoritesSelect() {
  fillPlaylistSelect(el.trimPlaylistSelect);
  fillPlaylistSelect(el.scene1PlaylistSelect);
  getSceneRows().forEach((row) => fillPlaylistSelect(row.querySelector('.scene-row-playlist-select')));
  getStitchClipRows().forEach((row) => {
    const playlistSelect = row.querySelector('.stitch-clip-playlist-select');
    const videoSelect = row.querySelector('.stitch-clip-video-select');
    fillClipPlaylistSelect(playlistSelect);
    fillClipVideoSelect(videoSelect, playlistSelect.value);
  });
}

function getClipSourceVideos(sourceValue) {
  if (sourceValue === '__main__') {
    return state.mainVideos;
  }
  const playlist = state.playlists.find((item) => item.name === sourceValue);
  return playlist ? playlist.items : [];
}

function fillClipPlaylistSelect(selectEl) {
  if (!selectEl) {
    return;
  }

  const previous = selectEl.value;
  selectEl.innerHTML = '<option value="__main__">Main Playlist</option>';

  state.playlists.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.name;
    option.textContent = `${playlist.name} (${playlist.count})`;
    selectEl.appendChild(option);
  });

  const stillValid = [...selectEl.options].some((option) => option.value === previous);
  selectEl.value = previous && stillValid ? previous : '__main__';
}

function fillClipVideoSelect(selectEl, sourceValue) {
  if (!selectEl) {
    return;
  }

  const previous = selectEl.value;
  selectEl.innerHTML = '<option value="">Choose a clip...</option>';

  getClipSourceVideos(sourceValue).forEach((video) => {
    const option = document.createElement('option');
    option.value = video.name;
    option.textContent = video.name;
    selectEl.appendChild(option);
  });

  if (previous && [...selectEl.options].some((option) => option.value === previous)) {
    selectEl.value = previous;
  }
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
  const mode = el.trimEditMode.value;
  const removing = mode === 'remove-scene';
  const separate = mode === 'keep-separate';
  const stitchClips = mode === 'stitch-clips';

  el.singleVideoSelectGroup.hidden = stitchClips;
  el.trimTimeGrid.hidden = stitchClips;
  el.trimPresets.hidden = stitchClips;
  el.extraScenes.hidden = removing || stitchClips;
  el.addSceneBtn.hidden = removing || stitchClips;
  el.stitchClipsGroup.hidden = !stitchClips;

  el.scene1PlaylistGroup.hidden = !separate;
  el.globalPlaylistGroup.hidden = separate;
  getSceneRows().forEach((row) => {
    const playlistGroup = row.querySelector('.scene-row-playlist');
    if (playlistGroup) {
      playlistGroup.hidden = !separate;
    }
  });

  el.trimSubmit.textContent = removing
    ? 'Remove scene and save'
    : separate
      ? 'Save each scene to its own playlist'
      : stitchClips
        ? 'Stitch clips and save'
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

function getStitchClipRows() {
  return Array.from(el.stitchClipRows.querySelectorAll('.stitch-clip-row'));
}

function renumberStitchClipRows() {
  const rows = getStitchClipRows();
  rows.forEach((row, index) => {
    row.querySelector('.stitch-clip-label').textContent = `Clip ${index + 1}`;
    const removeBtn = row.querySelector('.stitch-clip-remove');
    if (removeBtn) {
      removeBtn.hidden = rows.length <= 2;
    }
  });
}

function addStitchClipRow() {
  const clipNumber = getStitchClipRows().length + 1;
  const row = document.createElement('div');
  row.className = 'stitch-clip-row';
  row.innerHTML = `
    <div>
      <label class="stitch-clip-label">Clip ${clipNumber}</label>
      <select class="stitch-clip-playlist-select"></select>
    </div>
    <div>
      <label>&nbsp;</label>
      <select class="stitch-clip-video-select">
        <option value="">Choose a clip...</option>
      </select>
    </div>
    <button class="btn tiny danger stitch-clip-remove" type="button" title="Remove this clip">Remove</button>
  `;

  const playlistSelect = row.querySelector('.stitch-clip-playlist-select');
  const videoSelect = row.querySelector('.stitch-clip-video-select');
  fillClipPlaylistSelect(playlistSelect);
  fillClipVideoSelect(videoSelect, playlistSelect.value);

  playlistSelect.addEventListener('change', () => {
    fillClipVideoSelect(videoSelect, playlistSelect.value);
  });
  row.querySelector('.stitch-clip-remove').addEventListener('click', () => {
    if (getStitchClipRows().length <= 2) {
      return;
    }
    row.remove();
    renumberStitchClipRows();
  });

  el.stitchClipRows.appendChild(row);
  renumberStitchClipRows();
}

function ensureMinimumStitchClipRows() {
  while (getStitchClipRows().length < 2) {
    addStitchClipRow();
  }
}

function renumberSceneRows() {
  getSceneRows().forEach((row, index) => {
    const sceneNumber = index + 2;
    row.querySelector('.scene-row-start-label').textContent = `Scene ${sceneNumber} start`;
    row.querySelector('.scene-row-end-label').textContent = `Scene ${sceneNumber} end`;
    const playlistLabel = row.querySelector('.scene-row-playlist-label');
    if (playlistLabel) {
      playlistLabel.textContent = `Scene ${sceneNumber} playlist`;
    }
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
    <div class="scene-row-playlist" hidden>
      <label class="scene-row-playlist-label">Scene ${sceneNumber} playlist</label>
      <select class="scene-row-playlist-select">
        <option value="">Choose existing playlist...</option>
      </select>
      <input class="scene-row-playlist-new" type="text" maxlength="80" placeholder="Or new playlist name" />
    </div>
    <button class="btn tiny scene-row-remove" type="button" title="Remove this scene">Remove</button>
  `;
  fillPlaylistSelect(row.querySelector('.scene-row-playlist-select'));
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

function resolvePlaylistFromInputs(selectEl, inputEl) {
  const typed = (inputEl?.value || '').trim();
  if (typed) {
    return typed;
  }
  return selectEl?.value || '';
}

async function handleKeepSeparateSubmit(videoName) {
  const sceneDefs = [
    {
      label: 'Scene 1',
      start: el.trimStart.value,
      end: el.trimEnd.value,
      playlistName: resolvePlaylistFromInputs(el.scene1PlaylistSelect, el.scene1PlaylistNew)
    },
    ...getSceneRows().map((row, index) => ({
      label: `Scene ${index + 2}`,
      start: row.querySelector('.scene-row-start').value,
      end: row.querySelector('.scene-row-end').value,
      playlistName: resolvePlaylistFromInputs(
        row.querySelector('.scene-row-playlist-select'),
        row.querySelector('.scene-row-playlist-new')
      )
    }))
  ];

  if (sceneDefs.some((scene) => !scene.playlistName)) {
    setTrimStatus('Choose or create a favorites playlist for every scene.', 'error');
    return;
  }

  const parsedScenes = sceneDefs.map((scene) => ({
    ...scene,
    startSeconds: parseTimeString(scene.start),
    endSeconds: parseTimeString(scene.end)
  }));

  if (parsedScenes.some((scene) => scene.startSeconds === null || scene.endSeconds === null || scene.startSeconds >= scene.endSeconds)) {
    setTrimStatus('Enter valid start and end times for every scene.', 'error');
    return;
  }

  if (state.currentDuration > 0 && parsedScenes.some((scene) => scene.endSeconds > state.currentDuration)) {
    setTrimStatus(
      `All selected times must stay within the video length of ${formatTimeLabel(state.currentDuration)}.`,
      'error'
    );
    return;
  }

  let successCount = 0;
  for (let index = 0; index < parsedScenes.length; index += 1) {
    const scene = parsedScenes[index];
    setTrimStatus(`Saving ${scene.label} of ${parsedScenes.length} to "${scene.playlistName}"...`, 'neutral');

    try {
      const res = await fetch('/api/videos/trim', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          videoName,
          start: scene.start,
          end: scene.end,
          playlistName: scene.playlistName,
          mode: 'single'
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `${scene.label} failed.`);
      }
      successCount += 1;
    } catch (error) {
      setTrimStatus(
        `Saved ${successCount} of ${parsedScenes.length} scene(s). ${scene.label} failed: ${error.message}`,
        'error'
      );
      await fetchFavoritesPlaylists();
      await fetchVideos();
      return;
    }
  }

  setTrimStatus(`Saved all ${successCount} scene(s), each to its own favorites playlist.`, 'success');
  el.extraScenes.innerHTML = '';
  updateEditModeFields();
  await fetchFavoritesPlaylists();
  await fetchVideos();
  if (videoName) {
    previewSelectedVideo(videoName);
  }
}

async function handleStitchClipsSubmit() {
  const playlistName = selectedPlaylistName();

  if (!playlistName) {
    setTrimStatus('Choose or create a favorites playlist to save the stitched result to.', 'error');
    return;
  }

  const clips = getStitchClipRows().map((row) => ({
    videoName: row.querySelector('.stitch-clip-video-select').value
  }));

  if (clips.length < 2) {
    setTrimStatus('Add at least two clips to stitch together.', 'error');
    return;
  }

  if (clips.some((clip) => !clip.videoName)) {
    setTrimStatus('Choose a clip for every row.', 'error');
    return;
  }

  setTrimStatus(`Stitching ${clips.length} clip(s) together. This can take a while...`, 'neutral');
  el.trimSubmit.disabled = true;

  try {
    const res = await fetch('/api/videos/stitch-clips', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ clips, playlistName })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Stitching clips failed.');
    }

    setTrimStatus(data.message || 'Stitched clip saved to favorites successfully.', 'success');
    el.trimNewPlaylist.value = '';
    el.trimPlaylistSelect.value = '';
    await fetchFavoritesPlaylists();
    await fetchVideos();
    await fetchMainVideos();
  } catch (error) {
    setTrimStatus(error.message || 'Stitching clips failed.', 'error');
  } finally {
    el.trimSubmit.disabled = false;
  }
}

async function handleTrimSubmit(event) {
  event.preventDefault();

  if (el.trimEditMode.value === 'stitch-clips') {
    await handleStitchClipsSubmit();
    return;
  }

  const videoName = el.trimVideoSelect.value;

  if (!videoName) {
    setTrimStatus('Select a video first.', 'error');
    return;
  }

  if (el.trimEditMode.value === 'keep-separate') {
    await handleKeepSeparateSubmit(videoName);
    return;
  }

  const start = el.trimStart.value;
  const end = el.trimEnd.value;
  const playlistName = selectedPlaylistName();

  if (!playlistName) {
    setTrimStatus('Choose or create a favorites playlist.', 'error');
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
    await Promise.all([fetchVideos(), fetchMainVideos(), fetchFavoritesPlaylists()]);
    ensureMinimumStitchClipRows();
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
    await Promise.all([fetchVideos(), fetchMainVideos(), fetchFavoritesPlaylists()]);
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

el.addStitchClipBtn.addEventListener('click', addStitchClipRow);

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
