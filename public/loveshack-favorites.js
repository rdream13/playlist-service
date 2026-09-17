const state = {
  playlists: [],
  playQueue: [],
  playingIndex: -1,
  playAllActive: false,
  activePlaylistName: '',
  currentVideoName: ''
};

const el = {
  groups: document.getElementById('favoritesGroups'),
  refreshBtn: document.getElementById('refreshFavoritesBtn'),
  player: document.getElementById('favoritesPlayer'),
  prevBtn: document.getElementById('favoritesPrevBtn'),
  nextBtn: document.getElementById('favoritesNextBtn'),
  nowPlaying: document.getElementById('favoritesNowPlaying'),
  status: document.getElementById('favoritesStatus'),
  tpl: document.getElementById('favoriteItemTemplate')
};

async function fetchFavoritesPlaylists() {
  const res = await fetch('/api/favorites/playlists');
  if (!res.ok) {
    throw new Error('Failed to load favorites playlists.');
  }
  const data = await res.json();
  state.playlists = data.playlists || [];
}

function setNowPlaying(videoName) {
  state.currentVideoName = videoName || '';
  el.nowPlaying.textContent = `Now Playing: ${videoName || 'none'}`;
}

function playFavorite(video) {
  if (!video) {
    return;
  }
  el.player.src = video.url;
  setNowPlaying(video.name);
  el.player.play().catch(() => {
    el.status.textContent = 'Autoplay blocked by browser. Press play on the player.';
  });
}

function shuffleArray(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function startPlaylistPlayback(playlist, shuffled = false) {
  if (!playlist || !Array.isArray(playlist.items) || !playlist.items.length) {
    el.status.textContent = 'No videos in this playlist to play.';
    return;
  }

  state.playQueue = shuffled ? shuffleArray(playlist.items) : [...playlist.items];
  state.playingIndex = 0;
  state.playAllActive = true;
  state.activePlaylistName = playlist.name;

  playFavorite(state.playQueue[state.playingIndex]);
  el.status.textContent = shuffled
    ? `Shuffle & Play All started for ${playlist.name}.`
    : `Playing playlist ${playlist.name}.`;
}

function shuffleAndPlayAll(playlist) {
  startPlaylistPlayback(playlist, true);
}

function skipInFavoritesPlaylist(direction) {
  if (!state.playQueue.length) {
    el.status.textContent = 'Play a video from a favorites playlist first.';
    return;
  }

  let currentIndex = state.playQueue.findIndex((video) => video.name === state.currentVideoName);
  if (currentIndex === -1) {
    currentIndex = state.playingIndex;
  }
  if (currentIndex === -1) {
    currentIndex = direction === 'next' ? -1 : state.playQueue.length;
  }

  const nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= state.playQueue.length) {
    el.status.textContent = direction === 'next'
      ? 'Already at the last video in this playlist.'
      : 'Already at the first video in this playlist.';
    return;
  }

  state.playingIndex = nextIndex;
  playFavorite(state.playQueue[nextIndex]);
  el.status.textContent = direction === 'next'
    ? `Skipped to next video in ${state.activePlaylistName}.`
    : `Skipped to previous video in ${state.activePlaylistName}.`;
}

async function removeFromPlaylist(playlistName, videoName) {
  const res = await fetch(
    `/api/favorites/playlists/${encodeURIComponent(playlistName)}/videos/${encodeURIComponent(videoName)}`,
    { method: 'DELETE' }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to remove from favorites playlist.');
  }

  state.playlists = data.playlists || [];
}

async function moveVideoInPlaylist(playlistName, videoName, direction) {
  const res = await fetch(`/api/favorites/playlists/${encodeURIComponent(playlistName)}/move`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ videoName, direction })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to reorder favorites playlist.');
  }

  state.playlists = data.playlists || [];
}

async function deletePlaylist(playlistName) {
  if (!confirm(`Delete the entire playlist "${playlistName}"?`)) {
    return;
  }

  const res = await fetch(`/api/favorites/playlists/${encodeURIComponent(playlistName)}`, {
    method: 'DELETE'
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to delete favorites playlist.');
  }

  state.playlists = data.playlists || [];
  renderPlaylists();
  el.status.textContent = `Deleted playlist ${playlistName}.`;
}

async function sendVideoToMainPlaylist(videoName) {
  const res = await fetch('/api/favorites/to-main', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ videoName })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to move video to main playlist.');
  }
}

async function renameFavoriteVideo(oldName) {
  const newName = prompt('Rename video to:', oldName);
  if (!newName || newName.trim() === oldName) {
    return;
  }

  const res = await fetch('/api/videos/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName: newName.trim() })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Rename failed.');
  }

  state.playlists = data.playlists || state.playlists;
  if (state.currentVideoName === oldName) {
    state.currentVideoName = newName.trim();
    setNowPlaying(state.currentVideoName);
  }
  renderPlaylists();
  el.status.textContent = `Renamed ${oldName} to ${newName.trim()}.`;
}

function renderPlaylists() {
  el.groups.innerHTML = '';

  if (!state.playlists.length) {
    const empty = document.createElement('p');
    empty.className = 'playlist-meta';
    empty.textContent = 'No favorites yet. Use Fav on the main page to add videos.';
    el.groups.appendChild(empty);
    return;
  }

  state.playlists.forEach((playlist) => {
    const group = document.createElement('section');
    group.className = 'playlist-group';

    const header = document.createElement('div');
    header.className = 'playlist-header';

    const title = document.createElement('h3');
    title.textContent = playlist.name;

    const playPlaylistBtn = document.createElement('button');
    playPlaylistBtn.className = 'btn tiny btn-primary';
    playPlaylistBtn.type = 'button';
    playPlaylistBtn.textContent = 'Play Playlist';
    playPlaylistBtn.addEventListener('click', () => {
      startPlaylistPlayback(playlist);
    });

    const shufflePlaylistBtn = document.createElement('button');
    shufflePlaylistBtn.className = 'btn tiny';
    shufflePlaylistBtn.type = 'button';
    shufflePlaylistBtn.textContent = 'Shuffle & Play All';
    shufflePlaylistBtn.addEventListener('click', () => {
      shuffleAndPlayAll(playlist);
    });

    const deletePlaylistBtn = document.createElement('button');
    deletePlaylistBtn.className = 'btn tiny danger';
    deletePlaylistBtn.type = 'button';
    deletePlaylistBtn.textContent = 'Delete Playlist';
    deletePlaylistBtn.addEventListener('click', async () => {
      try {
        await deletePlaylist(playlist.name);
      } catch (err) {
        el.status.textContent = err.message;
      }
    });

    const meta = document.createElement('p');
    meta.className = 'playlist-meta';
    meta.textContent = `${playlist.count} video(s)`;

    const list = document.createElement('ul');
    list.className = 'playlist-videos';

    playlist.items.forEach((video) => {
      const playlistIndex = playlist.items.findIndex((item) => item.name === video.name);
      const row = el.tpl.content.firstElementChild.cloneNode(true);
      row.querySelector('.video-name').textContent = video.name;

      row.querySelector('.move-up').addEventListener('click', async () => {
        try {
          await moveVideoInPlaylist(playlist.name, video.name, 'up');
          renderPlaylists();
          el.status.textContent = `Moved ${video.name} up in ${playlist.name}.`;
        } catch (err) {
          el.status.textContent = err.message;
        }
      });

      row.querySelector('.move-down').addEventListener('click', async () => {
        try {
          await moveVideoInPlaylist(playlist.name, video.name, 'down');
          renderPlaylists();
          el.status.textContent = `Moved ${video.name} down in ${playlist.name}.`;
        } catch (err) {
          el.status.textContent = err.message;
        }
      });

      row.querySelector('.to-main').addEventListener('click', async () => {
        try {
          await sendVideoToMainPlaylist(video.name);
          el.status.textContent = `Sent ${video.name} to the top of the main playlist.`;
        } catch (err) {
          el.status.textContent = err.message;
        }
      });

      row.querySelector('.rename').addEventListener('click', async () => {
        try {
          await renameFavoriteVideo(video.name);
        } catch (err) {
          el.status.textContent = err.message;
        }
      });

      row.querySelector('.edit').addEventListener('click', () => {
        const target = new URL(`/loveshack-edit?video=${encodeURIComponent(video.name)}`, window.location.origin);
        window.location.href = target.toString();
      });

      row.querySelector('.play').addEventListener('click', () => {
        state.playAllActive = false;
        state.playQueue = [...playlist.items];
        state.playingIndex = playlistIndex;
        state.activePlaylistName = playlist.name;
        playFavorite(video);
        el.status.textContent = `Playing from ${playlist.name}.`;
      });

      row.querySelector('.remove').addEventListener('click', async () => {
        if (!confirm(`Remove ${video.name} from ${playlist.name}?`)) {
          return;
        }

        try {
          await removeFromPlaylist(playlist.name, video.name);
          renderPlaylists();
          el.status.textContent = `Removed ${video.name} from ${playlist.name}.`;
        } catch (err) {
          el.status.textContent = err.message;
        }
      });

      list.appendChild(row);
    });

    header.appendChild(title);
    header.appendChild(playPlaylistBtn);
    header.appendChild(shufflePlaylistBtn);
    header.appendChild(deletePlaylistBtn);
    group.appendChild(header);
    group.appendChild(meta);
    group.appendChild(list);
    el.groups.appendChild(group);
  });
}

el.player.addEventListener('ended', () => {
  if (!state.playAllActive) {
    return;
  }

  state.playingIndex += 1;
  if (state.playingIndex >= state.playQueue.length) {
    state.playAllActive = false;
    state.playQueue = [];
    state.playingIndex = -1;
    const finishedName = state.activePlaylistName;
    state.activePlaylistName = '';
    setNowPlaying(null);
    el.status.textContent = finishedName
      ? `Playlist ${finishedName} finished.`
      : 'Playlist finished.';
    return;
  }

  const nextVideo = state.playQueue[state.playingIndex];
  playFavorite(nextVideo);
  el.status.textContent = `Playing playlist ${state.activePlaylistName}.`;
});

async function refreshFavorites() {
  await fetchFavoritesPlaylists();
  renderPlaylists();
  el.status.textContent = `${state.playlists.length} playlist(s) loaded.`;
}

el.refreshBtn.addEventListener('click', () => {
  refreshFavorites().catch((err) => {
    el.status.textContent = err.message;
  });
});

if (el.prevBtn) {
  el.prevBtn.addEventListener('click', () => {
    skipInFavoritesPlaylist('previous');
  });
}

if (el.nextBtn) {
  el.nextBtn.addEventListener('click', () => {
    skipInFavoritesPlaylist('next');
  });
}

refreshFavorites().catch((err) => {
  el.status.textContent = err.message;
});
