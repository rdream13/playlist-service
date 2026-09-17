const state = {
  playlists: []
};

const el = {
  refreshBtn: document.getElementById('refreshMixBtn'),
  mixForm: document.getElementById('mixForm'),
  mixPlaylistSelect: document.getElementById('mixPlaylistSelect'),
  mixClipLength: document.getElementById('mixClipLength'),
  mixTotalLength: document.getElementById('mixTotalLength'),
  mixArrangement: document.getElementById('mixArrangement'),
  mixRandomOrder: document.getElementById('mixRandomOrder'),
  mixSubmit: null,
  mixPreview: document.getElementById('mixPreview'),
  mixStatus: document.getElementById('mixStatus')
};

el.mixSubmit = el.mixForm.querySelector('button[type="submit"]');

const MAIN_PLAYLIST_VALUE = '__main__';

function setMixStatus(message, kind = 'neutral') {
  const allowed = new Set(['neutral', 'success', 'error']);
  const level = allowed.has(kind) ? kind : 'neutral';
  el.mixStatus.textContent = message;
  el.mixStatus.classList.remove('success', 'error', 'neutral');
  el.mixStatus.classList.add(level);
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

async function fetchFavoritesPlaylists() {
  const res = await fetch('/api/favorites/playlists');
  if (!res.ok) {
    throw new Error('Unable to load favorites playlists.');
  }

  const data = await res.json();
  state.playlists = data.playlists || [];
  populatePlaylistSelect();
}

function populatePlaylistSelect() {
  const selected = el.mixPlaylistSelect.value;
  el.mixPlaylistSelect.innerHTML = '<option value="">Choose a playlist...</option>';

  const mainOption = document.createElement('option');
  mainOption.value = MAIN_PLAYLIST_VALUE;
  mainOption.textContent = 'Main Playlist';
  el.mixPlaylistSelect.appendChild(mainOption);

  state.playlists.forEach((playlist) => {
    const option = document.createElement('option');
    option.value = playlist.name;
    option.textContent = `${playlist.name} (${playlist.count})`;
    el.mixPlaylistSelect.appendChild(option);
  });

  if (selected) {
    el.mixPlaylistSelect.value = selected;
  }
}

async function handleMixSubmit(event) {
  event.preventDefault();

  const playlistSource = el.mixPlaylistSelect.value;
  const clipSeconds = parseTimeString(el.mixClipLength.value);
  const totalSeconds = parseTimeString(el.mixTotalLength.value);
  const arrangement = el.mixArrangement.value;
  const mixedOrder = el.mixRandomOrder.checked;

  if (!playlistSource) {
    setMixStatus('Choose a playlist first.', 'error');
    return;
  }

  if (clipSeconds === null || clipSeconds <= 0) {
    setMixStatus('Enter a valid clip length such as 00:00:05.', 'error');
    return;
  }

  if (totalSeconds === null || totalSeconds <= 0) {
    setMixStatus('Enter a valid total mix length such as 00:02:00.', 'error');
    return;
  }

  el.mixSubmit.disabled = true;
  setMixStatus('Creating mix video... this can take a while.', 'neutral');

  try {
    const res = await fetch('/api/videos/mix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ playlistSource, clipSeconds, totalSeconds, arrangement, mixedOrder })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Mix creation failed.');
    }

    setMixStatus(data.message || 'Mix video created.', 'success');

    if (data.videoName) {
      el.mixPreview.src = `/media/${encodeURIComponent(data.videoName)}`;
      el.mixPreview.load();
    }

    await fetchFavoritesPlaylists();
  } catch (error) {
    setMixStatus(error.message || 'Mix creation failed.', 'error');
  } finally {
    el.mixSubmit.disabled = false;
  }
}

async function init() {
  try {
    await fetchFavoritesPlaylists();
    setMixStatus('Ready.', 'neutral');
  } catch (error) {
    setMixStatus(error.message || 'Could not load playlists.', 'error');
  }
}

el.refreshBtn.addEventListener('click', async () => {
  setMixStatus('Refreshing playlists...', 'neutral');
  try {
    await fetchFavoritesPlaylists();
    setMixStatus('Ready.', 'neutral');
  } catch (error) {
    setMixStatus(error.message || 'Refresh failed.', 'error');
  }
});

el.mixForm.addEventListener('submit', handleMixSubmit);

init();
