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
  sceneSliders: document.getElementById('sceneSliders'),
  trimDuration: document.getElementById('trimDuration'),
  trimStatus: document.getElementById('trimStatus'),
  trimPresetButtons: Array.from(document.querySelectorAll('.trim-preset')),
  clipCategory: document.getElementById('clipCategory'),
  clipCategoryOptions: document.getElementById('clipCategoryOptions'),
  clipPeople: document.getElementById('clipPeople'),
  clipKeywords: document.getElementById('clipKeywords'),
  clipMetadataGroup: document.getElementById('clipMetadataGroup'),
  scene1MetadataGroup: document.getElementById('scene1MetadataGroup'),
  scene1Category: document.getElementById('scene1Category'),
  scene1People: document.getElementById('scene1People'),
  scene1Keywords: document.getElementById('scene1Keywords'),
  scene1GroupField: document.getElementById('scene1GroupField'),
  scene1Group: document.getElementById('scene1Group'),
  groupOrderSummary: document.getElementById('groupOrderSummary'),
  groupSaveOptions: document.getElementById('groupSaveOptions'),
  splitByGroup: document.getElementById('splitByGroup'),
  groupPlaylistRows: document.getElementById('groupPlaylistRows')
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

async function fetchLibraryCategories() {
  const res = await fetch('/api/library/tags');
  if (!res.ok) {
    return;
  }
  const data = await res.json();
  el.clipCategoryOptions.innerHTML = '';
  (data.categories || []).forEach((label) => {
    const option = document.createElement('option');
    option.value = label;
    el.clipCategoryOptions.appendChild(option);
  });
}

function splitCommaList(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectClipMetadata() {
  return {
    category: el.clipCategory.value.trim() || null,
    people: splitCommaList(el.clipPeople.value),
    keywords: splitCommaList(el.clipKeywords.value)
  };
}

function collectMetadataFromFields(categoryEl, peopleEl, keywordsEl) {
  return {
    category: (categoryEl?.value || '').trim() || null,
    people: splitCommaList(peopleEl?.value),
    keywords: splitCommaList(keywordsEl?.value)
  };
}

function clearClipMetadataFields() {
  el.clipCategory.value = '';
  el.clipPeople.value = '';
  el.clipKeywords.value = '';
  el.scene1Category.value = '';
  el.scene1People.value = '';
  el.scene1Keywords.value = '';
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
  el.groupPlaylistRows.querySelectorAll('select').forEach(fillPlaylistSelect);
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

const SLIDER_MIN_GAP = 1;
const SLIDER_THUMB_PX = 16;

function getScenePairs() {
  return [
    { startInput: el.trimStart, endInput: el.trimEnd },
    ...getSceneRows().map((row) => ({
      startInput: row.querySelector('.scene-row-start'),
      endInput: row.querySelector('.scene-row-end')
    }))
  ];
}

function getVisibleScenePairs() {
  const pairs = getScenePairs();
  return el.trimEditMode.value === 'remove-scene' ? pairs.slice(0, 1) : pairs;
}

function readScene(pair) {
  return {
    start: parseTimeString(pair.startInput.value),
    end: parseTimeString(pair.endInput.value)
  };
}

function clampValue(value, lo, hi) {
  return Math.min(Math.max(value, lo), Math.max(hi, lo));
}

// Scenes stay in order: a scene can't start before the previous one ends or end after the next one starts.
function getSceneBounds(index) {
  const pairs = getVisibleScenePairs();
  const duration = Math.floor(state.currentDuration || 0);
  let lower = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const { end } = readScene(pairs[i]);
    if (end !== null) {
      lower = end;
      break;
    }
  }
  let upper = duration;
  for (let i = index + 1; i < pairs.length; i += 1) {
    const { start } = readScene(pairs[i]);
    if (start !== null) {
      upper = start;
      break;
    }
  }
  lower = Math.min(lower, duration);
  return { lower, upper: Math.max(upper, lower) };
}

function setSceneTime(index, which, rawValue) {
  const pair = getVisibleScenePairs()[index];
  if (!pair) {
    return 0;
  }

  const { lower, upper } = getSceneBounds(index);
  const current = readScene(pair);
  const value = Math.round(rawValue);
  let start = current.start;
  let end = current.end;

  if (which === 'start') {
    end = end === null ? upper : end;
    start = clampValue(value, lower, end - SLIDER_MIN_GAP);
    end = Math.max(end, start);
  } else {
    start = start === null ? lower : start;
    end = clampValue(value, start + SLIDER_MIN_GAP, upper);
  }

  pair.startInput.value = formatTimeLabel(start);
  pair.endInput.value = formatTimeLabel(end);
  updateTrimRangeStatus();
  return which === 'start' ? start : end;
}

function seekPreview(seconds) {
  if (state.currentDuration > 0) {
    el.trimPreview.currentTime = seconds;
  }
}

function createSceneSlider() {
  const slider = document.createElement('div');
  slider.className = 'scene-slider';
  slider.innerHTML = `
    <div class="scene-slider-head">
      <span class="scene-slider-label"></span>
      <span class="scene-slider-readout"></span>
    </div>
    <div class="scene-slider-track">
      <div class="scene-slider-fill"></div>
      <div class="scene-slider-playhead" hidden></div>
      <input class="scene-slider-start" type="range" min="0" step="1" value="0" aria-label="Scene start" />
      <input class="scene-slider-end" type="range" min="0" step="1" value="0" aria-label="Scene end" />
    </div>
    <div class="scene-slider-actions">
      <button class="btn tiny scene-slider-set-start" type="button">Start = now</button>
      <button class="btn tiny scene-slider-set-end" type="button">End = now</button>
    </div>
  `;

  const indexOfSlider = () => Array.from(el.sceneSliders.children).indexOf(slider);

  slider.querySelector('.scene-slider-start').addEventListener('input', (event) => {
    seekPreview(setSceneTime(indexOfSlider(), 'start', Number(event.target.value)));
  });
  slider.querySelector('.scene-slider-end').addEventListener('input', (event) => {
    seekPreview(setSceneTime(indexOfSlider(), 'end', Number(event.target.value)));
  });
  slider.querySelector('.scene-slider-set-start').addEventListener('click', () => {
    setSceneTime(indexOfSlider(), 'start', el.trimPreview.currentTime);
  });
  slider.querySelector('.scene-slider-set-end').addEventListener('click', () => {
    setSceneTime(indexOfSlider(), 'end', el.trimPreview.currentTime);
  });

  return slider;
}

function sliderPosition(seconds, max) {
  const percent = max > 0 ? (seconds / max) * 100 : 0;
  return `calc(${percent}% + ${(0.5 - percent / 100) * SLIDER_THUMB_PX}px)`;
}

function renderSceneSliders() {
  const pairs = getVisibleScenePairs();
  const stitchClips = el.trimEditMode.value === 'stitch-clips';
  const removing = el.trimEditMode.value === 'remove-scene';
  const duration = Math.floor(state.currentDuration || 0);

  el.sceneSliders.hidden = stitchClips;

  while (el.sceneSliders.children.length > pairs.length) {
    el.sceneSliders.lastElementChild.remove();
  }
  while (el.sceneSliders.children.length < pairs.length) {
    el.sceneSliders.appendChild(createSceneSlider());
  }

  pairs.forEach((pair, index) => {
    const slider = el.sceneSliders.children[index];
    const { lower } = getSceneBounds(index);
    const parsed = readScene(pair);
    const start = clampValue(parsed.start === null ? lower : parsed.start, 0, duration);
    const end = clampValue(parsed.end === null ? start : parsed.end, start, duration);

    const startInput = slider.querySelector('.scene-slider-start');
    const endInput = slider.querySelector('.scene-slider-end');
    [startInput, endInput].forEach((input) => {
      input.max = String(duration);
      input.disabled = duration <= 0;
    });
    startInput.value = String(start);
    endInput.value = String(end);
    // Keep whichever thumb is reachable when both sit close together.
    startInput.style.zIndex = start > duration / 2 ? '4' : '2';
    endInput.style.zIndex = '3';

    const fill = slider.querySelector('.scene-slider-fill');
    fill.style.left = sliderPosition(start, duration);
    fill.style.width = `calc(${sliderPosition(end, duration)} - ${sliderPosition(start, duration)})`;

    slider.querySelector('.scene-slider-label').textContent = removing
      ? 'Scene to remove'
      : isGroupingMode() && pairs.length > 1
        ? `Scene ${index + 1} - Group ${getGroupInputs()[index]?.value || 1}`
        : `Scene ${index + 1}`;
    slider.querySelector('.scene-slider-readout').textContent =
      parsed.start !== null && parsed.end !== null
        ? `${formatTimeLabel(parsed.start)} - ${formatTimeLabel(parsed.end)}`
        : 'not set';
    slider.querySelectorAll('button').forEach((button) => {
      button.disabled = duration <= 0;
    });
  });
  updatePlayheads();
}

// Only the slider whose scene contains the current time shows the playhead.
function updatePlayheads() {
  const time = el.trimPreview.currentTime || 0;
  const duration = Math.floor(state.currentDuration || 0);
  let activeFound = false;

  getVisibleScenePairs().forEach((pair, index) => {
    const slider = el.sceneSliders.children[index];
    if (!slider) {
      return;
    }
    const { start, end } = readScene(pair);
    const active =
      !activeFound && duration > 0 && start !== null && end !== null && time >= start && time <= end;
    activeFound = activeFound || active;

    slider.classList.toggle('is-active', active);
    const playhead = slider.querySelector('.scene-slider-playhead');
    playhead.hidden = !active;
    if (active) {
      playhead.style.left = sliderPosition(time, duration);
    }
  });
}

let playheadFrame = null;

function tickPlayheads() {
  updatePlayheads();
  playheadFrame = el.trimPreview.paused ? null : requestAnimationFrame(tickPlayheads);
}

function startPlayheadLoop() {
  if (playheadFrame === null) {
    playheadFrame = requestAnimationFrame(tickPlayheads);
  }
}

function isGroupingMode() {
  return el.trimEditMode.value === 'keep-scenes';
}

function getGroupInputs() {
  return [el.scene1Group, ...getSceneRows().map((row) => row.querySelector('.scene-row-group-input'))];
}

function readSceneGroup(input) {
  const value = Number(input?.value);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// Scene labels per group, keys ascending; scenes inside a group are in time order (same as the server).
function getGroupMembers() {
  const groupInputs = getGroupInputs();
  const scenes = getScenePairs().map((pair, index) => ({
    label: `S${index + 1}`,
    group: readSceneGroup(groupInputs[index]),
    start: readScene(pair).start ?? Number.POSITIVE_INFINITY
  }));

  if (scenes.some((scene) => scene.group === null)) {
    return null;
  }

  const byGroup = new Map();
  scenes
    .sort((a, b) => a.group - b.group || a.start - b.start)
    .forEach((scene) => {
      byGroup.set(scene.group, [...(byGroup.get(scene.group) || []), scene.label]);
    });
  return byGroup;
}

function isSplitByGroup() {
  return isGroupingMode() && el.splitByGroup.checked;
}

// Rebuilt only when the set of groups changes, carrying over what was already chosen or typed.
function renderGroupPlaylistRows(members) {
  const container = el.groupPlaylistRows;
  container.hidden = !members;
  if (!members) {
    return;
  }

  const key = [...members].map(([group, labels]) => `${group}:${labels.join(',')}`).join('|');
  if (container.dataset.key === key) {
    return;
  }

  const previous = new Map(
    Array.from(container.children).map((row) => [
      row.dataset.group,
      { selected: row.querySelector('select').value, typed: row.querySelector('input').value }
    ])
  );

  container.innerHTML = '';
  members.forEach((labels, group) => {
    const row = document.createElement('div');
    row.className = 'scene-row-playlist group-playlist-row';
    row.dataset.group = String(group);
    row.innerHTML = `
      <label class="scene-row-playlist-label">Group ${group} playlist (${labels.join(', ')})</label>
      <select>
        <option value="">Choose existing playlist...</option>
      </select>
      <input type="text" maxlength="80" placeholder="Or new playlist name" />
    `;
    const select = row.querySelector('select');
    fillPlaylistSelect(select);
    const saved = previous.get(String(group));
    if (saved) {
      select.value = saved.selected;
      row.querySelector('input').value = saved.typed;
    }
    container.appendChild(row);
  });
  container.dataset.key = key;
}

function updateGroupSummary() {
  const grouping = isGroupingMode();
  const members = grouping ? getGroupMembers() : null;

  if (!grouping || getScenePairs().length < 2) {
    el.groupOrderSummary.hidden = true;
  } else if (!members) {
    el.groupOrderSummary.textContent = 'Scene groups must be whole numbers of 1 or higher.';
    el.groupOrderSummary.hidden = false;
  } else {
    const entries = [...members];
    el.groupOrderSummary.textContent = isSplitByGroup()
      ? `Videos: ${entries.map(([group, labels]) => `Group ${group} = ${labels.join(', ')}`).join('; ')}`
      : `Order: ${entries.map(([, labels]) => labels.join(', ')).join(' \u2192 ')}`;
    el.groupOrderSummary.hidden = false;
  }

  renderGroupPlaylistRows(isSplitByGroup() ? members : null);
}

function updateTrimRangeStatus() {
  renderSceneSliders();
  updateGroupSummary();
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
  el.scene1GroupField.hidden = !isGroupingMode();
  el.groupSaveOptions.hidden = !isGroupingMode();
  el.globalPlaylistGroup.hidden = separate || isSplitByGroup();
  el.clipMetadataGroup.hidden = separate;
  el.scene1MetadataGroup.hidden = !separate;
  getSceneRows().forEach((row) => {
    const groupField = row.querySelector('.scene-row-group');
    if (groupField) {
      groupField.hidden = !isGroupingMode();
    }
    const playlistGroup = row.querySelector('.scene-row-playlist');
    if (playlistGroup) {
      playlistGroup.hidden = !separate;
    }
    const metadataGroup = row.querySelector('.scene-row-metadata');
    if (metadataGroup) {
      metadataGroup.hidden = !separate;
    }
  });

  el.trimSubmit.textContent = removing
    ? 'Remove scene and save'
    : separate
      ? 'Save each scene to its own playlist'
      : isSplitByGroup()
        ? 'Save each group to its playlist'
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
    row.querySelector('.scene-row-group-label').textContent = `Scene ${sceneNumber} group`;
    const playlistLabel = row.querySelector('.scene-row-playlist-label');
    if (playlistLabel) {
      playlistLabel.textContent = `Scene ${sceneNumber} playlist`;
    }
    const categoryLabel = row.querySelector('.scene-row-category-label');
    if (categoryLabel) {
      categoryLabel.textContent = `Scene ${sceneNumber} category (optional)`;
    }
    const peopleLabel = row.querySelector('.scene-row-people-label');
    if (peopleLabel) {
      peopleLabel.textContent = `Scene ${sceneNumber} people (optional, comma-separated)`;
    }
    const keywordsLabel = row.querySelector('.scene-row-keywords-label');
    if (keywordsLabel) {
      keywordsLabel.textContent = `Scene ${sceneNumber} keywords (optional, comma-separated)`;
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
    <div class="scene-row-group" hidden>
      <label class="scene-row-group-label">Scene ${sceneNumber} group</label>
      <input class="scene-row-group-input" type="number" min="1" step="1" value="1" />
    </div>
    <div class="scene-row-playlist" hidden>
      <label class="scene-row-playlist-label">Scene ${sceneNumber} playlist</label>
      <select class="scene-row-playlist-select">
        <option value="">Choose existing playlist...</option>
      </select>
      <input class="scene-row-playlist-new" type="text" maxlength="80" placeholder="Or new playlist name" />
    </div>
    <div class="scene-row-metadata clip-metadata-group" hidden>
      <label class="scene-row-category-label">Scene ${sceneNumber} category (optional)</label>
      <input class="scene-row-category" type="text" list="clipCategoryOptions" maxlength="80" placeholder="ex: Full Scene" />
      <label class="scene-row-people-label">Scene ${sceneNumber} people (optional, comma-separated)</label>
      <input class="scene-row-people" type="text" placeholder="ex: Emily, Jordan" />
      <label class="scene-row-keywords-label">Scene ${sceneNumber} keywords (optional, comma-separated)</label>
      <input class="scene-row-keywords" type="text" placeholder="ex: outdoor, pov" />
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

  // Seed the new scene right after the previous one when there is room.
  const previousPair = getScenePairs().pop();
  const previousEnd = parseTimeString(previousPair.endInput.value);
  const duration = Math.floor(state.currentDuration || 0);
  if (previousEnd !== null && previousEnd + SLIDER_MIN_GAP <= duration) {
    row.querySelector('.scene-row-start').value = formatTimeLabel(previousEnd);
    row.querySelector('.scene-row-end').value = formatTimeLabel(Math.min(previousEnd + 30, duration));
  }
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
  const withGroup = (range, groupInput) => (range ? { ...range, group: readSceneGroup(groupInput) } : range);
  const first = withGroup(parseSceneRange(el.trimStart.value, el.trimEnd.value), el.scene1Group);
  const extras = getSceneRows().map((row) =>
    withGroup(
      parseSceneRange(row.querySelector('.scene-row-start').value, row.querySelector('.scene-row-end').value),
      row.querySelector('.scene-row-group-input')
    )
  );
  return [first, ...extras];
}


function previewSelectedVideo(videoName) {
  const video = state.videos.find((item) => item.name === videoName);

  if (!video) {
    el.trimPreview.removeAttribute('src');
    state.currentDuration = 0;
    el.trimDuration.textContent = 'Duration: --:--:--';
    renderSceneSliders();
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
    // Extra scene times belonged to the previous video.
    getSceneRows().forEach((row) => {
      row.querySelector('.scene-row-start').value = '';
      row.querySelector('.scene-row-end').value = '';
    });
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
      playlistName: resolvePlaylistFromInputs(el.scene1PlaylistSelect, el.scene1PlaylistNew),
      metadata: collectMetadataFromFields(el.scene1Category, el.scene1People, el.scene1Keywords)
    },
    ...getSceneRows().map((row, index) => ({
      label: `Scene ${index + 2}`,
      start: row.querySelector('.scene-row-start').value,
      end: row.querySelector('.scene-row-end').value,
      playlistName: resolvePlaylistFromInputs(
        row.querySelector('.scene-row-playlist-select'),
        row.querySelector('.scene-row-playlist-new')
      ),
      metadata: collectMetadataFromFields(
        row.querySelector('.scene-row-category'),
        row.querySelector('.scene-row-people'),
        row.querySelector('.scene-row-keywords')
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
          mode: 'single',
          ...scene.metadata
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
  clearClipMetadataFields();
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
      body: JSON.stringify({ clips, playlistName, ...collectClipMetadata() })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Stitching clips failed.');
    }

    setTrimStatus(data.message || 'Stitched clip saved to favorites successfully.', 'success');
    el.trimNewPlaylist.value = '';
    el.trimPlaylistSelect.value = '';
    clearClipMetadataFields();
    await fetchFavoritesPlaylists();
    await fetchVideos();
    await fetchMainVideos();
  } catch (error) {
    setTrimStatus(error.message || 'Stitching clips failed.', 'error');
  } finally {
    el.trimSubmit.disabled = false;
  }
}

// Returns an error message, or null when the scenes are usable.
function validateSceneSet(scenes) {
  if (scenes.some((scene) => !scene)) {
    return 'Enter valid start and end times for every scene.';
  }
  if (scenes.some((scene) => scene.group === null)) {
    return 'Scene groups must be whole numbers of 1 or higher.';
  }
  const byTime = [...scenes].sort((a, b) => a.start - b.start);
  if (byTime.some((scene, index) => index > 0 && scene.start < byTime[index - 1].end)) {
    return 'Scene ranges must not overlap.';
  }
  if (state.currentDuration > 0 && byTime.some((scene) => scene.end > state.currentDuration)) {
    return `All selected times must stay within the video length of ${formatTimeLabel(state.currentDuration)}.`;
  }
  return null;
}

// One stitched video per group, each saved to that group's own playlist.
async function handleGroupedSubmit(videoName) {
  const scenes = collectSceneRanges();
  const problem = validateSceneSet(scenes);
  if (problem) {
    setTrimStatus(problem, 'error');
    return;
  }

  const byGroup = new Map();
  scenes.forEach((scene) => {
    byGroup.set(scene.group, [...(byGroup.get(scene.group) || []), scene]);
  });
  const groupNumbers = [...byGroup.keys()].sort((a, b) => a - b);

  const playlistByGroup = new Map(
    Array.from(el.groupPlaylistRows.children).map((row) => [
      Number(row.dataset.group),
      resolvePlaylistFromInputs(row.querySelector('select'), row.querySelector('input'))
    ])
  );
  if (groupNumbers.some((group) => !playlistByGroup.get(group))) {
    setTrimStatus('Choose or create a favorites playlist for every group.', 'error');
    return;
  }

  const metadata = collectClipMetadata();
  let savedCount = 0;
  for (let index = 0; index < groupNumbers.length; index += 1) {
    const group = groupNumbers[index];
    const groupScenes = byGroup.get(group).sort((a, b) => a.start - b.start);
    const playlistName = playlistByGroup.get(group);
    const first = groupScenes[0];
    const last = groupScenes[groupScenes.length - 1];
    setTrimStatus(
      `Saving group ${group} (${index + 1} of ${groupNumbers.length}) to "${playlistName}"...`,
      'neutral'
    );

    const body =
      groupScenes.length > 1
        ? {
            videoName,
            start: String(first.start),
            end: String(last.end),
            playlistName,
            mode: 'keep-scenes',
            segments: groupScenes.map(({ start, end }) => ({ start, end })),
            ...metadata
          }
        : { videoName, start: String(first.start), end: String(first.end), playlistName, mode: 'single', ...metadata };

    try {
      const res = await fetch('/api/videos/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Group ${group} failed.`);
      }
      savedCount += 1;
    } catch (error) {
      setTrimStatus(
        `Saved ${savedCount} of ${groupNumbers.length} group video(s). Group ${group} failed: ${error.message}`,
        'error'
      );
      await fetchFavoritesPlaylists();
      await fetchVideos();
      return;
    }
  }

  setTrimStatus(`Saved ${savedCount} group video(s), each to its own favorites playlist.`, 'success');
  el.extraScenes.innerHTML = '';
  el.scene1Group.value = '1';
  el.groupPlaylistRows.innerHTML = '';
  delete el.groupPlaylistRows.dataset.key;
  clearClipMetadataFields();
  updateEditModeFields();
  await fetchFavoritesPlaylists();
  await fetchVideos();
  previewSelectedVideo(videoName);
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

  if (isSplitByGroup()) {
    await handleGroupedSubmit(videoName);
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
    const problem = validateSceneSet(candidateSegments);
    if (problem) {
      setTrimStatus(problem, 'error');
      return;
    }
    candidateSegments.sort((a, b) => a.start - b.start);
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
      body: JSON.stringify({ videoName, start, end, playlistName, mode: effectiveMode, segments, ...collectClipMetadata() })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Trim failed.');
    }

    setTrimStatus(data.message || 'Trim saved to favorites successfully.', 'success');
    el.trimNewPlaylist.value = '';
    el.trimPlaylistSelect.value = '';
    el.extraScenes.innerHTML = '';
    el.scene1Group.value = '1';
    clearClipMetadataFields();
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
    await Promise.all([fetchVideos(), fetchMainVideos(), fetchFavoritesPlaylists(), fetchLibraryCategories()]);
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

el.scene1Group.addEventListener('input', updateTrimRangeStatus);
el.splitByGroup.addEventListener('change', updateEditModeFields);

el.trimPreview.addEventListener('play', startPlayheadLoop);
el.trimPreview.addEventListener('playing', startPlayheadLoop);
['pause', 'ended', 'seeked', 'timeupdate', 'loadedmetadata'].forEach((name) => {
  el.trimPreview.addEventListener(name, updatePlayheads);
});

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
