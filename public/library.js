const state = {
  results: [],
  playlists: [],
  selectedName: '',
  checked: new Set(),
  lastCheckedIndex: -1,
  searchSeq: 0
};

const el = {
  refreshBtn: document.getElementById('refreshLibraryBtn'),
  scanBtn: document.getElementById('scanLibraryBtn'),
  scanStatus: document.getElementById('scanStatus'),
  searchForm: document.getElementById('searchForm'),
  searchQuery: document.getElementById('searchQuery'),
  tagFilter: document.getElementById('tagFilter'),
  categoryFilter: document.getElementById('categoryFilter'),
  personFilter: document.getElementById('personFilter'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  resultsHeading: document.getElementById('libraryResultsHeading'),
  results: document.getElementById('libraryResults'),
  tpl: document.getElementById('libraryItemTemplate'),
  player: document.getElementById('libraryPlayer'),
  nowPlaying: document.getElementById('libraryNowPlaying'),
  status: document.getElementById('libraryStatus'),
  metadataForm: document.getElementById('metadataForm'),
  metadataHeading: document.getElementById('metadataHeading'),
  metadataStatus: document.getElementById('metadataStatus'),
  metaTitle: document.getElementById('metaTitle'),
  metaNotes: document.getElementById('metaNotes'),
  metaCategory: document.getElementById('metaCategory'),
  metaPeople: document.getElementById('metaPeople'),
  metaKeywords: document.getElementById('metaKeywords'),
  categoryOptions: document.getElementById('categoryOptions'),
  selectAllBox: document.getElementById('selectAllBox'),
  bulkCount: document.getElementById('bulkCount'),
  bulkClearBtn: document.getElementById('bulkClearBtn'),
  bulkTarget: document.getElementById('bulkTarget'),
  bulkNewName: document.getElementById('bulkNewName'),
  bulkCopyBtn: document.getElementById('bulkCopyBtn'),
  bulkMoveBtn: document.getElementById('bulkMoveBtn'),
  bulkStatus: document.getElementById('bulkStatus')
};

function populateSelect(select, values, placeholderLabel) {
  const previous = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = placeholderLabel;
  select.appendChild(placeholder);
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
  if (values.includes(previous)) {
    select.value = previous;
  }
}

async function loadTags() {
  const res = await fetch('/api/library/tags');
  if (!res.ok) {
    throw new Error('Failed to load tags.');
  }
  const data = await res.json();
  const tags = data.tags || {};
  const tagNames = Object.values(tags).flat().map((t) => t.name).sort((a, b) => a.localeCompare(b));
  const categoryTagNames = (tags.category || []).map((t) => t.name);
  const personNames = (tags.person || []).map((t) => t.name).sort((a, b) => a.localeCompare(b));
  const categories = data.categories || [];
  state.playlists = (tags.manual || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  populateSelect(el.tagFilter, tagNames, 'Any tag');
  populateSelect(el.categoryFilter, Array.from(new Set([...categories, ...categoryTagNames])).sort((a, b) => a.localeCompare(b)), 'Any category');
  populateSelect(el.personFilter, personNames, 'Any person');

  el.categoryOptions.innerHTML = '';
  categories.forEach((label) => {
    const option = document.createElement('option');
    option.value = label;
    el.categoryOptions.appendChild(option);
  });

  const previousTarget = el.bulkTarget.value;
  el.bulkTarget.innerHTML = '<option value="">Send to playlist...</option>';
  state.playlists.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.name;
    option.textContent = `${playlist.name} (${playlist.count})`;
    el.bulkTarget.appendChild(option);
  });
  if (state.playlists.some((playlist) => playlist.name === previousTarget)) {
    el.bulkTarget.value = previousTarget;
  }
  updateBulkBar();
}

// A "move" needs a source playlist: only offered when the tag filter is a manual playlist.
function currentSourcePlaylist() {
  const tag = el.tagFilter.value;
  return tag && state.playlists.some((playlist) => playlist.name === tag) ? tag : '';
}

function updateBulkBar() {
  const visibleNames = state.results.map((video) => video.name);
  const visibleChecked = visibleNames.filter((name) => state.checked.has(name)).length;
  const offscreen = state.checked.size - visibleChecked;
  el.bulkCount.textContent = `${state.checked.size} selected${offscreen > 0 ? ` (${offscreen} not in current results)` : ''}`;
  el.selectAllBox.checked = visibleNames.length > 0 && visibleChecked === visibleNames.length;
  el.selectAllBox.indeterminate = visibleChecked > 0 && visibleChecked < visibleNames.length;
  el.selectAllBox.disabled = visibleNames.length === 0;

  const hasSelection = state.checked.size > 0;
  el.bulkClearBtn.disabled = !hasSelection;
  el.bulkCopyBtn.disabled = !hasSelection;
  el.bulkMoveBtn.disabled = !hasSelection;

  const source = currentSourcePlaylist();
  el.bulkMoveBtn.hidden = !source;
  el.bulkMoveBtn.title = source ? `Add to the target playlist and remove from "${source}"` : '';
}

function setChecked(name, checked) {
  if (checked) {
    state.checked.add(name);
  } else {
    state.checked.delete(name);
  }
}

async function sendSelectedToPlaylist({ move = false } = {}) {
  const targetName = el.bulkNewName.value.trim() || el.bulkTarget.value;
  if (!state.checked.size) {
    el.bulkStatus.textContent = 'Select one or more videos first.';
    return;
  }
  if (!targetName) {
    el.bulkStatus.textContent = 'Choose a playlist or enter a new playlist name.';
    return;
  }
  const source = move ? currentSourcePlaylist() : '';
  if (move && source.toLowerCase() === targetName.toLowerCase()) {
    el.bulkStatus.textContent = 'Target playlist is the same as the source playlist.';
    return;
  }

  el.bulkCopyBtn.disabled = true;
  el.bulkMoveBtn.disabled = true;
  el.bulkStatus.textContent = move ? 'Moving...' : 'Copying...';
  try {
    const res = await fetch('/api/favorites/add-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoNames: Array.from(state.checked),
        playlistName: targetName,
        removeFromPlaylist: source || null
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || body.detail || 'Failed to send to playlist.');
    }
    el.bulkStatus.textContent = body.message || 'Done.';
    state.checked.clear();
    el.bulkNewName.value = '';
    await loadTags();
    el.bulkTarget.value = state.playlists.some((p) => p.name === targetName) ? targetName : el.bulkTarget.value;
    await fetchResults();
  } catch (err) {
    el.bulkStatus.textContent = err.message || 'Failed to send to playlist.';
  } finally {
    updateBulkBar();
  }
}

function renderTagChips(container, tags, { append = false } = {}) {
  if (!append) {
    container.innerHTML = '';
  }
  (tags || []).forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = `tag-chip tag-chip-${tag.kind}`;
    chip.textContent = tag.name;
    container.appendChild(chip);
  });
}

function getVideoPlaylists(video) {
  return (video.tags || []).filter((tag) => tag.kind === 'manual').map((tag) => tag.name);
}

function renderPlaylistMembership(container, playlistNames) {
  container.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = playlistNames.length ? 'Playlists:' : 'Not in any playlist';
  container.appendChild(label);
  renderTagChips(
    container,
    playlistNames.map((name) => ({ name, kind: 'manual' })),
    { append: true }
  );
}

async function copyVideoToPlaylist(videoName, playlistName) {
  const res = await fetch('/api/favorites/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoName, playlistName })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.detail || 'Failed to copy to playlist.');
  }
}

function wireCopyPanel(row, video, playlistNames) {
  const copyPanel = row.querySelector('.copy-panel');
  const copyTarget = row.querySelector('.copy-target');
  const copyNew = row.querySelector('.copy-new');
  const inPlaylist = new Set(playlistNames.map((name) => name.toLowerCase()));

  row.querySelector('.copy').addEventListener('click', () => {
    copyTarget.innerHTML = '<option value="">Copy to playlist...</option>';
    state.playlists
      .filter((playlist) => !inPlaylist.has(playlist.name.toLowerCase()))
      .forEach((playlist) => {
        const option = document.createElement('option');
        option.value = playlist.name;
        option.textContent = `${playlist.name} (${playlist.count})`;
        copyTarget.appendChild(option);
      });
    copyNew.value = '';
    copyPanel.hidden = !copyPanel.hidden;
    if (!copyPanel.hidden) {
      copyNew.focus();
    }
  });

  row.querySelector('.copy-cancel').addEventListener('click', () => {
    copyPanel.hidden = true;
  });

  const copyToTarget = async () => {
    const targetName = copyNew.value.trim() || copyTarget.value;
    if (!targetName) {
      el.status.textContent = 'Choose a playlist or enter a new playlist name to copy to.';
      return;
    }
    if (inPlaylist.has(targetName.toLowerCase())) {
      el.status.textContent = `${video.name} is already in ${targetName}.`;
      return;
    }

    try {
      await copyVideoToPlaylist(video.name, targetName);
      el.status.textContent = `Copied ${video.name} to ${targetName}.`;
      await Promise.all([loadTags(), fetchResults()]);
    } catch (err) {
      el.status.textContent = err.message || 'Failed to copy to playlist.';
    }
  };

  row.querySelector('.copy-confirm').addEventListener('click', copyToTarget);
  copyNew.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      copyToTarget();
    }
  });
}

function renderResults() {
  el.results.innerHTML = '';
  el.resultsHeading.textContent = `Results (${state.results.length})${state.fuzzy ? ' - no exact matches, showing close matches' : ''}`;

  state.results.forEach((video, index) => {
    const node = el.tpl.content.cloneNode(true);
    const li = node.querySelector('li');
    const playlistNames = getVideoPlaylists(video);
    node.querySelector('.video-name').textContent = video.title ? `${video.name} — ${video.title}` : video.name;
    const box = node.querySelector('.select-box');
    box.checked = state.checked.has(video.name);
    li.classList.toggle('checked', box.checked);
    box.addEventListener('click', (event) => {
      // Shift-click selects/deselects the whole range since the last clicked row.
      if (event.shiftKey && state.lastCheckedIndex >= 0 && state.lastCheckedIndex < state.results.length) {
        const [start, end] = [state.lastCheckedIndex, index].sort((a, b) => a - b);
        state.results.slice(start, end + 1).forEach((v) => setChecked(v.name, box.checked));
        state.lastCheckedIndex = index;
        renderResults();
        return;
      }
      setChecked(video.name, box.checked);
      li.classList.toggle('checked', box.checked);
      state.lastCheckedIndex = index;
      updateBulkBar();
    });
    renderPlaylistMembership(node.querySelector('.library-playlists'), playlistNames);
    // Playlists get their own line above, so leave them out of the generic tag chips.
    renderTagChips(
      node.querySelector('.library-tags'),
      (video.tags || []).filter((tag) => tag.kind !== 'manual')
    );

    node.querySelector('.play').addEventListener('click', () => playVideo(video));
    node.querySelector('.edit').addEventListener('click', () => selectVideoForEdit(video.name));
    wireCopyPanel(li, video, playlistNames);

    if (video.name === state.selectedName) {
      li.classList.add('selected');
    }

    el.results.appendChild(node);
  });
  updateBulkBar();
}

async function fetchResults() {
  const params = new URLSearchParams();
  if (el.searchQuery.value.trim()) params.set('q', el.searchQuery.value.trim());
  if (el.tagFilter.value) params.set('tag', el.tagFilter.value);
  if (el.categoryFilter.value) params.set('category', el.categoryFilter.value);
  if (el.personFilter.value) params.set('person', el.personFilter.value);

  const seq = ++state.searchSeq;
  const res = await fetch(`/api/library/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error('Search failed.');
  }
  const data = await res.json();
  // Ignore stale responses when the user keeps typing.
  if (seq !== state.searchSeq) {
    return;
  }
  state.results = data.videos || [];
  state.fuzzy = Boolean(data.fuzzy);
  state.lastCheckedIndex = -1;
  renderResults();
}

function playVideo(video) {
  el.player.src = video.url;
  el.nowPlaying.textContent = `Now Playing: ${video.name}`;
  el.player.play().catch(() => {
    el.status.textContent = 'Autoplay blocked by browser. Press play on the player.';
  });
}

async function selectVideoForEdit(name) {
  state.selectedName = name;
  el.metadataHeading.textContent = `Metadata: ${name}`;
  el.metadataStatus.textContent = 'Loading...';
  renderResults();

  try {
    const res = await fetch(`/api/videos/${encodeURIComponent(name)}/metadata`);
    if (!res.ok) {
      throw new Error('Failed to load metadata.');
    }
    const data = await res.json();
    el.metaTitle.value = data.title || '';
    el.metaNotes.value = data.notes || '';
    el.metaCategory.value = data.category || '';
    el.metaPeople.value = (data.people || []).join(', ');
    el.metaKeywords.value = (data.keywords || []).join(', ');
    el.metadataStatus.textContent = '';
  } catch (err) {
    el.metadataStatus.textContent = err.message || 'Failed to load metadata.';
  }
}

function splitCommaList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function saveMetadata(event) {
  event.preventDefault();
  if (!state.selectedName) {
    el.metadataStatus.textContent = 'Select a video first (click Edit).';
    return;
  }

  el.metadataStatus.textContent = 'Saving...';
  try {
    const res = await fetch(`/api/videos/${encodeURIComponent(state.selectedName)}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: el.metaTitle.value.trim() || null,
        notes: el.metaNotes.value.trim() || null,
        category: el.metaCategory.value.trim() || null,
        people: splitCommaList(el.metaPeople.value),
        keywords: splitCommaList(el.metaKeywords.value)
      })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.detail || 'Failed to save metadata.');
    }
    el.metadataStatus.textContent = 'Saved.';
    await Promise.all([loadTags(), fetchResults()]);
  } catch (err) {
    el.metadataStatus.textContent = err.message || 'Failed to save metadata.';
  }
}

function clearSearch() {
  el.searchQuery.value = '';
  el.tagFilter.value = '';
  el.categoryFilter.value = '';
  el.personFilter.value = '';
  fetchResults().catch((err) => {
    el.status.textContent = err.message || 'Failed to load results.';
  });
}

let scanPollTimer = null;

function renderScanStatus(job) {
  if (!job || job.status === 'idle') {
    el.scanStatus.textContent = '';
    return;
  }
  if (job.status === 'running') {
    el.scanStatus.textContent = `Scanning... ${job.processed}/${job.total}${job.current ? ` (${job.current})` : ''}`;
  } else if (job.status === 'completed') {
    el.scanStatus.textContent = `Scan complete: tagged ${job.processed}/${job.total} video(s).`;
  } else if (job.status === 'failed') {
    const reason = job.results && job.results[0] && job.results[0].error;
    el.scanStatus.textContent = `Scan failed${reason ? `: ${reason}` : '.'}`;
  }
}

async function pollScanStatus() {
  try {
    const res = await fetch('/api/library/scan-status');
    const job = await res.json();
    renderScanStatus(job);
    if (job.status === 'running') {
      scanPollTimer = setTimeout(pollScanStatus, 1500);
    } else {
      clearTimeout(scanPollTimer);
      await Promise.all([loadTags(), fetchResults()]);
    }
  } catch (err) {
    el.scanStatus.textContent = err.message || 'Failed to check scan status.';
  }
}

async function startScan() {
  try {
    const res = await fetch('/api/library/scan', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.detail || 'Failed to start scan.');
    }
    el.scanStatus.textContent = 'Scan started...';
    clearTimeout(scanPollTimer);
    scanPollTimer = setTimeout(pollScanStatus, 1000);
  } catch (err) {
    el.scanStatus.textContent = err.message || 'Failed to start scan.';
  }
}

async function init() {
  const runSearch = () => {
    fetchResults().catch((err) => {
      el.status.textContent = err.message || 'Search failed.';
    });
  };
  let searchDebounce = null;

  el.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(searchDebounce);
    runSearch();
  });
  el.searchQuery.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runSearch, 250);
  });
  [el.tagFilter, el.categoryFilter, el.personFilter].forEach((select) => {
    select.addEventListener('change', runSearch);
  });

  el.selectAllBox.addEventListener('change', () => {
    state.results.forEach((video) => setChecked(video.name, el.selectAllBox.checked));
    renderResults();
  });
  el.bulkClearBtn.addEventListener('click', () => {
    state.checked.clear();
    el.bulkStatus.textContent = '';
    renderResults();
  });
  el.bulkCopyBtn.addEventListener('click', () => sendSelectedToPlaylist());
  el.bulkMoveBtn.addEventListener('click', () => sendSelectedToPlaylist({ move: true }));
  el.bulkNewName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendSelectedToPlaylist();
    }
  });

  el.clearSearchBtn.addEventListener('click', clearSearch);
  el.refreshBtn.addEventListener('click', () => {
    Promise.all([loadTags(), fetchResults()]).catch((err) => {
      el.status.textContent = err.message || 'Failed to refresh.';
    });
  });
  el.scanBtn.addEventListener('click', startScan);
  el.metadataForm.addEventListener('submit', saveMetadata);

  try {
    await Promise.all([loadTags(), fetchResults()]);
    await pollScanStatus();
  } catch (err) {
    el.status.textContent = err.message || 'Failed to load library.';
  }
}

init();
