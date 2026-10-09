const state = {
  results: [],
  selectedName: ''
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
  categoryOptions: document.getElementById('categoryOptions')
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

  populateSelect(el.tagFilter, tagNames, 'Any tag');
  populateSelect(el.categoryFilter, Array.from(new Set([...categories, ...categoryTagNames])).sort((a, b) => a.localeCompare(b)), 'Any category');
  populateSelect(el.personFilter, personNames, 'Any person');

  el.categoryOptions.innerHTML = '';
  categories.forEach((label) => {
    const option = document.createElement('option');
    option.value = label;
    el.categoryOptions.appendChild(option);
  });
}

function renderTagChips(container, tags) {
  container.innerHTML = '';
  (tags || []).forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = `tag-chip tag-chip-${tag.kind}`;
    chip.textContent = tag.name;
    container.appendChild(chip);
  });
}

function renderResults() {
  el.results.innerHTML = '';
  el.resultsHeading.textContent = `Results (${state.results.length})`;

  state.results.forEach((video) => {
    const node = el.tpl.content.cloneNode(true);
    const li = node.querySelector('li');
    node.querySelector('.video-name').textContent = video.name;
    renderTagChips(node.querySelector('.library-tags'), video.tags);

    node.querySelector('.play').addEventListener('click', () => playVideo(video));
    node.querySelector('.edit').addEventListener('click', () => selectVideoForEdit(video.name));

    if (video.name === state.selectedName) {
      li.classList.add('selected');
    }

    el.results.appendChild(node);
  });
}

async function fetchResults() {
  const params = new URLSearchParams();
  if (el.searchQuery.value.trim()) params.set('q', el.searchQuery.value.trim());
  if (el.tagFilter.value) params.set('tag', el.tagFilter.value);
  if (el.categoryFilter.value) params.set('category', el.categoryFilter.value);
  if (el.personFilter.value) params.set('person', el.personFilter.value);

  const res = await fetch(`/api/library/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error('Search failed.');
  }
  const data = await res.json();
  state.results = data.videos || [];
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
  el.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    fetchResults().catch((err) => {
      el.status.textContent = err.message || 'Search failed.';
    });
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
