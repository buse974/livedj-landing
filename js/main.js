// ============================================================
// livedj - DJ automatique piloté par l'IA
// ============================================================

const STORAGE_KEY = 'livedj_config';
const MAX_HISTORY = 50;

// --- AI Providers -----------------------------------------------------------

const aiProviders = {
  claude: {
    name: 'Claude (Anthropic)',
    async getNextTrack(token, vibe, history) {
      const played = history.map(t => `- ${t.artist} - ${t.title}`).join('\n');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: `Tu es un DJ expert avec une culture musicale encyclopédique. On te donne une ambiance et la liste des morceaux déjà joués. Tu dois suggérer UN seul morceau qui correspond parfaitement à l'ambiance, en variant les artistes et les époques. Réponds UNIQUEMENT avec du JSON valide, sans markdown, sans explication : {"title": "...", "artist": "...", "year": 2003}`,
          messages: [{
            role: 'user',
            content: `Ambiance : "${vibe}"\n\nDéjà joués :\n${played || '(aucun)'}\n\nProchain morceau ?`
          }]
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error('TOKEN_INVALID');
        throw new Error(err.error?.message || `Claude API error ${res.status}`);
      }

      const data = await res.json();
      return parseTrackJson(data.content[0].text);
    }
  }
};

// --- Music Providers --------------------------------------------------------

const musicProviders = {
  youtube: {
    name: 'YouTube',
    searchResults: [],
    searchIndex: 0,

    async search(token, track) {
      const query = `${track.artist} - ${track.title}`;
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', query);
      url.searchParams.set('type', 'video');
      url.searchParams.set('videoEmbeddable', 'true');
      url.searchParams.set('maxResults', '5');
      url.searchParams.set('key', token);

      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 403 && data.error?.errors?.[0]?.reason === 'quotaExceeded') {
          throw new Error('QUOTA_EXCEEDED');
        }
        if (res.status === 400 || res.status === 403) throw new Error('TOKEN_INVALID');
        throw new Error(`YouTube API error ${res.status}`);
      }

      const data = await res.json();
      if (!data.items?.length) throw new Error('NO_RESULTS');

      this.searchResults = data.items.map(i => i.id.videoId);
      this.searchIndex = 0;
      return this.searchResults[0];
    },

    getNextVideoId() {
      this.searchIndex++;
      if (this.searchIndex < this.searchResults.length) {
        return this.searchResults[this.searchIndex];
      }
      return null;
    }
  }
};

// --- State ------------------------------------------------------------------

const state = {
  config: { aiProvider: 'claude', musicProvider: 'youtube', tokens: {} },
  vibe: '',
  currentTrack: null,
  nextTrack: null,
  nextVideoId: null,
  playedTracks: [],
  player: null,
  ytReady: false,
  progressInterval: null,
  isLoading: false,
  isRerolling: false,
  isPaused: false,
  pendingVideoId: null
};

// --- DOM refs ---------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const dom = {};

function cacheDom() {
  dom.viewHome = $('#view-home');
  dom.viewPlayer = $('#view-player');
  dom.modal = $('#modal-settings');
  dom.formHome = $('#form-home');
  dom.formVibe = $('#form-vibe');
  dom.inputVibeHome = $('#input-vibe-home');
  dom.inputVibePlayer = $('#input-vibe-player');
  dom.btnPlay = $('#btn-play');
  dom.btnReroll = $('#btn-reroll');
  dom.btnNext = $('#btn-next');
  dom.btnPause = $('#btn-pause');
  dom.progressBar = $('#progress-bar');
  dom.btnOpenSettings = $('#btn-open-settings');
  dom.btnOpenSettingsPlayer = $('#btn-open-settings-player');
  dom.btnSaveSettings = $('#btn-save-settings');
  dom.btnCancelSettings = $('#btn-cancel-settings');
  dom.modalBackdrop = $('.modal-backdrop');
  dom.selectAi = $('#select-ai-provider');
  dom.inputAiToken = $('#input-ai-token');
  dom.selectMusic = $('#select-music-provider');
  dom.inputMusicToken = $('#input-music-token');
  dom.nowStatus = $('#now-status');
  dom.nowTitle = $('#now-title');
  dom.nowArtist = $('#now-artist');
  dom.nowYear = $('#now-year');
  dom.progressFill = $('#progress-fill');
  dom.timeCurrent = $('#time-current');
  dom.timeTotal = $('#time-total');
  dom.nextTitle = $('#next-title');
  dom.nextArtist = $('#next-artist');
}

// --- Config (localStorage) --------------------------------------------------

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  state.config = config;
}

function hasValidConfig() {
  const c = state.config;
  return c.tokens[c.aiProvider] && c.tokens[c.musicProvider];
}

// --- Views ------------------------------------------------------------------

function showView(name) {
  dom.viewHome.classList.toggle('hidden', name !== 'home');
  dom.viewPlayer.classList.toggle('hidden', name !== 'player');
}

function openSettings() {
  dom.selectAi.value = state.config.aiProvider;
  dom.inputAiToken.value = state.config.tokens[state.config.aiProvider] || '';
  dom.selectMusic.value = state.config.musicProvider;
  dom.inputMusicToken.value = state.config.tokens[state.config.musicProvider] || '';
  dom.modal.classList.remove('hidden');
}

function closeSettings() {
  dom.modal.classList.add('hidden');
}

// --- JSON parsing (défensif) ------------------------------------------------

function parseTrackJson(text) {
  const cleaned = text.trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Impossible de parser la réponse IA');
  }
}

// --- Core logic -------------------------------------------------------------

async function getNextTrackFromAI() {
  const provider = aiProviders[state.config.aiProvider];
  const token = state.config.tokens[state.config.aiProvider];
  const history = state.playedTracks.slice(-MAX_HISTORY);
  if (state.currentTrack) history.push(state.currentTrack);
  return provider.getNextTrack(token, state.vibe, history);
}

async function getVideoId(track) {
  const provider = musicProviders[state.config.musicProvider];
  const token = state.config.tokens[state.config.musicProvider];
  return provider.search(token, track);
}

function playVideoById(videoId) {
  if (state.player && state.ytReady) {
    state.player.loadVideoById(videoId);
  } else {
    state.pendingVideoId = videoId;
  }
}

async function startPlaying(vibe) {
  state.vibe = vibe;
  state.playedTracks = [];
  state.currentTrack = null;
  state.nextTrack = null;

  showView('player');
  dom.inputVibePlayer.value = vibe;
  setNowPlaying(null, 'Recherche du premier morceau...');

  try {
    const track = await getNextTrackFromAI();
    const videoId = await getVideoId(track);
    state.currentTrack = track;
    setNowPlaying(track, '');
    playVideoById(videoId);
    prefetchNext();
  } catch (err) {
    handleError(err);
  }
}

async function prefetchNext() {
  if (state.isRerolling) return;
  state.nextTrack = null;
  state.nextVideoId = null;
  setNextTrack(null, true);

  try {
    const track = await getNextTrackFromAI();
    const videoId = await getVideoId(track);
    state.nextTrack = track;
    state.nextVideoId = videoId;
    setNextTrack(track, false);
  } catch (err) {
    console.error('Prefetch failed:', err);
    setNextTrack(null, false, 'Erreur - cliquez reroll');
  }
}

function playNext() {
  if (!state.nextTrack || !state.nextVideoId) {
    setNowPlaying(null, 'Chargement...');
    prefetchAndPlay();
    return;
  }

  if (state.currentTrack) {
    state.playedTracks.push(state.currentTrack);
  }

  state.currentTrack = state.nextTrack;
  const videoId = state.nextVideoId;
  state.nextTrack = null;
  state.nextVideoId = null;

  setNowPlaying(state.currentTrack, '');
  playVideoById(videoId);
  prefetchNext();
}

async function prefetchAndPlay() {
  try {
    const track = await getNextTrackFromAI();
    const videoId = await getVideoId(track);
    if (state.currentTrack) state.playedTracks.push(state.currentTrack);
    state.currentTrack = track;
    setNowPlaying(track, '');
    playVideoById(videoId);
    prefetchNext();
  } catch (err) {
    handleError(err);
  }
}

async function reroll() {
  if (state.isRerolling) return;
  state.isRerolling = true;
  dom.btnReroll.disabled = true;
  dom.btnReroll.classList.add('spinning');
  setNextTrack(null, true);

  try {
    const track = await getNextTrackFromAI();
    const videoId = await getVideoId(track);
    state.nextTrack = track;
    state.nextVideoId = videoId;
    setNextTrack(track, false);
  } catch (err) {
    console.error('Reroll failed:', err);
    setNextTrack(null, false, 'Erreur - réessayez');
  } finally {
    state.isRerolling = false;
    dom.btnReroll.disabled = false;
    dom.btnReroll.classList.remove('spinning');
  }
}

function changeVibe(newVibe) {
  if (!newVibe.trim() || newVibe.trim() === state.vibe) return;
  state.vibe = newVibe.trim();
  prefetchNext();
}

// --- UI updates -------------------------------------------------------------

function setNowPlaying(track, statusMsg) {
  dom.nowStatus.classList.remove('loading-dots');
  if (statusMsg) {
    dom.nowStatus.textContent = statusMsg;
    dom.nowStatus.classList.add('loading-dots');
  } else {
    dom.nowStatus.textContent = '';
  }

  if (track) {
    dom.nowTitle.textContent = track.title;
    dom.nowArtist.textContent = track.artist;
    dom.nowYear.textContent = track.year || '';
  } else {
    dom.nowTitle.textContent = '---';
    dom.nowArtist.textContent = '---';
    dom.nowYear.textContent = '';
  }

  dom.progressFill.style.width = '0%';
  dom.timeCurrent.textContent = '0:00';
  dom.timeTotal.textContent = '0:00';
}

function setNextTrack(track, loading, errorMsg) {
  if (loading) {
    dom.nextTitle.textContent = 'Recherche...';
    dom.nextArtist.textContent = '';
  } else if (errorMsg) {
    dom.nextTitle.textContent = errorMsg;
    dom.nextArtist.textContent = '';
  } else if (track) {
    dom.nextTitle.textContent = track.title;
    dom.nextArtist.textContent = track.artist;
  } else {
    dom.nextTitle.textContent = 'En attente...';
    dom.nextArtist.textContent = '';
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function startProgressTracking() {
  clearInterval(state.progressInterval);
  state.progressInterval = setInterval(() => {
    if (!state.player) return;
    const current = state.player.getCurrentTime();
    const duration = state.player.getDuration();
    if (!duration) return;
    dom.progressFill.style.width = `${(current / duration) * 100}%`;
    dom.timeCurrent.textContent = formatTime(current);
    dom.timeTotal.textContent = formatTime(duration);
  }, 500);
}

// --- Error handling ---------------------------------------------------------

function handleError(err) {
  console.error('livedj error:', err);
  if (err.message === 'TOKEN_INVALID') {
    alert('Clé API invalide. Vérifiez vos paramètres.');
    openSettings();
  } else if (err.message === 'QUOTA_EXCEEDED') {
    setNowPlaying(null, 'Quota YouTube épuisé pour aujourd\'hui');
  } else if (err.message === 'NO_RESULTS') {
    setNowPlaying(null, 'Aucun résultat YouTube. Essai suivant...');
    setTimeout(() => prefetchAndPlay(), 2000);
  } else {
    setNowPlaying(null, `Erreur : ${err.message}`);
  }
}

// --- YouTube Player ---------------------------------------------------------

window.onYouTubeIframeAPIReady = function () {
  state.player = new YT.Player('yt-player', {
    height: '1',
    width: '1',
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      rel: 0
    },
    events: {
      onReady: function () {
        state.ytReady = true;
        if (state.pendingVideoId) {
          state.player.loadVideoById(state.pendingVideoId);
          state.pendingVideoId = null;
        }
      },
      onStateChange: onPlayerStateChange,
      onError: onPlayerError
    }
  });
};

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    state.isPaused = false;
    dom.btnPause.innerHTML = '&#9646;&#9646;';
    dom.btnPause.title = 'Pause';
    startProgressTracking();
  }
  if (event.data === YT.PlayerState.ENDED) {
    clearInterval(state.progressInterval);
    playNext();
  }
}

function onPlayerError(event) {
  console.warn('YouTube player error:', event.data, '- trying fallback');
  const provider = musicProviders[state.config.musicProvider];
  const fallback = provider.getNextVideoId();
  if (fallback) {
    playVideoById(fallback);
  } else {
    // Tous les résultats ont échoué, on demande un autre morceau à l'IA
    console.warn('All video results failed, asking AI for another track');
    setNowPlaying(state.currentTrack, 'Vidéo indisponible, morceau suivant...');
    setTimeout(() => {
      clearInterval(state.progressInterval);
      prefetchAndPlay();
    }, 1000);
  }
}

// --- Event listeners --------------------------------------------------------

function bindEvents() {
  // Home: PLAY
  dom.formHome.addEventListener('submit', (e) => {
    e.preventDefault();
    const vibe = dom.inputVibeHome.value.trim();
    if (!vibe) return;
    if (!hasValidConfig()) {
      openSettings();
      return;
    }
    startPlaying(vibe);
  });

  // Player: change vibe
  dom.formVibe.addEventListener('submit', (e) => {
    e.preventDefault();
    changeVibe(dom.inputVibePlayer.value);
  });

  // Pause / Play
  dom.btnPause.addEventListener('click', () => {
    if (!state.player || !state.ytReady) return;
    if (state.isPaused) {
      state.player.playVideo();
      state.isPaused = false;
      dom.btnPause.innerHTML = '&#9646;&#9646;';
      dom.btnPause.title = 'Pause';
    } else {
      state.player.pauseVideo();
      state.isPaused = true;
      dom.btnPause.innerHTML = '&#9654;';
      dom.btnPause.title = 'Lecture';
    }
  });

  // Seek (clic sur la barre de progression)
  dom.progressBar.addEventListener('click', (e) => {
    if (!state.player || !state.ytReady) return;
    const duration = state.player.getDuration();
    if (!duration) return;
    const rect = dom.progressBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    state.player.seekTo(pct * duration, true);
  });

  // Next
  dom.btnNext.addEventListener('click', () => {
    clearInterval(state.progressInterval);
    playNext();
  });

  // Reroll
  dom.btnReroll.addEventListener('click', reroll);

  // Settings: open
  dom.btnOpenSettings.addEventListener('click', openSettings);
  dom.btnOpenSettingsPlayer.addEventListener('click', openSettings);

  // Settings: save
  dom.btnSaveSettings.addEventListener('click', () => {
    const config = {
      aiProvider: dom.selectAi.value,
      musicProvider: dom.selectMusic.value,
      tokens: {
        ...state.config.tokens,
        [dom.selectAi.value]: dom.inputAiToken.value.trim(),
        [dom.selectMusic.value]: dom.inputMusicToken.value.trim()
      }
    };

    if (!config.tokens[config.aiProvider] || !config.tokens[config.musicProvider]) {
      alert('Les deux clés API sont requises.');
      return;
    }

    saveConfig(config);
    closeSettings();
  });

  // Settings: cancel / backdrop
  dom.btnCancelSettings.addEventListener('click', closeSettings);
  dom.modalBackdrop.addEventListener('click', closeSettings);
}

// --- Bootstrap --------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();
  bindEvents();

  const saved = loadConfig();
  if (saved) {
    state.config = saved;
  }

  if (!hasValidConfig()) {
    showView('home');
    openSettings();
  } else {
    showView('home');
  }
});
