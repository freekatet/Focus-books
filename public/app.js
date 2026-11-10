/**
 * FocusBooks — Cognitive Audio-Visual Reader Application Controller
 *
 * Manages:
 * - All 5 Cognitive Display Modes (Bionic, Syntactic Chunking, RSVP+ORP, Karaoke Spotlight, Paced Teleprompter)
 * - Persistent Multi-Book Library & Automatic Playhead Memory (Chapter, Word Index, YouTube Timestamp, Speed, Mode)
 * - Multi-Stream Audio Pipeline:
 *     * Option C: YouTube Audiobook Stream + Exact Word-Level `json3` Timestamps (Standalone or EPUB Forced Alignment)
 *     * Option B: Web Speech API (`SpeechSynthesisUtterance` + `onboundary` + 60Hz `requestAnimationFrame`)
 *     * Option A: OpenAI Cloud Audio TTS
 *     * Silent 60Hz Visual Pacer Clock
 * - Smooth Automatic Viewport Centering
 * - Granular Playback Speed Controls (0.9x - 1.5x presets + fine slider)
 * - Configurable 10-to-15 Minute Cognitive Focus Sprint Timer
 */

(function () {
  'use strict';

  const MODE_DESCRIPTIONS = {
    bionic:
      '<strong>Mode 1 (Bionic Reading):</strong> Bolds the initial 30%–50% fixation stem of every word to guide saccadic eye jumps while peripheral vision resolves word endings.',
    chunking:
      '<strong>Mode 2 (Syntactic Chunking):</strong> Breaks sentences into coherent 3–6 word grammatical clauses stacked vertically like poetry (max-width 400px, line-height 2.2) to prevent working memory overload.',
    rsvp:
      '<strong>Mode 3 (RSVP + ORP Anchoring):</strong> Rapid Serial Visual Presentation pinning the Optimal Recognition Point (~33% into each word, colored red) to the exact center vertical axis for zero saccadic travel.',
    karaoke:
      '<strong>Mode 4 (Dynamic Karaoke Spotlight):</strong> Synchronizes active word and phrase highlighting at 60Hz while gently dimming past words (opacity 0.45) to eliminate subvocalization lag.',
    teleprompter:
      '<strong>Mode 5 (Paced Teleprompter):</strong> Hybrid RSVP-Chunk display presenting one 3–5 word syntactic clause at a time in the center viewport for the exact duration of the spoken clause.'
  };

  const state = {
    library: {
      lastActiveBookId: 'palmer-eldritch',
      settings: {},
      books: []
    },
    book: null,
    currentChapterIndex: 1,
    parsedChapter: null,

    // Cognitive Mode & Visual Settings
    mode: 'bionic',
    bionicEnabled: true,
    bionicDelta: 0,
    stanzaAlign: 'left',
    rsvpWindowSize: 1,
    karaokeLayout: 'paragraph',
    autoScroll: true,

    // Playback & Synchronization State
    isPlaying: false,
    speed: 1.0,
    audioEngine: 'youtube', // 'youtube' | 'webspeech' | 'pacer' | 'openai'
    selectedVoiceURI: '',
    openAIKey: localStorage.getItem('focusbooks_openai_key') || '',

    activeTokenIndex: 0,
    activeChunkIndex: 0,
    activeSentenceIndex: 0,

    // High-frequency rAF & Boundary tracking
    rafId: null,
    sentenceStartPerf: 0,
    lastBoundaryPerf: 0,
    lastBoundaryEventCount: 0,
    currentUtterance: null,
    htmlAudio: new Audio(),

    // YouTube Player State
    ytApiReady: false,
    ytPlayer: null,
    ytPlayerReady: false,
    currentVideoId: '',
    ytLastReportedTimeSec: 0,
    ytLastReportedPerf: 0,

    // Cached DOM node references for O(1) 60fps updates
    domWordEls: [],
    domChunkEls: [],
    domSentenceEls: [],
    prevHighlightedTokenIdx: -1,
    prevHighlightedChunkIdx: -1,
    prevHighlightedSentenceIdx: -1,

    // Playhead Persistence Throttle
    lastProgressSavePerf: 0,
    saveProgressTimeout: null,

    // Focus Sprint Timer (10-15 min configurable)
    sprintDurationMinutes: 12,
    sprintRemainingSeconds: 12 * 60,
    sprintRunning: false,
    sprintIntervalId: null
  };

  // DOM Elements
  const el = {
    bookCoverThumb: document.getElementById('book-cover-thumb'),
    bookTitleDisplay: document.getElementById('book-title-display'),
    bookAuthorDisplay: document.getElementById('book-author-display'),
    chapterTitleDisplay: document.getElementById('chapter-title-display'),
    chapterStatsDisplay: document.getElementById('chapter-stats-display'),
    stageBookTitle: document.getElementById('stage-book-title'),
    stageChapterTitle: document.getElementById('stage-chapter-title'),
    stageChapterMeta: document.getElementById('stage-chapter-meta'),

    modeTabs: document.querySelectorAll('.mode-tab'),
    modeDescriptionText: document.getElementById('mode-description-text'),

    chkBionicStems: document.getElementById('chk-bionic-stems'),
    ctrlBionicIntensity: document.getElementById('ctrl-bionic-intensity'),
    ctrlModeChunking: document.getElementById('ctrl-mode-chunking'),
    ctrlModeRsvp: document.getElementById('ctrl-mode-rsvp'),
    ctrlModeKaraoke: document.getElementById('ctrl-mode-karaoke'),
    chkAutoscroll: document.getElementById('chk-autoscroll'),

    audioSourcePills: document.querySelectorAll('[data-audio-source]'),
    pillSourceYoutube: document.getElementById('pill-source-youtube'),

    syncStatusDot: document.getElementById('sync-status-dot'),
    syncEngineBadge: document.getElementById('sync-engine-badge'),
    telemetryWordPos: document.getElementById('telemetry-word-pos'),
    telemetryClausePos: document.getElementById('telemetry-clause-pos'),
    telemetryWpm: document.getElementById('telemetry-wpm'),

    chapterSidebar: document.getElementById('chapter-sidebar'),
    chapterList: document.getElementById('chapter-list'),
    inputSearchBook: document.getElementById('input-search-book'),

    readingViewport: document.getElementById('reading-viewport'),
    documentStage: document.getElementById('document-stage'),
    tokensContainer: document.getElementById('tokens-container'),
    rsvpStage: document.getElementById('rsvp-stage'),
    teleprompterStage: document.getElementById('teleprompter-stage'),

    // RSVP DOM
    rsvpClauseCounter: document.getElementById('rsvp-clause-counter'),
    rsvpLeftPart: document.getElementById('rsvp-left-part'),
    rsvpOrpChar: document.getElementById('rsvp-orp-char'),
    rsvpRightPart: document.getElementById('rsvp-right-part'),
    rsvpSecondWord: document.getElementById('rsvp-second-word'),
    rsvpTokenProgressBar: document.getElementById('rsvp-token-progress-bar'),
    rsvpContextSentence: document.getElementById('rsvp-context-sentence'),

    // Teleprompter DOM
    teleprompterClauseCounter: document.getElementById('teleprompter-clause-counter'),
    teleprompterPrevClause: document.getElementById('teleprompter-prev-clause'),
    teleprompterActiveClause: document.getElementById('teleprompter-active-clause'),
    teleprompterNextClause: document.getElementById('teleprompter-next-clause'),
    teleprompterProgressFill: document.getElementById('teleprompter-progress-fill'),
    teleprompterContextPara: document.getElementById('teleprompter-context-para'),

    // YouTube Dock DOM
    ytDockPanel: document.getElementById('yt-dock-panel'),
    ytTimeReadout: document.getElementById('yt-time-readout'),
    btnToggleYtMinimize: document.getElementById('btn-toggle-yt-minimize'),

    // Transport Controls
    btnPlayPause: document.getElementById('btn-play-pause'),
    iconPlay: document.getElementById('icon-play'),
    iconPause: document.getElementById('icon-pause'),
    btnPrevSentence: document.getElementById('btn-prev-sentence'),
    btnNextSentence: document.getElementById('btn-next-sentence'),
    activePhrasePreview: document.getElementById('active-phrase-preview'),
    chapterTimeRemaining: document.getElementById('chapter-time-remaining'),
    scrubberRange: document.getElementById('scrubber-range'),
    speedValueBadge: document.getElementById('speed-value-badge'),
    speedPresets: document.querySelectorAll('.speed-pill'),
    rngSpeed: document.getElementById('rng-speed'),

    // Sprint Timer
    sprintRingProgress: document.getElementById('sprint-ring-progress'),
    sprintTimeDisplay: document.getElementById('sprint-time-display'),
    btnSprintToggle: document.getElementById('btn-sprint-toggle'),
    sprintDurationSelect: document.getElementById('sprint-duration-select'),

    // Library & Modals
    libraryCountBadge: document.getElementById('library-count-badge'),
    modalLibrary: document.getElementById('modal-library'),
    libraryCardsContainer: document.getElementById('library-cards-container'),
    settingsDrawer: document.getElementById('settings-drawer'),
    selAudioMode: document.getElementById('sel-audio-mode'),
    selTtsVoice: document.getElementById('sel-tts-voice'),
    voiceSelectContainer: document.getElementById('voice-select-container'),
    cloudApiContainer: document.getElementById('cloud-api-container'),
    inputOpenaiKey: document.getElementById('input-openai-key'),
    modalImport: document.getElementById('modal-import'),
    toastBanner: document.getElementById('toast-banner')
  };

  function showToast(message, durationMs = 3400) {
    el.toastBanner.textContent = message;
    el.toastBanner.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.toastBanner.classList.add('hidden');
    }, durationMs);
  }

  function formatTimeMMSS(totalSeconds) {
    const sec = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* ============================================================================
   * 1. PERSISTENT LIBRARY & PLAYHEAD MEMORY SYSTEM
   * ============================================================================ */

  function getLocalPlayheadMap() {
    try {
      return JSON.parse(localStorage.getItem('focusbooks_playheads') || '{}');
    } catch (_) {
      return {};
    }
  }

  function savePlayheadState(immediate = false) {
    if (!state.book || !state.parsedChapter) return;

    const pc = state.parsedChapter;
    const tok = pc.tokens[state.activeTokenIndex] || pc.tokens[0];
    if (!tok) return;

    // Compute overall book percentage
    let wordsBeforeChapter = 0;
    for (let i = 0; i < state.currentChapterIndex; i++) {
      wordsBeforeChapter += state.book.chapters[i]?.wordCount || 0;
    }
    const totalBookWords = Math.max(1, state.book.totalWords || pc.tokens.length);
    const overallProgressPct = Math.min(
      100,
      Math.round(((wordsBeforeChapter + state.activeTokenIndex) / totalBookWords) * 1000) / 10
    );

    const progressObj = {
      chapterIndex: state.currentChapterIndex,
      chapterTitle: pc.title,
      tokenIndex: state.activeTokenIndex,
      videoTimeMs: tok.startMs || 0,
      overallProgressPct,
      speed: state.speed,
      mode: state.mode,
      audioEngine: state.audioEngine,
      updatedAt: new Date().toISOString()
    };

    // 1. Save immediately in localStorage
    const map = getLocalPlayheadMap();
    map[state.book.id] = progressObj;
    localStorage.setItem('focusbooks_playheads', JSON.stringify(map));
    localStorage.setItem('focusbooks_last_book_id', state.book.id);

    // Update in-memory library entry
    const entry = state.library.books.find((b) => b.id === state.book.id);
    if (entry) {
      entry.progress = progressObj;
    }

    // 2. Sync to server `/api/library/progress` (debounced or immediate)
    const now = performance.now();
    if (!immediate && now - state.lastProgressSavePerf < 2200) {
      clearTimeout(state.saveProgressTimeout);
      state.saveProgressTimeout = setTimeout(() => savePlayheadState(true), 2200);
      return;
    }

    state.lastProgressSavePerf = now;
    clearTimeout(state.saveProgressTimeout);

    const payload = {
      bookId: state.book.id,
      progress: progressObj,
      settings: {
        theme: document.documentElement.getAttribute('data-theme') || 'bw-dark',
        bionicEnabled: state.bionicEnabled,
        bionicDelta: state.bionicDelta
      }
    };

    fetch('/api/library/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  async function fetchLibraryIndex() {
    const localMap = getLocalPlayheadMap();
    const idbBooks = await window.EpubLoader.getAllBooksFromIndexedDB();

    let baseLib = null;
    try {
      const res = await fetch('./api/library');
      if (res.ok) {
        baseLib = await res.json();
      }
    } catch (_) {}

    if (!baseLib) {
      try {
        const res = await fetch('./books/library.json');
        if (res.ok) {
          baseLib = await res.json();
        }
      } catch (_) {}
    }

    if (!baseLib) {
      baseLib = {
        lastActiveBookId: 'palmer-eldritch',
        settings: {},
        books: [
          {
            id: 'palmer-eldritch',
            title: 'The Three Stigmata of Palmer Eldritch',
            author: 'Philip K. Dick',
            coverUrl: './books/palmer-eldritch/cover.jpeg',
            sourceType: 'epub+youtube',
            youtubeVideoId: 'wlKEAxiQsDU',
            youtubeUrl: 'https://www.youtube.com/watch?v=wlKEAxiQsDU',
            totalWords: 70414,
            chapterCount: 15,
            dataUrl: './books/palmer-eldritch/book.json',
            progress: {
              chapterIndex: 1,
              chapterTitle: 'Chapter ONE',
              tokenIndex: 0,
              videoTimeMs: 30800,
              overallProgressPct: 0,
              speed: 1.0,
              mode: 'bionic',
              audioEngine: 'youtube',
              updatedAt: new Date(0).toISOString()
            }
          }
        ]
      };
    }

    // Normalize any leading slash in dataUrl/coverUrl for GitHub Pages subpath compatibility
    for (const b of baseLib.books) {
      if (b.dataUrl && b.dataUrl.startsWith('/')) b.dataUrl = '.' + b.dataUrl;
      if (b.coverUrl && b.coverUrl.startsWith('/')) b.coverUrl = '.' + b.coverUrl;
    }

    // Merge books saved in browser IndexedDB (for serverless iOS / GitHub Pages usage)
    for (const idbBook of idbBooks) {
      const existingIdx = baseLib.books.findIndex((b) => b.id === idbBook.id);
      const startChapIdx =
        idbBook.chapters && idbBook.chapters.length > 1 && idbBook.chapters[0].title === 'Epigraph' ? 1 : 0;
      const firstChap = idbBook.chapters?.[startChapIdx] || idbBook.chapters?.[0] || { title: 'Chapter 1', videoStartMs: 0 };

      const summary = {
        id: idbBook.id,
        title: idbBook.title || 'Untitled Book',
        author: idbBook.author || 'Unknown Author',
        coverUrl: idbBook.coverUrl || './books/palmer-eldritch/cover.jpeg',
        sourceType: idbBook.sourceType || (idbBook.youtubeVideoId ? 'epub+youtube' : 'epub'),
        youtubeVideoId: idbBook.youtubeVideoId || '',
        youtubeUrl: idbBook.youtubeUrl || '',
        totalWords: idbBook.totalWords || 0,
        chapterCount: idbBook.chapters ? idbBook.chapters.length : 1,
        fromIndexedDB: true,
        progress: localMap[idbBook.id] || {
          chapterIndex: startChapIdx,
          chapterTitle: firstChap.title || 'Chapter 1',
          tokenIndex: 0,
          videoTimeMs: firstChap.videoStartMs || 0,
          overallProgressPct: 0,
          speed: 1.0,
          mode: 'bionic',
          audioEngine: idbBook.youtubeVideoId ? 'youtube' : 'webspeech',
          updatedAt: new Date().toISOString()
        }
      };

      if (existingIdx >= 0) {
        baseLib.books[existingIdx] = { ...baseLib.books[existingIdx], ...summary };
      } else {
        baseLib.books.unshift(summary);
      }
    }

    // Overlay latest playhead positions from localStorage
    for (const b of baseLib.books) {
      if (localMap[b.id] && (!b.progress || localMap[b.id].updatedAt >= (b.progress.updatedAt || ''))) {
        b.progress = localMap[b.id];
      }
    }

    state.library = baseLib;
    el.libraryCountBadge.textContent = String(baseLib.books.length);
    return baseLib;
  }

  async function saveBookToServerLibrary(bookData, sourceType) {
    // 1. Always save into browser IndexedDB so iOS / GitHub Pages works 100% without a computer
    await window.EpubLoader.saveBookToIndexedDB(bookData, sourceType);

    // 2. Also sync to local server if running
    try {
      const res = await fetch('./api/library/save-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book: bookData, sourceType })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.library) {
          state.library = data.library;
          el.libraryCountBadge.textContent = String(state.library.books.length);
          return;
        }
      }
    } catch (_) {}

    await fetchLibraryIndex();
  }

  function normalizeRelativeAssetUrl(url) {
    if (!url) return '';
    if (url.startsWith('/books/')) return '.' + url;
    return url;
  }

  function renderLibraryModal() {
    el.libraryCardsContainer.innerHTML = '';
    const books = state.library.books || [];
    el.libraryCountBadge.textContent = String(books.length);

    if (books.length === 0) {
      el.libraryCardsContainer.innerHTML = `<div class="import-box">No books in library yet. Click "+ Import" to add an EPUB or YouTube Audiobook.</div>`;
      return;
    }

    const sourceLabels = {
      'epub+youtube': 'EPUB + YouTube Sync',
      youtube: 'YouTube Captions',
      epub: 'Apple Books / EPUB',
      text: 'Custom Text'
    };

    books.forEach((b) => {
      const isCurrent = state.book && state.book.id === b.id;
      const prog = b.progress || { chapterIndex: 0, chapterTitle: 'Chapter 1', tokenIndex: 0, overallProgressPct: 0, videoTimeMs: 0 };
      const pct = prog.overallProgressPct || 0;
      const timeStr = prog.videoTimeMs ? ` · Audio ${formatTimeMMSS(prog.videoTimeMs / 1000)}` : '';
      const coverSrc = normalizeRelativeAssetUrl(b.coverUrl) || './books/palmer-eldritch/cover.jpeg';

      const card = document.createElement('div');
      card.className = 'library-card' + (isCurrent ? ' active-book' : '');
      card.innerHTML = `
        <div class="library-card-left">
          <img src="${coverSrc}" alt="Cover" class="library-cover" />
          <div class="library-info">
            <div class="library-title-row">
              <span class="library-book-title">${escapeHtml(b.title)}</span>
              <span class="library-source-badge">${sourceLabels[b.sourceType] || 'Book'}</span>
            </div>
            <div class="library-author">${escapeHtml(b.author || '')} · ${(b.totalWords || 0).toLocaleString()} words · ${b.chapterCount || 1} chapters</div>
            <div class="library-playhead-meta">
              Saved Playhead: <strong>${escapeHtml(prog.chapterTitle || `Chapter ${prog.chapterIndex + 1}`)}</strong> · Word ${(prog.tokenIndex || 0) + 1}${timeStr} (${pct}%)
            </div>
            <div class="library-progress-track">
              <div class="library-progress-fill" style="width: ${Math.max(2, pct)}%"></div>
            </div>
          </div>
        </div>
        <div class="library-card-actions">
          <button class="primary-btn btn-resume-book" data-book-id="${b.id}">
            ${isCurrent ? '▶ Active' : '▶ Resume'}
          </button>
          ${
            b.id !== 'palmer-eldritch'
              ? `<button class="secondary-btn btn-delete-book" data-book-id="${b.id}" title="Remove from Library">✕</button>`
              : ''
          }
        </div>
      `;

      card.querySelector('.btn-resume-book').addEventListener('click', async () => {
        if (isCurrent) {
          el.modalLibrary.classList.add('hidden');
          return;
        }
        try {
          showToast(`Loading "${b.title}"...`);
          let fullBook = await window.EpubLoader.getBookFromIndexedDB(b.id);
          if (!fullBook && b.dataUrl) {
            const res = await fetch(normalizeRelativeAssetUrl(b.dataUrl));
            if (res.ok) fullBook = await res.json();
          }
          if (!fullBook) throw new Error('Could not load saved book data');
          loadBookWithSavedPlayhead(fullBook, b.progress);
          el.modalLibrary.classList.add('hidden');
        } catch (err) {
          showToast(`Error loading book: ${err.message}`);
        }
      });

      const delBtn = card.querySelector('.btn-delete-book');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          await window.EpubLoader.deleteBookFromIndexedDB(b.id);
          try {
            const res = await fetch(`./api/library/book?id=${encodeURIComponent(b.id)}`, { method: 'DELETE' });
            if (res.ok) {
              state.library = await res.json();
            }
          } catch (_) {}
          await fetchLibraryIndex();
          renderLibraryModal();
        });
      }

      el.libraryCardsContainer.appendChild(card);
    });
  }

  /* ============================================================================
   * 2. INITIALIZATION & YOUTUBE IFRAME API SETUP
   * ============================================================================ */

  async function initApp() {
    bindUIEvents();
    initVoices();
    loadYouTubeIframeAPI();
    updateSprintTimerDisplay();

    // Register Service Worker for offline iOS PWA support & auto-refresh when updated
    if ('serviceWorker' in navigator) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
      navigator.serviceWorker
        .register('./sw.js?v=6')
        .then((reg) => reg.update())
        .catch(() => {});
    }

    // Flush playhead state if user closes or refreshes tab
    window.addEventListener('beforeunload', () => {
      savePlayheadState(true);
    });

    const lib = await fetchLibraryIndex();
    const preferredBookId = localStorage.getItem('focusbooks_last_book_id') || lib.lastActiveBookId || 'palmer-eldritch';
    const targetEntry = lib.books.find((b) => b.id === preferredBookId) || lib.books[0];

    if (targetEntry) {
      try {
        let bookData = await window.EpubLoader.getBookFromIndexedDB(targetEntry.id);
        if (!bookData && targetEntry.dataUrl) {
          const res = await fetch(normalizeRelativeAssetUrl(targetEntry.dataUrl));
          if (res.ok) bookData = await res.json();
        }
        if (bookData) {
          const localMap = getLocalPlayheadMap();
          const savedProg = localMap[bookData.id] || targetEntry.progress;
          loadBookWithSavedPlayhead(bookData, savedProg);
          return;
        }
      } catch (_) {}
    }

    // Fallback to default Palmer Eldritch
    try {
      const res = await fetch('./books/palmer-eldritch/book.json');
      if (res.ok) {
        const bookData = await res.json();
        loadBookWithSavedPlayhead(bookData, null);
      }
    } catch (_) {}
  }

  function loadBookWithSavedPlayhead(bookData, savedProgress) {
    stopPlayback();
    state.book = bookData;

    el.bookTitleDisplay.textContent = bookData.title || 'Untitled Book';
    el.bookAuthorDisplay.textContent = bookData.author || '';
    el.stageBookTitle.textContent = (bookData.title || 'BOOK').toUpperCase();

    if (bookData.coverUrl) {
      el.bookCoverThumb.src = normalizeRelativeAssetUrl(bookData.coverUrl);
      el.bookCoverThumb.classList.remove('hidden');
    } else {
      el.bookCoverThumb.classList.add('hidden');
    }

    // Restore saved cognitive mode, speed, and audio engine if available
    if (savedProgress) {
      if (savedProgress.mode && MODE_DESCRIPTIONS[savedProgress.mode]) {
        state.mode = savedProgress.mode;
      }
      if (typeof savedProgress.speed === 'number') {
        setSpeed(savedProgress.speed, false);
      }
    }

    if (bookData.youtubeVideoId) {
      el.pillSourceYoutube.classList.remove('hidden');
      const preferredEngine = savedProgress?.audioEngine || 'youtube';
      setAudioEngine(preferredEngine);
    } else {
      el.pillSourceYoutube.classList.add('hidden');
      const preferredEngine =
        savedProgress?.audioEngine && savedProgress.audioEngine !== 'youtube'
          ? savedProgress.audioEngine
          : 'webspeech';
      setAudioEngine(preferredEngine);
    }

    renderChapterList();

    const defaultChapIdx = bookData.chapters.length > 1 && bookData.chapters[0].title === 'Epigraph' ? 1 : 0;
    const chapIdx =
      savedProgress && typeof savedProgress.chapterIndex === 'number'
        ? Math.min(Math.max(0, savedProgress.chapterIndex), bookData.chapters.length - 1)
        : defaultChapIdx;

    const initialTokenIdx = savedProgress && typeof savedProgress.tokenIndex === 'number' ? savedProgress.tokenIndex : 0;

    selectChapter(chapIdx, initialTokenIdx);

    if (savedProgress && (savedProgress.tokenIndex > 0 || chapIdx !== defaultChapIdx)) {
      const tok = state.parsedChapter?.tokens[state.activeTokenIndex];
      const timeTag = tok && state.parsedChapter.hasExactTimestamps ? ` (${formatTimeMMSS(tok.startMs / 1000)})` : '';
      showToast(`Resumed "${bookData.title}" at ${state.parsedChapter.title} · Word ${state.activeTokenIndex + 1}${timeTag}`);
    }
  }

  function loadYouTubeIframeAPI() {
    if (window.YT && window.YT.Player) {
      state.ytApiReady = true;
      return;
    }
    window.onYouTubeIframeAPIReady = () => {
      state.ytApiReady = true;
      if (state.book && state.book.youtubeVideoId) {
        const activeTok = state.parsedChapter?.tokens[state.activeTokenIndex];
        const startSec = activeTok ? activeTok.startMs / 1000 : (state.parsedChapter?.videoStartMs || 0) / 1000;
        initOrCueYouTubePlayer(state.book.youtubeVideoId, startSec);
      }
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  function initOrCueYouTubePlayer(videoId, startSeconds = 0) {
    if (!videoId) {
      el.ytDockPanel.classList.add('hidden');
      return;
    }

    el.ytDockPanel.classList.toggle('hidden', state.audioEngine !== 'youtube');

    if (!state.ytApiReady) {
      state.currentVideoId = videoId;
      return;
    }

    if (state.ytPlayer && state.ytPlayerReady) {
      if (state.currentVideoId !== videoId) {
        state.currentVideoId = videoId;
        state.ytPlayer.cueVideoById({ videoId, startSeconds });
      } else if (!state.isPlaying) {
        state.ytPlayer.seekTo(startSeconds, true);
      }
      return;
    }

    state.currentVideoId = videoId;
    state.ytPlayer = new window.YT.Player('yt-iframe-mount', {
      width: '280',
      height: '158',
      videoId,
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        start: Math.floor(startSeconds)
      },
      events: {
        onReady: () => {
          state.ytPlayerReady = true;
          const activeTok = state.parsedChapter?.tokens[state.activeTokenIndex];
          const targetSec = activeTok ? activeTok.startMs / 1000 : startSeconds;
          if (targetSec > 0) {
            state.ytPlayer.seekTo(targetSec, true);
            state.ytPlayer.pauseVideo();
          }
          state.ytPlayer.setPlaybackRate(state.speed);
        },
        onStateChange: (event) => {
          if (state.audioEngine !== 'youtube' || state.usingNativeChapterAudio) return;

          if (event.data === 1) {
            if (!state.isPlaying) {
              state.isPlaying = true;
              el.iconPlay.classList.add('hidden');
              el.iconPause.classList.remove('hidden');
              el.syncStatusDot.classList.add('playing');
              updateLockScreenMediaSession();
              runYouTubeSyncLoop();
            }
          } else if (event.data === 2 && state.isPlaying) {
            // Ignore transitional pause events fired right after seekTo() + playVideo()
            if (performance.now() - (state.lastPlayCommandPerf || 0) < 1200) {
              try {
                state.ytPlayer.playVideo();
              } catch (_) {}
              return;
            }
            // If phone just went to Lock Screen, do not kill playback state
            if (document.hidden || document.visibilityState === 'hidden') {
              try {
                state.ytPlayer.playVideo();
              } catch (_) {}
              return;
            }
            stopPlayback();
          } else if (event.data === 0 && state.isPlaying) {
            if (state.book && state.currentChapterIndex < state.book.chapters.length - 1) {
              selectChapter(state.currentChapterIndex + 1, 0);
              startPlayback();
            } else {
              stopPlayback();
            }
          }
        }
      }
    });
  }

  function setAudioEngine(engineName) {
    const wasPlaying = state.isPlaying;
    if (wasPlaying) stopPlayback();

    state.audioEngine = engineName;
    el.selAudioMode.value = engineName;

    el.audioSourcePills.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.audioSource === engineName);
    });

    el.voiceSelectContainer.classList.toggle('hidden', engineName !== 'webspeech');
    el.cloudApiContainer.classList.toggle('hidden', engineName !== 'openai');
    el.ytDockPanel.classList.toggle('hidden', engineName !== 'youtube' || !state.book?.youtubeVideoId);

    const badges = {
      youtube: 'YouTube json3 + 60Hz rAF',
      webspeech: 'Web Speech onboundary + 60Hz rAF',
      pacer: '60Hz Visual Pacer Clock',
      openai: 'OpenAI Audio + 60Hz rAF'
    };
    el.syncEngineBadge.textContent = badges[engineName] || '60Hz rAF Sync';

    if (wasPlaying) {
      startPlayback();
    }
  }

  /* ============================================================================
   * 3. CHAPTER SELECTION & COGNITIVE DOM RENDERING
   * ============================================================================ */

  function renderChapterList() {
    el.chapterList.innerHTML = '';
    if (!state.book || !state.book.chapters) return;

    state.book.chapters.forEach((chap, idx) => {
      const li = document.createElement('li');
      li.className = 'chapter-item' + (idx === state.currentChapterIndex ? ' active' : '');
      const timeBadge =
        typeof chap.videoStartMs === 'number'
          ? `${formatTimeMMSS(chap.videoStartMs / 1000)} · ${chap.wordCount.toLocaleString()}w`
          : `${chap.wordCount.toLocaleString()}w`;
      li.innerHTML = `
        <span>${chap.title}</span>
        <span class="chapter-item-words">${timeBadge}</span>
      `;
      li.addEventListener('click', () => {
        selectChapter(idx, 0);
        savePlayheadState(true);
      });
      el.chapterList.appendChild(li);
    });
  }

  function selectChapter(chapterIdx, initialTokenIndex = 0) {
    if (!state.book || !state.book.chapters[chapterIdx]) return;
    const wasPlaying = state.isPlaying;
    stopPlayback();

    state.currentChapterIndex = chapterIdx;
    const rawChapter = state.book.chapters[chapterIdx];

    state.parsedChapter = window.CognitiveEngine.parseChapterCognitive(rawChapter);

    Array.from(el.chapterList.children).forEach((li, i) => {
      li.classList.toggle('active', i === chapterIdx);
    });

    const wordCount = state.parsedChapter.tokens.length;
    const estMinutes = Math.max(1, Math.round(state.parsedChapter.totalDurationMs / 60000 / state.speed));
    const syncTag = state.parsedChapter.hasExactTimestamps ? ' · YouTube Timestamp Sync Ready' : '';

    el.chapterTitleDisplay.textContent = rawChapter.title;
    el.chapterStatsDisplay.textContent = `${wordCount.toLocaleString()} words`;
    el.stageChapterTitle.textContent = rawChapter.title;
    el.stageChapterMeta.textContent = `${wordCount.toLocaleString()} words · ${state.parsedChapter.sentences.length} sentences · ${state.parsedChapter.chunks.length} syntactic clauses · ~${estMinutes} min${syncTag}`;

    buildChapterDOM();
    const safeTokenIdx = Math.min(Math.max(0, initialTokenIndex), Math.max(0, wordCount - 1));
    setActiveToken(safeTokenIdx, { scrollIntoView: safeTokenIdx > 0, forceStageUpdate: true });
    if (safeTokenIdx === 0) {
      el.readingViewport.scrollTop = 0;
    }

    if (state.book.youtubeVideoId && state.parsedChapter.hasExactTimestamps) {
      const targetTok = state.parsedChapter.tokens[safeTokenIdx] || state.parsedChapter.tokens[0];
      const startSec = (targetTok?.startMs || 0) / 1000;
      initOrCueYouTubePlayer(state.book.youtubeVideoId, startSec);
      el.ytTimeReadout.textContent = formatTimeMMSS(startSec);
    }

    if (wasPlaying) {
      startPlayback();
    }
  }

  function renderBionicWordInnerHTML(token) {
    const parts =
      state.bionicDelta === 0
        ? token.bionic
        : window.CognitiveEngine.computeBionicParts(token.raw, state.bionicDelta);
    return `${escapeHtml(parts.prefix)}<span class="fixation">${escapeHtml(parts.fixation)}</span><span class="remainder">${escapeHtml(parts.remainder)}${escapeHtml(parts.suffix)}</span>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildChapterDOM() {
    const pc = state.parsedChapter;
    if (!pc) return;

    state.domWordEls = new Array(pc.tokens.length);
    state.domChunkEls = new Array(pc.chunks.length);
    state.domSentenceEls = new Array(pc.sentences.length);
    state.prevHighlightedTokenIdx = -1;
    state.prevHighlightedChunkIdx = -1;
    state.prevHighlightedSentenceIdx = -1;

    const frag = document.createDocumentFragment();

    for (const para of pc.paragraphs) {
      const pEl = document.createElement('div');
      pEl.className = 'reader-paragraph';
      pEl.dataset.paraIdx = para.index;

      for (const sIdx of para.sentenceIndices) {
        const sentence = pc.sentences[sIdx];
        const sEl = document.createElement('span');
        sEl.className = 'reader-sentence';
        sEl.dataset.sentenceIdx = sIdx;

        for (const cIdx of sentence.chunkIndices) {
          const chunk = pc.chunks[cIdx];
          const cEl = document.createElement('span');
          cEl.className = 'syntactic-chunk';
          cEl.dataset.chunkIdx = cIdx;

          for (let i = 0; i < chunk.tokenIndices.length; i++) {
            const tIdx = chunk.tokenIndices[i];
            const token = pc.tokens[tIdx];

            const wEl = document.createElement('span');
            wEl.className = 'word upcoming-word';
            wEl.dataset.tokenIdx = tIdx;
            wEl.innerHTML = renderBionicWordInnerHTML(token);

            state.domWordEls[tIdx] = wEl;
            cEl.appendChild(wEl);
            cEl.appendChild(document.createTextNode(' '));
          }

          state.domChunkEls[cIdx] = cEl;
          sEl.appendChild(cEl);
        }

        state.domSentenceEls[sIdx] = sEl;
        pEl.appendChild(sEl);
      }

      frag.appendChild(pEl);
    }

    el.tokensContainer.innerHTML = '';
    el.tokensContainer.appendChild(frag);
    applyVisualModeClasses();
  }

  function refreshBionicStemsInDOM() {
    const pc = state.parsedChapter;
    if (!pc) return;
    for (let i = 0; i < pc.tokens.length; i++) {
      const wEl = state.domWordEls[i];
      if (wEl) {
        wEl.innerHTML = renderBionicWordInnerHTML(pc.tokens[i]);
      }
    }
  }

  function applyVisualModeClasses() {
    el.modeTabs.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    const modeBadgeMap = {
      bionic: 'Options · Mode 1 (Bionic)',
      chunking: 'Options · Mode 2 (Stanza)',
      rsvp: 'Options · Mode 3 (RSVP)',
      karaoke: 'Options · Mode 4 (Karaoke)',
      teleprompter: 'Options · Mode 5 (Prompter)'
    };
    const lblActiveModeBtn = document.getElementById('lbl-active-mode-btn');
    if (lblActiveModeBtn) {
      lblActiveModeBtn.textContent = modeBadgeMap[state.mode] || 'Options';
    }

    el.modeDescriptionText.innerHTML = MODE_DESCRIPTIONS[state.mode] || '';

    el.ctrlModeChunking.classList.toggle('hidden', state.mode !== 'chunking');
    el.ctrlModeRsvp.classList.toggle('hidden', state.mode !== 'rsvp');
    el.ctrlModeKaraoke.classList.toggle('hidden', state.mode !== 'karaoke');

    const isDocStage = state.mode === 'bionic' || state.mode === 'chunking' || state.mode === 'karaoke';
    el.documentStage.classList.toggle('hidden', !isDocStage);
    el.rsvpStage.classList.toggle('hidden', state.mode !== 'rsvp');
    el.teleprompterStage.classList.toggle('hidden', state.mode !== 'teleprompter');

    el.documentStage.classList.remove('mode-bionic', 'mode-chunking', 'mode-karaoke', 'stanza-center', 'karaoke-stanza');
    if (isDocStage) {
      el.documentStage.classList.add(`mode-${state.mode}`);
    }
    if (state.mode === 'chunking' && state.stanzaAlign === 'center') {
      el.documentStage.classList.add('stanza-center');
    }
    if (state.mode === 'karaoke' && state.karaokeLayout === 'stanza') {
      el.documentStage.classList.add('karaoke-stanza');
    }

    el.documentStage.classList.toggle('bionic-enabled', state.bionicEnabled);
    el.teleprompterStage.classList.toggle('bionic-enabled', state.bionicEnabled);
    el.rsvpStage.classList.toggle('bionic-enabled', state.bionicEnabled);

    if (state.mode === 'karaoke') {
      syncKaraokePastUpcomingClasses(state.activeTokenIndex);
    }

    setActiveToken(state.activeTokenIndex, { scrollIntoView: state.autoScroll, forceStageUpdate: true });
  }

  function syncKaraokePastUpcomingClasses(activeIdx) {
    const words = state.domWordEls;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w) continue;
      if (i < activeIdx) {
        w.classList.add('past-word');
        w.classList.remove('upcoming-word');
      } else if (i > activeIdx) {
        w.classList.add('upcoming-word');
        w.classList.remove('past-word');
      } else {
        w.classList.remove('past-word', 'upcoming-word');
      }
    }
  }

  /* ============================================================================
   * 4. HIGH-FREQUENCY ACTIVE TOKEN & STAGE UPDATER (O(1) DOM UPDATES)
   * ============================================================================ */

  function setActiveToken(tokenIndex, options = {}) {
    const pc = state.parsedChapter;
    if (!pc || pc.tokens.length === 0) return;

    const clampedIdx = Math.max(0, Math.min(pc.tokens.length - 1, tokenIndex));
    const token = pc.tokens[clampedIdx];
    const prevIdx = state.prevHighlightedTokenIdx;

    const tokenChanged = clampedIdx !== prevIdx || options.forceStageUpdate;
    state.activeTokenIndex = clampedIdx;
    state.activeChunkIndex = token.chunkIndex;
    state.activeSentenceIndex = token.sentenceIndex;

    if (!tokenChanged) return;

    if (prevIdx >= 0 && state.domWordEls[prevIdx]) {
      const prevEl = state.domWordEls[prevIdx];
      prevEl.classList.remove('active-word');
      if (clampedIdx > prevIdx) {
        prevEl.classList.add('past-word');
        prevEl.classList.remove('upcoming-word');
      } else {
        prevEl.classList.add('upcoming-word');
        prevEl.classList.remove('past-word');
      }
    }

    if (prevIdx >= 0 && Math.abs(clampedIdx - prevIdx) > 1) {
      const start = Math.min(clampedIdx, prevIdx);
      const end = Math.max(clampedIdx, prevIdx);
      for (let i = start; i <= end; i++) {
        const w = state.domWordEls[i];
        if (!w) continue;
        if (i < clampedIdx) {
          w.classList.add('past-word');
          w.classList.remove('upcoming-word');
        } else if (i > clampedIdx) {
          w.classList.add('upcoming-word');
          w.classList.remove('past-word');
        }
      }
    }

    const activeWordEl = state.domWordEls[clampedIdx];
    if (activeWordEl) {
      activeWordEl.classList.add('active-word');
      activeWordEl.classList.remove('past-word', 'upcoming-word');
    }
    state.prevHighlightedTokenIdx = clampedIdx;

    if (state.prevHighlightedChunkIdx !== token.chunkIndex) {
      if (state.prevHighlightedChunkIdx >= 0 && state.domChunkEls[state.prevHighlightedChunkIdx]) {
        state.domChunkEls[state.prevHighlightedChunkIdx].classList.remove('active-chunk');
      }
      if (state.domChunkEls[token.chunkIndex]) {
        state.domChunkEls[token.chunkIndex].classList.add('active-chunk');
      }
      state.prevHighlightedChunkIdx = token.chunkIndex;

      if (state.mode === 'teleprompter') {
        renderTeleprompterClause(token.chunkIndex, clampedIdx);
      }
    } else if (state.mode === 'teleprompter') {
      updateTeleprompterActiveWordOnly(clampedIdx);
    }

    if (state.prevHighlightedSentenceIdx !== token.sentenceIndex || options.forceStageUpdate) {
      if (state.prevHighlightedSentenceIdx >= 0 && state.domSentenceEls[state.prevHighlightedSentenceIdx]) {
        state.domSentenceEls[state.prevHighlightedSentenceIdx].classList.remove('active-sentence');
      }
      const activeSentEl = state.domSentenceEls[token.sentenceIndex];
      if (activeSentEl) {
        activeSentEl.classList.add('active-sentence');
        if (options.scrollIntoView !== false && state.autoScroll) {
          centerElementInViewport(
            state.mode === 'chunking' ? state.domChunkEls[token.chunkIndex] || activeSentEl : activeSentEl
          );
        }
      }
      state.prevHighlightedSentenceIdx = token.sentenceIndex;
    } else if (state.mode === 'chunking' && options.scrollIntoView !== false && state.autoScroll) {
      const activeChunkEl = state.domChunkEls[token.chunkIndex];
      if (activeChunkEl) centerElementInViewport(activeChunkEl);
    }

    if (state.mode === 'rsvp') {
      renderRSVPWord(clampedIdx);
    }

    if (state.mode === 'teleprompter' && options.forceStageUpdate) {
      renderTeleprompterClause(token.chunkIndex, clampedIdx);
    }

    updateTelemetryAndScrubber(clampedIdx);
    savePlayheadState(false);
  }

  function centerElementInViewport(targetEl) {
    if (!targetEl || !el.readingViewport) return;
    const viewport = el.readingViewport;
    const viewRect = viewport.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const offsetInsideViewport = targetRect.top - viewRect.top;
    const desiredOffset = viewRect.height * 0.42 - targetRect.height / 2;
    const delta = offsetInsideViewport - desiredOffset;

    if (Math.abs(delta) > 36) {
      viewport.scrollTo({
        top: viewport.scrollTop + delta,
        behavior: 'smooth'
      });
    }
  }

  function renderRSVPWord(tokenIdx) {
    const pc = state.parsedChapter;
    const token = pc.tokens[tokenIdx];
    if (!token) return;

    const { left, orp, right } = token.orp;
    el.rsvpLeftPart.textContent = left;
    el.rsvpOrpChar.textContent = orp;
    el.rsvpRightPart.textContent = right;

    if (state.rsvpWindowSize === 2 && pc.tokens[tokenIdx + 1] && pc.tokens[tokenIdx + 1].sentenceIndex === token.sentenceIndex) {
      el.rsvpSecondWord.textContent = pc.tokens[tokenIdx + 1].raw;
      el.rsvpSecondWord.classList.remove('hidden');
    } else {
      el.rsvpSecondWord.classList.add('hidden');
    }

    el.rsvpClauseCounter.textContent = `Sentence ${token.sentenceIndex + 1} of ${pc.sentences.length} · Word ${tokenIdx + 1}`;

    const sentence = pc.sentences[token.sentenceIndex];
    if (sentence) {
      el.rsvpContextSentence.innerHTML = sentence.tokenIndices
        .map((tIdx) => {
          const t = pc.tokens[tIdx];
          const cls = tIdx === tokenIdx ? 'word active-word' : tIdx < tokenIdx ? 'word past-word' : 'word';
          return `<span class="${cls}" data-token-idx="${tIdx}">${renderBionicWordInnerHTML(t)}</span>`;
        })
        .join(' ');
    }
  }

  function renderTeleprompterClause(chunkIdx, activeTokenIdx) {
    const pc = state.parsedChapter;
    const chunk = pc.chunks[chunkIdx];
    if (!chunk) return;

    el.teleprompterClauseCounter.textContent = `Syntactic Clause ${chunkIdx + 1} of ${pc.chunks.length} (${chunk.tokenIndices.length} words)`;

    const prevChunk = pc.chunks[chunkIdx - 1];
    const nextChunk = pc.chunks[chunkIdx + 1];
    el.teleprompterPrevClause.textContent = prevChunk ? prevChunk.text : '—';
    el.teleprompterNextClause.textContent = nextChunk ? nextChunk.text : '—';

    el.teleprompterActiveClause.innerHTML = chunk.tokenIndices
      .map((tIdx) => {
        const t = pc.tokens[tIdx];
        const cls = tIdx === activeTokenIdx ? 'word active-word' : 'word';
        return `<span class="${cls}" data-token-idx="${tIdx}">${renderBionicWordInnerHTML(t)}</span>`;
      })
      .join(' ');

    const para = pc.paragraphs[chunk.paragraphIndex];
    if (para) {
      el.teleprompterContextPara.innerHTML = para.tokenIndices
        .map((tIdx) => {
          const t = pc.tokens[tIdx];
          const cls = tIdx === activeTokenIdx ? 'word active-word' : 'word';
          return `<span class="${cls}" data-token-idx="${tIdx}">${escapeHtml(t.raw)}</span>`;
        })
        .join(' ');
    }
  }

  function updateTeleprompterActiveWordOnly(activeTokenIdx) {
    const spans = el.teleprompterActiveClause.querySelectorAll('.word');
    spans.forEach((sp) => {
      const idx = Number(sp.dataset.tokenIdx);
      sp.classList.toggle('active-word', idx === activeTokenIdx);
    });
    const ctxSpans = el.teleprompterContextPara.querySelectorAll('.word');
    ctxSpans.forEach((sp) => {
      const idx = Number(sp.dataset.tokenIdx);
      sp.classList.toggle('active-word', idx === activeTokenIdx);
    });
  }

  function updateTelemetryAndScrubber(tokenIdx) {
    const pc = state.parsedChapter;
    if (!pc) return;
    const token = pc.tokens[tokenIdx];
    const chunk = pc.chunks[token.chunkIndex];

    const effectiveWpm = Math.round(185 * state.speed);
    el.telemetryWordPos.textContent = `Word ${tokenIdx + 1} / ${pc.tokens.length}`;
    el.telemetryClausePos.textContent = `Clause ${token.chunkIndex + 1} / ${pc.chunks.length}`;
    el.telemetryWpm.textContent = `${effectiveWpm} WPM`;

    if (chunk) {
      el.activePhrasePreview.textContent = `“${chunk.text}”`;
    }

    const ratio = pc.tokens.length > 1 ? tokenIdx / (pc.tokens.length - 1) : 0;
    el.scrubberRange.value = Math.round(ratio * 1000);

    const chapterOffsetMs = Math.max(0, token.startMs - pc.videoStartMs);
    const elapsedSec = chapterOffsetMs / 1000 / state.speed;
    const totalSec = pc.totalDurationMs / 1000 / state.speed;
    el.chapterTimeRemaining.textContent = `${formatTimeMMSS(elapsedSec)} / ${formatTimeMMSS(totalSec)}`;
    el.ytTimeReadout.textContent = formatTimeMMSS(token.startMs / 1000);
  }

  /* ============================================================================
   * 5. AUDIO / TTS / YOUTUBE PIPELINE & 60FPS SYNCHRONIZATION ENGINE
   * ============================================================================ */

  function initVoices() {
    if (!('speechSynthesis' in window)) return;

    function populateVoices() {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return;

      const sorted = [...voices].sort((a, b) => {
        const aEn = a.lang.toLowerCase().startsWith('en') ? 1 : 0;
        const bEn = b.lang.toLowerCase().startsWith('en') ? 1 : 0;
        if (aEn !== bEn) return bEn - aEn;
        const aPrem = /premium|enhanced|natural|samantha|ava|daniel|alex|google/i.test(a.name) ? 1 : 0;
        const bPrem = /premium|enhanced|natural|samantha|ava|daniel|alex|google/i.test(b.name) ? 1 : 0;
        return bPrem - aPrem;
      });

      el.selTtsVoice.innerHTML = '';
      sorted.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.voiceURI;
        opt.textContent = `${v.name} (${v.lang})`;
        el.selTtsVoice.appendChild(opt);
      });

      if (!state.selectedVoiceURI && sorted.length > 0) {
        const preferred =
          sorted.find((v) => /samantha|ava|daniel|alex|google us english/i.test(v.name) && v.lang.startsWith('en')) ||
          sorted[0];
        state.selectedVoiceURI = preferred.voiceURI;
        el.selTtsVoice.value = preferred.voiceURI;
      }
    }

    populateVoices();
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

  function togglePlayback() {
    if (state.isPlaying) {
      stopPlayback();
      savePlayheadState(true);
    } else {
      startPlayback();
    }
  }

  /* ============================================================================
   * 5B. iOS LOCK SCREEN MEDIA SESSION & NATIVE AUDIOBOOK STREAMING
   * ============================================================================ */

  function updateLockScreenMediaSession() {
    if (!('mediaSession' in navigator) || !state.book) return;
    try {
      const chapTitle = state.parsedChapter?.title || 'Chapter 1';
      const coverSrc = normalizeRelativeAssetUrl(state.book.coverUrl || './books/palmer-eldritch/cover.jpeg');
      const absCover = new URL(coverSrc, window.location.href).href;

      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${chapTitle} — ${state.book.title}`,
        artist: state.book.author || 'FocusBooks',
        album: state.book.title || 'FocusBooks Reader',
        artwork: [{ src: absCover, sizes: '512x512', type: 'image/jpeg' }]
      });

      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';

      navigator.mediaSession.setActionHandler('play', () => {
        if (!state.isPlaying) startPlayback();
        else if (state.usingNativeChapterAudio && state.htmlAudio) {
          state.htmlAudio.play().catch(() => {});
        } else if (state.audioEngine === 'youtube' && state.ytPlayer?.playVideo) {
          state.ytPlayer.playVideo();
        }
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        stopPlayback();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        el.btnPrevSentence.click();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        el.btnNextSentence.click();
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        el.btnPrevSentence.click();
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        el.btnNextSentence.click();
      });
    } catch (_) {}
  }

  function startPlayback() {
    if (!state.parsedChapter || state.parsedChapter.tokens.length === 0) return;

    state.isPlaying = true;
    state.lastPlayCommandPerf = performance.now();
    el.iconPlay.classList.add('hidden');
    el.iconPause.classList.remove('hidden');
    el.syncStatusDot.classList.add('playing');

    updateLockScreenMediaSession();
    speakAndSyncFromToken(state.activeTokenIndex);
  }

  function stopPlayback() {
    state.isPlaying = false;
    state.usingNativeChapterAudio = false;
    el.iconPlay.classList.remove('hidden');
    el.iconPause.classList.add('hidden');
    el.syncStatusDot.classList.remove('playing');

    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.bgSyncIntervalId) {
      clearInterval(state.bgSyncIntervalId);
      state.bgSyncIntervalId = null;
    }
    updateLockScreenMediaSession();

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    state.currentUtterance = null;

    if (state.htmlAudio) {
      state.htmlAudio.pause();
    }

    if (state.ytPlayer && state.ytPlayerReady && typeof state.ytPlayer.pauseVideo === 'function') {
      try {
        state.ytPlayer.pauseVideo();
      } catch (_) {}
    }
  }

  function speakAndSyncFromToken(startTokenIndex) {
    if (!state.isPlaying || !state.parsedChapter) return;

    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.bgSyncIntervalId) {
      clearInterval(state.bgSyncIntervalId);
      state.bgSyncIntervalId = null;
    }
    updateLockScreenMediaSession();

    const pc = state.parsedChapter;
    if (startTokenIndex >= pc.tokens.length) {
      if (state.book && state.currentChapterIndex < state.book.chapters.length - 1) {
        showToast('Advancing to next chapter...');
        selectChapter(state.currentChapterIndex + 1, 0);
        startPlayback();
      } else {
        stopPlayback();
        showToast('Finished reading book.');
      }
      return;
    }

    setActiveToken(startTokenIndex, { scrollIntoView: state.autoScroll });
    const startToken = pc.tokens[startTokenIndex];
    const sentence = pc.sentences[startToken.sentenceIndex];

    if (state.audioEngine === 'youtube' && state.book?.youtubeVideoId && pc.hasExactTimestamps) {
      el.syncEngineBadge.textContent = 'YouTube json3 + 60Hz rAF';
      playYouTubeFromToken(startTokenIndex);
    } else if (state.audioEngine === 'pacer') {
      el.syncEngineBadge.textContent = '60Hz Visual Pacer Clock';
      runVisualPacerLoop(startTokenIndex);
    } else if (state.audioEngine === 'openai' && state.openAIKey) {
      el.syncEngineBadge.textContent = 'OpenAI Audio + 60Hz rAF';
      speakSentenceOpenAI(sentence, startTokenIndex);
    } else {
      el.syncEngineBadge.textContent = 'Web Speech onboundary + 60Hz rAF';
      speakSentenceWebSpeech(sentence, startTokenIndex);
    }
  }

  /**
   * Option C: Native HTML5 <audio> Chapter Stream (for 100% iOS Lock Screen support) + YouTube IFrame Fallback
   */
  function playYouTubeFromToken(tokenIndex) {
    const pc = state.parsedChapter;
    const token = pc.tokens[tokenIndex];
    if (!token) return;

    const rawChapter = state.book?.chapters?.[state.currentChapterIndex];
    if (rawChapter && rawChapter.audioUrl) {
      playNativeChapterAudioFromToken(tokenIndex, rawChapter);
      return;
    }

    state.usingNativeChapterAudio = false;
    state.lastPlayCommandPerf = performance.now();
    const targetSeconds = token.startMs / 1000;

    if (!state.ytPlayer || !state.ytPlayerReady) {
      initOrCueYouTubePlayer(state.book.youtubeVideoId, targetSeconds);
      setTimeout(() => {
        if (state.isPlaying && state.ytPlayer && state.ytPlayerReady) {
          playYouTubeFromToken(state.activeTokenIndex);
        }
      }, 450);
      return;
    }

    const currentSec = state.ytPlayer.getCurrentTime ? state.ytPlayer.getCurrentTime() : 0;
    if (Math.abs(currentSec - targetSeconds) > 0.35) {
      state.ytPlayer.seekTo(targetSeconds, true);
    }

    state.ytPlayer.setPlaybackRate(state.speed);
    state.ytPlayer.playVideo();

    state.ytLastReportedTimeSec = targetSeconds;
    state.ytLastReportedPerf = performance.now();

    runYouTubeSyncLoop();
  }

  function playNativeChapterAudioFromToken(tokenIndex, rawChapter) {
    const pc = state.parsedChapter;
    const token = pc.tokens[tokenIndex];
    if (!token) return;

    state.usingNativeChapterAudio = true;
    if (state.ytPlayer && state.ytPlayerReady && typeof state.ytPlayer.pauseVideo === 'function') {
      try {
        state.ytPlayer.pauseVideo();
      } catch (_) {}
    }

    const audioSrc = normalizeRelativeAssetUrl(rawChapter.audioUrl);
    const chapterOffsetMs = typeof rawChapter.audioOffsetMs === 'number' ? rawChapter.audioOffsetMs : (rawChapter.videoStartMs || 0);
    const targetRelSec = Math.max(0, (token.startMs - chapterOffsetMs) / 1000);

    if (state.htmlAudio.dataset.loadedSrc !== audioSrc) {
      state.htmlAudio.src = audioSrc;
      state.htmlAudio.dataset.loadedSrc = audioSrc;
      state.htmlAudio.load();
    }

    state.htmlAudio.playbackRate = state.speed;
    try {
      if (Math.abs((state.htmlAudio.currentTime || 0) - targetRelSec) > 0.35) {
        state.htmlAudio.currentTime = targetRelSec;
      }
    } catch (_) {
      state.htmlAudio.addEventListener(
        'loadedmetadata',
        () => {
          state.htmlAudio.currentTime = targetRelSec;
          state.htmlAudio.playbackRate = state.speed;
        },
        { once: true }
      );
    }

    const syncFromAudioClock = () => {
      if (!state.isPlaying || !state.usingNativeChapterAudio) return;
      const preciseMs = state.htmlAudio.currentTime * 1000 + chapterOffsetMs;
      el.ytTimeReadout.textContent = formatTimeMMSS(preciseMs / 1000);

      const matchedIdx = window.CognitiveEngine.findTokenByTimestampMs(pc.tokens, preciseMs);
      if (matchedIdx !== state.activeTokenIndex) {
        setActiveToken(matchedIdx, { scrollIntoView: state.autoScroll });
      }
      const tok = pc.tokens[matchedIdx];
      if (tok) {
        const intra = Math.max(0, Math.min(1, (preciseMs - tok.startMs) / Math.max(40, tok.durationMs)));
        updateSubWordProgressBars(intra);
      }
    };

    state.htmlAudio.ontimeupdate = syncFromAudioClock;
    state.htmlAudio.onended = () => {
      if (!state.isPlaying || !state.usingNativeChapterAudio) return;
      if (state.book && state.currentChapterIndex < state.book.chapters.length - 1) {
        selectChapter(state.currentChapterIndex + 1, 0);
        startPlayback();
      } else {
        stopPlayback();
      }
    };

    state.htmlAudio.play().catch(() => {
      // Fallback to YouTube iframe if audio file isn't cached/ready yet
      state.usingNativeChapterAudio = false;
      const fallbackChap = Object.assign({}, rawChapter, { audioUrl: '' });
      state.book.chapters[state.currentChapterIndex] = fallbackChap;
      playYouTubeFromToken(tokenIndex);
    });

    function nativeAudioRaf() {
      if (!state.isPlaying || !state.usingNativeChapterAudio) return;
      syncFromAudioClock();
      state.rafId = requestAnimationFrame(nativeAudioRaf);
    }
    state.rafId = requestAnimationFrame(nativeAudioRaf);
  }

  function runYouTubeSyncLoop() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.bgSyncIntervalId) {
      clearInterval(state.bgSyncIntervalId);
      state.bgSyncIntervalId = null;
    }
    updateLockScreenMediaSession();

    const pc = state.parsedChapter;

    function ytTick(now) {
      if (!state.isPlaying || state.audioEngine !== 'youtube') return;

      if (state.ytPlayer && state.ytPlayerReady && typeof state.ytPlayer.getCurrentTime === 'function') {
        const rawSec = state.ytPlayer.getCurrentTime();
        const playerState = state.ytPlayer.getPlayerState ? state.ytPlayer.getPlayerState() : 1;

        if (Math.abs(rawSec - state.ytLastReportedTimeSec) > 0.005) {
          state.ytLastReportedTimeSec = rawSec;
          state.ytLastReportedPerf = now;
        }

        const interpDeltaSec =
          playerState === 1 ? Math.min(0.25, ((now - state.ytLastReportedPerf) / 1000) * state.speed) : 0;
        const preciseMs = (state.ytLastReportedTimeSec + interpDeltaSec) * 1000;

        el.ytTimeReadout.textContent = formatTimeMMSS(preciseMs / 1000);

        // If user scrubbed the YouTube video bar directly into another chapter, auto-switch chapter!
        if (
          (preciseMs > pc.videoEndMs + 800 || preciseMs < pc.videoStartMs - 800) &&
          state.book &&
          state.book.chapters.length > 1
        ) {
          const targetChapIdx = state.book.chapters.findIndex(
            (ch) => typeof ch.videoStartMs === 'number' && preciseMs >= ch.videoStartMs && preciseMs <= ch.videoEndMs + 600
          );
          if (targetChapIdx !== -1 && targetChapIdx !== state.currentChapterIndex) {
            selectChapter(targetChapIdx, 0);
            startPlayback();
            return;
          }
        }

        const matchedIdx = window.CognitiveEngine.findTokenByTimestampMs(pc.tokens, preciseMs);
        if (matchedIdx !== state.activeTokenIndex) {
          setActiveToken(matchedIdx, { scrollIntoView: state.autoScroll });
        }

        const tok = pc.tokens[matchedIdx];
        if (tok) {
          const intra = Math.max(0, Math.min(1, (preciseMs - tok.startMs) / Math.max(40, tok.durationMs)));
          updateSubWordProgressBars(intra);
        }
      }

      state.rafId = requestAnimationFrame(ytTick);
    }

    state.rafId = requestAnimationFrame(ytTick);
    if (state.bgSyncIntervalId) clearInterval(state.bgSyncIntervalId);
    state.bgSyncIntervalId = setInterval(() => {
      if (document.hidden && state.isPlaying && state.audioEngine === 'youtube' && !state.lockScreenTtsFallbackActive) {
        ytTick(performance.now());
      }
    }, 250);
  }

  /**
   * Option B: Native Browser Web Speech API (`SpeechSynthesisUtterance` + `onboundary` + 60Hz `requestAnimationFrame`)
   */
  function speakSentenceWebSpeech(sentence, startTokenIndex) {
    if (!('speechSynthesis' in window)) {
      runVisualPacerLoop(startTokenIndex);
      return;
    }

    window.speechSynthesis.cancel();

    const pc = state.parsedChapter;
    const subTokenIndices = sentence.tokenIndices.filter((idx) => idx >= startTokenIndex);
    const spokenText = subTokenIndices.map((idx) => pc.tokens[idx].raw).join(' ');

    const subCharOffsets = [];
    let charPos = 0;
    for (const tIdx of subTokenIndices) {
      const rawLen = pc.tokens[tIdx].raw.length;
      subCharOffsets.push({
        tokenIdx: tIdx,
        charStart: charPos,
        charEnd: charPos + rawLen
      });
      charPos += rawLen + 1;
    }

    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.rate = Math.max(0.5, Math.min(2.5, state.speed));
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const chosenVoice = voices.find((v) => v.voiceURI === state.selectedVoiceURI);
    if (chosenVoice) {
      utterance.voice = chosenVoice;
      utterance.lang = chosenVoice.lang;
    } else {
      utterance.lang = 'en-US';
    }

    state.currentUtterance = utterance;
    state.sentenceStartPerf = performance.now();
    state.lastBoundaryPerf = performance.now();
    state.lastBoundaryEventCount = 0;

    let currentSyncedTokenIdx = startTokenIndex;

    utterance.onboundary = (event) => {
      if (!state.isPlaying || state.currentUtterance !== utterance) return;
      if (event.name && event.name !== 'word') return;

      const cIdx = typeof event.charIndex === 'number' ? event.charIndex : 0;
      let matchedTokenIdx = subTokenIndices[0];

      for (let i = 0; i < subCharOffsets.length; i++) {
        const entry = subCharOffsets[i];
        if (cIdx >= entry.charStart && cIdx <= entry.charEnd + 1) {
          matchedTokenIdx = entry.tokenIdx;
          break;
        }
        if (entry.charStart > cIdx) {
          matchedTokenIdx = i > 0 ? subCharOffsets[i - 1].tokenIdx : entry.tokenIdx;
          break;
        }
      }

      state.lastBoundaryEventCount++;
      state.lastBoundaryPerf = performance.now();
      currentSyncedTokenIdx = matchedTokenIdx;
      setActiveToken(matchedTokenIdx, { scrollIntoView: state.autoScroll });
    };

    utterance.onend = () => {
      if (!state.isPlaying || state.currentUtterance !== utterance) return;
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      const nextTokenIdx = sentence.lastTokenIndex + 1;
      speakAndSyncFromToken(nextTokenIdx);
    };

    utterance.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (state.isPlaying && state.currentUtterance === utterance) {
        runVisualPacerLoop(currentSyncedTokenIdx);
      }
    };

    const baseStartMs = pc.tokens[startTokenIndex].startMs;
    function syncFrame(now) {
      if (!state.isPlaying || state.currentUtterance !== utterance) return;

      const activeTok = pc.tokens[state.activeTokenIndex];
      const tokDurationScaled = activeTok.durationMs / state.speed;
      const elapsedSinceBoundary = now - state.lastBoundaryPerf;
      const intraProgress = Math.min(1, elapsedSinceBoundary / Math.max(80, tokDurationScaled));

      updateSubWordProgressBars(intraProgress);

      if (state.lastBoundaryEventCount === 0 || elapsedSinceBoundary > tokDurationScaled * 1.35) {
        const virtualElapsedMs = (now - state.sentenceStartPerf) * state.speed;
        const targetClockMs = baseStartMs + virtualElapsedMs;

        for (const tIdx of subTokenIndices) {
          const t = pc.tokens[tIdx];
          if (targetClockMs >= t.startMs && targetClockMs <= t.endMs) {
            if (tIdx > state.activeTokenIndex) {
              state.lastBoundaryPerf = now;
              setActiveToken(tIdx, { scrollIntoView: state.autoScroll });
            }
            break;
          }
        }
      }

      state.rafId = requestAnimationFrame(syncFrame);
    }

    window.speechSynthesis.speak(utterance);
    state.rafId = requestAnimationFrame(syncFrame);
    if (state.bgSyncIntervalId) clearInterval(state.bgSyncIntervalId);
    state.bgSyncIntervalId = setInterval(() => {
      if (document.hidden && state.isPlaying && state.currentUtterance === utterance) {
        syncFrame(performance.now());
      }
    }, 250);
  }

  function runVisualPacerLoop(startTokenIndex) {
    const pc = state.parsedChapter;
    const baseToken = pc.tokens[startTokenIndex];
    if (!baseToken) return;

    const baseStartMs = baseToken.startMs;
    const loopStartPerf = performance.now();
    let cursorIdx = startTokenIndex;

    function pacerTick(now) {
      if (!state.isPlaying) return;

      const virtualElapsedMs = (now - loopStartPerf) * state.speed;
      const currentBookClockMs = baseStartMs + virtualElapsedMs;

      while (cursorIdx < pc.tokens.length && currentBookClockMs > pc.tokens[cursorIdx].endMs) {
        cursorIdx++;
      }

      if (cursorIdx >= pc.tokens.length) {
        speakAndSyncFromToken(pc.tokens.length);
        return;
      }

      if (cursorIdx !== state.activeTokenIndex) {
        setActiveToken(cursorIdx, { scrollIntoView: state.autoScroll });
      }

      const tok = pc.tokens[cursorIdx];
      const intra = Math.max(0, Math.min(1, (currentBookClockMs - tok.startMs) / Math.max(1, tok.durationMs)));
      updateSubWordProgressBars(intra);

      state.rafId = requestAnimationFrame(pacerTick);
    }

    state.rafId = requestAnimationFrame(pacerTick);
  }

  async function speakSentenceOpenAI(sentence, startTokenIndex) {
    const pc = state.parsedChapter;
    const subTokenIndices = sentence.tokenIndices.filter((idx) => idx >= startTokenIndex);
    const spokenText = subTokenIndices.map((idx) => pc.tokens[idx].raw).join(' ');

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.openAIKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice: 'onyx',
          input: spokenText,
          speed: Math.max(0.5, Math.min(2.0, state.speed))
        })
      });

      if (!response.ok) throw new Error('OpenAI TTS request failed');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      state.htmlAudio.src = url;

      const firstTok = pc.tokens[subTokenIndices[0]];
      const lastTok = pc.tokens[subTokenIndices[subTokenIndices.length - 1]];
      const estimatedSpanMs = Math.max(100, lastTok.endMs - firstTok.startMs);

      state.htmlAudio.onended = () => {
        URL.revokeObjectURL(url);
        if (!state.isPlaying) return;
        speakAndSyncFromToken(sentence.lastTokenIndex + 1);
      };

      await state.htmlAudio.play();

      function audioRafLoop() {
        if (!state.isPlaying || state.htmlAudio.paused) return;
        const durationSec = state.htmlAudio.duration || estimatedSpanMs / 1000;
        const progressRatio = Math.min(1, state.htmlAudio.currentTime / durationSec);
        const mappedMs = firstTok.startMs + progressRatio * estimatedSpanMs;

        for (const tIdx of subTokenIndices) {
          const t = pc.tokens[tIdx];
          if (mappedMs >= t.startMs && mappedMs <= t.endMs) {
            if (tIdx !== state.activeTokenIndex) {
              setActiveToken(tIdx, { scrollIntoView: state.autoScroll });
            }
            const intra = (mappedMs - t.startMs) / Math.max(1, t.durationMs);
            updateSubWordProgressBars(intra);
            break;
          }
        }
        state.rafId = requestAnimationFrame(audioRafLoop);
      }

      state.rafId = requestAnimationFrame(audioRafLoop);
    } catch (err) {
      showToast('Cloud TTS unavailable, falling back to Web Speech API');
      setAudioEngine('webspeech');
      speakSentenceWebSpeech(sentence, startTokenIndex);
    }
  }

  function updateSubWordProgressBars(intraWordRatio) {
    const pct = Math.round(Math.max(0, Math.min(1, intraWordRatio)) * 100);
    if (state.mode === 'rsvp') {
      el.rsvpTokenProgressBar.style.width = `${pct}%`;
    } else if (state.mode === 'teleprompter') {
      const pc = state.parsedChapter;
      const chunk = pc.chunks[state.activeChunkIndex];
      if (chunk) {
        const posInChunk = chunk.tokenIndices.indexOf(state.activeTokenIndex);
        const chunkRatio = (posInChunk + intraWordRatio) / Math.max(1, chunk.tokenIndices.length);
        el.teleprompterProgressFill.style.width = `${Math.round(chunkRatio * 100)}%`;
      }
    }
  }

  /* ============================================================================
   * 6. COGNITIVE FOCUS SPRINT TIMER (10-15 MINUTE CONFIGURABLE SPRINT)
   * ============================================================================ */

  function toggleSprintTimer() {
    if (state.sprintRunning) {
      pauseSprintTimer();
    } else {
      startSprintTimer();
    }
  }

  function startSprintTimer() {
    if (state.sprintRemainingSeconds <= 0) {
      state.sprintRemainingSeconds = state.sprintDurationMinutes * 60;
    }
    state.sprintRunning = true;
    el.btnSprintToggle.textContent = 'Pause';

    clearInterval(state.sprintIntervalId);
    state.sprintIntervalId = setInterval(() => {
      state.sprintRemainingSeconds--;
      updateSprintTimerDisplay();

      if (state.sprintRemainingSeconds <= 0) {
        completeSprintTimer();
      }
    }, 1000);
  }

  function pauseSprintTimer() {
    state.sprintRunning = false;
    el.btnSprintToggle.textContent = 'Resume';
    clearInterval(state.sprintIntervalId);
  }

  function completeSprintTimer() {
    pauseSprintTimer();
    el.btnSprintToggle.textContent = 'Start';
    state.sprintRemainingSeconds = state.sprintDurationMinutes * 60;
    updateSprintTimerDisplay();

    if (state.isPlaying) {
      stopPlayback();
    }
    playSprintCompletionChime();
    showToast(`Focus Sprint (${state.sprintDurationMinutes}m) complete! Take a 2-minute visual rest.`, 6000);
  }

  function updateSprintTimerDisplay() {
    el.sprintTimeDisplay.textContent = formatTimeMMSS(state.sprintRemainingSeconds);
    const totalSec = state.sprintDurationMinutes * 60;
    const fraction = Math.max(0, Math.min(1, state.sprintRemainingSeconds / totalSec));
    const circumference = 94.25;
    el.sprintRingProgress.style.strokeDashoffset = String(circumference * (1 - fraction));
  }

  function playSprintCompletionChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.08, ctx.currentTime + i * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.14 + 0.9);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.14);
        osc.stop(ctx.currentTime + i * 0.14 + 0.9);
      });
    } catch (_) {}
  }

  /* ============================================================================
   * 7. UI EVENT LISTENERS & KEYBOARD SHORTCUTS
   * ============================================================================ */

  function setSpeed(newSpeed, persist = true) {
    const clamped = Math.round(Math.max(0.5, Math.min(2.0, Number(newSpeed))) * 100) / 100;
    state.speed = clamped;
    el.speedValueBadge.textContent = `${clamped.toFixed(2)}x`;
    el.rngSpeed.value = String(clamped);

    const selYtSpeed = document.getElementById('sel-yt-speed');
    if (selYtSpeed) {
      const strVal = String(clamped);
      let opt = Array.from(selYtSpeed.options).find((o) => Math.abs(Number(o.value) - clamped) < 0.01);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = strVal;
        opt.textContent = `${clamped.toFixed(2)}x`;
        selYtSpeed.appendChild(opt);
      }
      selYtSpeed.value = opt.value;
    }

    el.speedPresets.forEach((btn) => {
      btn.classList.toggle('active', Math.abs(Number(btn.dataset.speed) - clamped) < 0.01);
    });

    if (state.parsedChapter) {
      updateTelemetryAndScrubber(state.activeTokenIndex);
    }

    if (persist) {
      savePlayheadState(false);
    }

    if (state.usingNativeChapterAudio && state.htmlAudio) {
      state.htmlAudio.playbackRate = clamped;
      return;
    }

    if (state.audioEngine === 'youtube' && state.ytPlayer && state.ytPlayerReady) {
      try {
        state.ytPlayer.setPlaybackRate(clamped);
      } catch (_) {}
      return;
    }

    if (state.isPlaying) {
      speakAndSyncFromToken(state.activeTokenIndex);
    }
  }

  function seekToTokenAndSync(targetIdx, shouldScroll = true) {
    setActiveToken(targetIdx, { scrollIntoView: shouldScroll, forceStageUpdate: true });
    const pc = state.parsedChapter;
    const tok = pc?.tokens[targetIdx];

    if (state.usingNativeChapterAudio && state.htmlAudio && tok) {
      const rawChapter = state.book?.chapters?.[state.currentChapterIndex];
      const chapterOffsetMs = typeof rawChapter?.audioOffsetMs === 'number' ? rawChapter.audioOffsetMs : (rawChapter?.videoStartMs || 0);
      state.htmlAudio.currentTime = Math.max(0, (tok.startMs - chapterOffsetMs) / 1000);
    } else if (state.audioEngine === 'youtube' && state.ytPlayer && state.ytPlayerReady && tok) {
      state.lastPlayCommandPerf = performance.now();
      state.ytPlayer.seekTo(tok.startMs / 1000, true);
      state.ytLastReportedTimeSec = tok.startMs / 1000;
      state.ytLastReportedPerf = performance.now();
    }

    savePlayheadState(true);

    if (state.isPlaying) {
      speakAndSyncFromToken(targetIdx);
    }
  }

  function bindUIEvents() {
    const optionsHubBackdrop = document.getElementById('options-hub-backdrop');
    const btnToggleOptionsHub = document.getElementById('btn-toggle-options-hub');
    const btnCloseOptionsHub = document.getElementById('btn-close-options-hub');

    if (btnToggleOptionsHub && optionsHubBackdrop) {
      btnToggleOptionsHub.addEventListener('click', () => {
        optionsHubBackdrop.classList.toggle('hidden');
      });
    }
    if (btnCloseOptionsHub && optionsHubBackdrop) {
      btnCloseOptionsHub.addEventListener('click', () => {
        optionsHubBackdrop.classList.add('hidden');
      });
    }
    if (optionsHubBackdrop) {
      optionsHubBackdrop.addEventListener('click', (e) => {
        if (e.target === optionsHubBackdrop) {
          optionsHubBackdrop.classList.add('hidden');
        }
      });
    }

    // Start YouTube panel minimized on mobile/iPhone so it never blocks the reading text
    if (window.innerWidth <= 768 && el.ytDockPanel && el.btnToggleYtMinimize) {
      el.ytDockPanel.classList.add('minimized');
      el.btnToggleYtMinimize.textContent = '□';
    }

    el.modeTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        state.mode = tab.dataset.mode;
        applyVisualModeClasses();
        savePlayheadState(true);
      });
    });

    el.chkBionicStems.addEventListener('change', (e) => {
      state.bionicEnabled = e.target.checked;
      applyVisualModeClasses();
    });

    el.ctrlBionicIntensity.querySelectorAll('.mini-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.ctrlBionicIntensity.querySelectorAll('.mini-pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.bionicDelta = Number(btn.dataset.bionicDelta);
        refreshBionicStemsInDOM();
        setActiveToken(state.activeTokenIndex, { scrollIntoView: false, forceStageUpdate: true });
      });
    });

    el.audioSourcePills.forEach((btn) => {
      btn.addEventListener('click', () => {
        setAudioEngine(btn.dataset.audioSource);
        savePlayheadState(true);
      });
    });

    el.btnToggleYtMinimize.addEventListener('click', () => {
      el.ytDockPanel.classList.toggle('minimized');
      el.btnToggleYtMinimize.textContent = el.ytDockPanel.classList.contains('minimized') ? '□' : '_';
    });

    const btnToggleYtSize = document.getElementById('btn-toggle-yt-size');
    if (btnToggleYtSize) {
      btnToggleYtSize.addEventListener('click', () => {
        el.ytDockPanel.classList.remove('minimized');
        el.btnToggleYtMinimize.textContent = '_';
        el.ytDockPanel.classList.toggle('large');
        clampYtDockInsideViewport();
      });
    }

    const btnYtSpeedDown = document.getElementById('btn-yt-speed-down');
    const btnYtSpeedUp = document.getElementById('btn-yt-speed-up');
    const selYtSpeed = document.getElementById('sel-yt-speed');
    if (btnYtSpeedDown) {
      btnYtSpeedDown.addEventListener('click', () => setSpeed(state.speed - 0.1, true));
    }
    if (btnYtSpeedUp) {
      btnYtSpeedUp.addEventListener('click', () => setSpeed(state.speed + 0.1, true));
    }
    if (selYtSpeed) {
      selYtSpeed.addEventListener('change', (e) => setSpeed(Number(e.target.value), true));
    }

    // Draggable YouTube Player (Mouse + Touch via Pointer Events)
    const ytDockHeader = document.getElementById('yt-dock-header');
    function clampYtDockInsideViewport() {
      if (!el.ytDockPanel || el.ytDockPanel.classList.contains('hidden')) return;
      if (!el.ytDockPanel.style.left || !el.ytDockPanel.style.top) return;
      const rect = el.ytDockPanel.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - rect.width - 8);
      const maxY = Math.max(8, window.innerHeight - rect.height - 8);
      const clampedX = Math.min(Math.max(8, parseFloat(el.ytDockPanel.style.left) || 8), maxX);
      const clampedY = Math.min(Math.max(8, parseFloat(el.ytDockPanel.style.top) || 8), maxY);
      el.ytDockPanel.style.left = `${clampedX}px`;
      el.ytDockPanel.style.top = `${clampedY}px`;
      el.ytDockPanel.style.right = 'auto';
      el.ytDockPanel.style.bottom = 'auto';
    }

    try {
      const savedPos = JSON.parse(localStorage.getItem('focusbooks_yt_pos') || 'null');
      if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
        el.ytDockPanel.style.left = `${savedPos.left}px`;
        el.ytDockPanel.style.top = `${savedPos.top}px`;
        el.ytDockPanel.style.right = 'auto';
        el.ytDockPanel.style.bottom = 'auto';
        setTimeout(clampYtDockInsideViewport, 100);
      }
    } catch (_) {}

    if (ytDockHeader && el.ytDockPanel) {
      let isDragging = false;
      let dragOffsetX = 0;
      let dragOffsetY = 0;

      ytDockHeader.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || e.target.closest('select')) return;
        isDragging = true;
        const rect = el.ytDockPanel.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        el.ytDockPanel.style.left = `${rect.left}px`;
        el.ytDockPanel.style.top = `${rect.top}px`;
        el.ytDockPanel.style.right = 'auto';
        el.ytDockPanel.style.bottom = 'auto';
        el.ytDockPanel.classList.add('dragging');
        ytDockHeader.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      ytDockHeader.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const rect = el.ytDockPanel.getBoundingClientRect();
        const maxX = Math.max(8, window.innerWidth - rect.width - 8);
        const maxY = Math.max(8, window.innerHeight - rect.height - 8);
        const nextX = Math.min(Math.max(8, e.clientX - dragOffsetX), maxX);
        const nextY = Math.min(Math.max(8, e.clientY - dragOffsetY), maxY);
        el.ytDockPanel.style.left = `${nextX}px`;
        el.ytDockPanel.style.top = `${nextY}px`;
      });

      const stopDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        el.ytDockPanel.classList.remove('dragging');
        try {
          if (e.pointerId !== undefined) ytDockHeader.releasePointerCapture(e.pointerId);
          localStorage.setItem(
            'focusbooks_yt_pos',
            JSON.stringify({
              left: parseFloat(el.ytDockPanel.style.left),
              top: parseFloat(el.ytDockPanel.style.top)
            })
          );
        } catch (_) {}
      };

      ytDockHeader.addEventListener('pointerup', stopDrag);
      ytDockHeader.addEventListener('pointercancel', stopDrag);
      window.addEventListener('resize', clampYtDockInsideViewport);
    }

    el.ctrlModeChunking.querySelectorAll('.mini-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.ctrlModeChunking.querySelectorAll('.mini-pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.stanzaAlign = btn.dataset.stanzaAlign;
        applyVisualModeClasses();
      });
    });

    el.ctrlModeRsvp.querySelectorAll('.mini-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.ctrlModeRsvp.querySelectorAll('.mini-pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.rsvpWindowSize = Number(btn.dataset.rsvpSize);
        renderRSVPWord(state.activeTokenIndex);
      });
    });

    el.ctrlModeKaraoke.querySelectorAll('.mini-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.ctrlModeKaraoke.querySelectorAll('.mini-pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.karaokeLayout = btn.dataset.karaokeLayout;
        applyVisualModeClasses();
      });
    });

    el.chkAutoscroll.addEventListener('change', (e) => {
      state.autoScroll = e.target.checked;
    });

    el.readingViewport.addEventListener('click', (e) => {
      const wordEl = e.target.closest('.word');
      if (!wordEl) return;
      const idx = Number(wordEl.dataset.tokenIdx);
      if (Number.isNaN(idx)) return;
      seekToTokenAndSync(idx, false);
    });

    el.btnPlayPause.addEventListener('click', togglePlayback);

    el.btnPrevSentence.addEventListener('click', () => {
      if (!state.parsedChapter) return;
      const prevSentIdx = Math.max(0, state.activeSentenceIndex - 1);
      const targetTokenIdx = state.parsedChapter.sentences[prevSentIdx].firstTokenIndex;
      seekToTokenAndSync(targetTokenIdx, true);
    });

    el.btnNextSentence.addEventListener('click', () => {
      if (!state.parsedChapter) return;
      const nextSentIdx = Math.min(state.parsedChapter.sentences.length - 1, state.activeSentenceIndex + 1);
      const targetTokenIdx = state.parsedChapter.sentences[nextSentIdx].firstTokenIndex;
      seekToTokenAndSync(targetTokenIdx, true);
    });

    document.getElementById('btn-prev-chapter-stage').addEventListener('click', () => {
      if (state.currentChapterIndex > 0) {
        selectChapter(state.currentChapterIndex - 1, 0);
        savePlayheadState(true);
      }
    });
    document.getElementById('btn-next-chapter-stage').addEventListener('click', () => {
      if (state.book && state.currentChapterIndex < state.book.chapters.length - 1) {
        selectChapter(state.currentChapterIndex + 1, 0);
        savePlayheadState(true);
      }
    });

    el.scrubberRange.addEventListener('input', (e) => {
      if (!state.parsedChapter) return;
      const ratio = Number(e.target.value) / 1000;
      const targetIdx = Math.round(ratio * (state.parsedChapter.tokens.length - 1));
      seekToTokenAndSync(targetIdx, true);
    });

    el.speedPresets.forEach((btn) => {
      btn.addEventListener('click', () => setSpeed(Number(btn.dataset.speed), true));
    });
    el.rngSpeed.addEventListener('input', (e) => setSpeed(Number(e.target.value), true));

    el.btnSprintToggle.addEventListener('click', toggleSprintTimer);
    el.sprintDurationSelect.addEventListener('change', (e) => {
      pauseSprintTimer();
      el.btnSprintToggle.textContent = 'Start';
      state.sprintDurationMinutes = Number(e.target.value);
      state.sprintRemainingSeconds = state.sprintDurationMinutes * 60;
      updateSprintTimerDisplay();
    });

    const toggleSidebar = () => el.chapterSidebar.classList.toggle('collapsed');
    document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebar);
    document.getElementById('btn-open-chapters').addEventListener('click', toggleSidebar);
    document.getElementById('btn-close-sidebar').addEventListener('click', () => {
      el.chapterSidebar.classList.add('collapsed');
    });

    document.getElementById('btn-toggle-settings').addEventListener('click', () => {
      if (optionsHubBackdrop) optionsHubBackdrop.classList.add('hidden');
      el.settingsDrawer.classList.toggle('hidden');
    });
    document.getElementById('btn-close-settings').addEventListener('click', () => {
      el.settingsDrawer.classList.add('hidden');
    });

    el.inputSearchBook.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q || !state.parsedChapter) return;
      const match = state.parsedChapter.tokens.find((t) => t.raw.toLowerCase().includes(q));
      if (match) {
        seekToTokenAndSync(match.index, true);
      }
    });

    const btnQuickBw = document.getElementById('btn-quick-bw');
    function applyTheme(themeName) {
      document.documentElement.setAttribute('data-theme', themeName);
      document.querySelectorAll('[data-set-theme]').forEach((b) => {
        b.classList.toggle('active', b.dataset.setTheme === themeName);
      });
      if (btnQuickBw) {
        const isBw = themeName === 'bw-dark' || themeName === 'bw-light';
        btnQuickBw.classList.toggle('active', isBw);
        btnQuickBw.textContent =
          themeName === 'bw-dark'
            ? '◐ Pure B&W (Black)'
            : themeName === 'bw-light'
            ? '◑ Pure B&W (White)'
            : '◐ Pure B&W';
      }
      savePlayheadState(false);
    }

    if (btnQuickBw) {
      btnQuickBw.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'bw-dark';
        if (cur === 'bw-dark') {
          applyTheme('bw-light');
          showToast('Theme: Pure B&W (Stark White Ink)');
        } else if (cur === 'bw-light') {
          applyTheme('obsidian');
          showToast('Theme: Obsidian Dark');
        } else {
          applyTheme('bw-dark');
          showToast('Theme: Pure B&W (Stark Black)');
        }
      });
    }

    document.querySelectorAll('[data-set-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyTheme(btn.dataset.setTheme);
      });
    });

    document.getElementById('rng-font-size').addEventListener('input', (e) => {
      const val = `${e.target.value}px`;
      document.getElementById('lbl-font-size').textContent = val;
      document.documentElement.style.setProperty('--reader-font-size', val);
    });
    document.getElementById('rng-line-height').addEventListener('input', (e) => {
      const val = e.target.value;
      document.getElementById('lbl-line-height').textContent = val;
      document.documentElement.style.setProperty('--reader-line-height', val);
    });
    document.getElementById('rng-dim-opacity').addEventListener('input', (e) => {
      const val = e.target.value;
      document.getElementById('lbl-dim-opacity').textContent = val;
      document.documentElement.style.setProperty('--dim-opacity', val);
    });

    el.selAudioMode.addEventListener('change', (e) => {
      setAudioEngine(e.target.value);
      savePlayheadState(true);
    });

    el.selTtsVoice.addEventListener('change', (e) => {
      state.selectedVoiceURI = e.target.value;
      if (state.isPlaying) speakAndSyncFromToken(state.activeTokenIndex);
    });

    el.inputOpenaiKey.value = state.openAIKey;
    el.inputOpenaiKey.addEventListener('change', (e) => {
      state.openAIKey = e.target.value.trim();
      localStorage.setItem('focusbooks_openai_key', state.openAIKey);
    });

    // Library Modal
    document.getElementById('btn-open-library').addEventListener('click', async () => {
      savePlayheadState(true);
      await fetchLibraryIndex();
      renderLibraryModal();
      el.modalLibrary.classList.remove('hidden');
    });
    document.getElementById('btn-close-library').addEventListener('click', () => {
      el.modalLibrary.classList.add('hidden');
    });
    document.getElementById('btn-library-to-import').addEventListener('click', () => {
      el.modalLibrary.classList.add('hidden');
      el.modalImport.classList.remove('hidden');
    });
    const btnSyncAppleBooks = document.getElementById('btn-sync-apple-books');
    if (btnSyncAppleBooks) {
      btnSyncAppleBooks.addEventListener('click', async () => {
        try {
          showToast('Scanning iCloud Apple Books folder...');
          const res = await fetch('./api/sync-apple-books', { method: 'POST' });
          if (!res.ok) {
            throw new Error('Apple Books sync requires the local Mac server, or books are already pre-synced!');
          }
          const data = await res.json();
          await fetchLibraryIndex();
          renderLibraryModal();
          showToast(`Synced ${data.count} Apple Books into Library!`);
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    // Import Modal
    document.getElementById('btn-open-import').addEventListener('click', () => {
      if (optionsHubBackdrop) optionsHubBackdrop.classList.add('hidden');
      el.modalImport.classList.remove('hidden');
    });
    document.getElementById('btn-close-import').addEventListener('click', () => {
      el.modalImport.classList.add('hidden');
    });

    // 1A. Standalone YouTube Audiobook + Captions Import (Works both via Server and 100% Serverless on iOS!)
    document.getElementById('btn-import-yt-standalone').addEventListener('click', async () => {
      const ytUrl = document.getElementById('input-youtube-url').value.trim();
      if (!ytUrl) return;
      try {
        savePlayheadState(true);
        showToast('Extracting YouTube word-level captions & saving to Library...', 10000);
        let data = null;

        // Try local server first if running
        try {
          const res = await fetch(`./api/youtube-import?url=${encodeURIComponent(ytUrl)}`);
          if (res.ok) {
            data = await res.json();
          }
        } catch (_) {}

        // Serverless Client-Side Fallback (for iOS / GitHub Pages with no computer)
        if (!data) {
          const videoId = window.EpubLoader.extractYouTubeId(ytUrl);
          if (!videoId) throw new Error('Invalid YouTube URL');
          const [meta, ytWords] = await Promise.all([
            window.EpubLoader.fetchYouTubeMetaClientSide(videoId),
            window.EpubLoader.fetchYouTubeTimedWordsClientSide(videoId)
          ]);
          if (!ytWords || ytWords.length === 0) {
            throw new Error('Could not fetch captions from public proxy; use "Sync YouTube Audio to Current EPUB" instead.');
          }
          data = window.EpubLoader.buildStandaloneBookFromYouTubeCaptions(videoId, meta, ytWords);
        }

        await saveBookToServerLibrary(data, 'youtube');
        const lib = await fetchLibraryIndex();
        const savedEntry = lib.books.find((b) => b.id === data.id);
        loadBookWithSavedPlayhead(data, savedEntry?.progress);
        el.modalImport.classList.add('hidden');
        showToast(
          `Saved "${data.title}" to Library (${data.totalWords.toLocaleString()} timed words)`
        );
      } catch (err) {
        showToast(`YouTube Import Error: ${err.message}`);
      }
    });

    // 1B. Align YouTube Audiobook to Currently Loaded EPUB (Works both via Server and 100% Serverless on iOS!)
    document.getElementById('btn-align-yt-epub').addEventListener('click', async () => {
      const ytUrl = document.getElementById('input-youtube-url').value.trim();
      if (!ytUrl || !state.book) return;
      try {
        savePlayheadState(true);
        showToast('Aligning YouTube word timestamps to EPUB chapters...', 10000);
        let alignedBook = null;

        try {
          const res = await fetch('./api/youtube-align', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: ytUrl, book: state.book })
          });
          if (res.ok) {
            alignedBook = await res.json();
          }
        } catch (_) {}

        // Serverless Client-Side Alignment Fallback (runs in <20ms directly on iPhone!)
        if (!alignedBook) {
          const videoId = window.EpubLoader.extractYouTubeId(ytUrl);
          if (!videoId) throw new Error('Invalid YouTube URL');
          const [meta, ytWords] = await Promise.all([
            window.EpubLoader.fetchYouTubeMetaClientSide(videoId),
            window.EpubLoader.fetchYouTubeTimedWordsClientSide(videoId)
          ]);
          alignedBook = window.EpubLoader.alignYouTubeToBookClientSide(state.book, videoId, meta, ytWords);
        }

        await saveBookToServerLibrary(alignedBook, 'epub+youtube');
        loadBookWithSavedPlayhead(alignedBook, {
          chapterIndex: state.currentChapterIndex,
          tokenIndex: state.activeTokenIndex,
          speed: state.speed,
          mode: state.mode,
          audioEngine: 'youtube'
        });
        el.modalImport.classList.add('hidden');
        showToast(`Synced YouTube audio timestamps onto "${alignedBook.title}" & saved to Library!`);
      } catch (err) {
        showToast(`Alignment Error: ${err.message}`);
      }
    });

    // 2. Load Local EPUB Path
    document.getElementById('btn-load-local-path').addEventListener('click', async () => {
      const pathVal = document.getElementById('input-local-epub-path').value.trim();
      if (!pathVal) return;
      try {
        savePlayheadState(true);
        showToast('Parsing local EPUB & saving to Library...');
        const res = await fetch(`/api/load-epub?path=${encodeURIComponent(pathVal)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load EPUB');
        const lib = await fetchLibraryIndex();
        const savedEntry = lib.books.find((b) => b.id === data.id);
        loadBookWithSavedPlayhead(data, savedEntry?.progress);
        el.modalImport.classList.add('hidden');
        showToast(`Saved "${data.title}" to Library (${data.totalWords.toLocaleString()} words)`);
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    // 3. Upload Single .epub or .txt file
    document.getElementById('file-input-single').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        savePlayheadState(true);
        showToast(`Parsing ${file.name} & saving to Library...`);
        const bookData = await window.EpubLoader.parseSingleFile(file);
        await saveBookToServerLibrary(bookData, 'epub');
        loadBookWithSavedPlayhead(bookData, null);
        el.modalImport.classList.add('hidden');
        showToast(`Saved "${bookData.title}" to Library (${bookData.totalWords.toLocaleString()} words)`);
      } catch (err) {
        showToast(`Error parsing file: ${err.message}`);
      }
    });

    // 4. Upload Unpacked .epub directory
    document.getElementById('file-input-folder').addEventListener('change', async (e) => {
      if (!e.target.files || e.target.files.length === 0) return;
      try {
        savePlayheadState(true);
        showToast('Parsing unpacked EPUB folder & saving to Library...');
        const bookData = await window.EpubLoader.parseFileList(e.target.files);
        await saveBookToServerLibrary(bookData, 'epub');
        loadBookWithSavedPlayhead(bookData, null);
        el.modalImport.classList.add('hidden');
        showToast(`Saved "${bookData.title}" to Library (${bookData.totalWords.toLocaleString()} words)`);
      } catch (err) {
        showToast(`Error parsing folder: ${err.message}`);
      }
    });

    // 5. Direct Raw Text Input
    document.getElementById('btn-load-sample-passage').addEventListener('click', () => {
      document.getElementById('input-custom-title').value = 'Cognitive Audio-Visual Reading Sample';
      document.getElementById('textarea-custom-text').value =
        'Passive audiobook listening often leads to mind-wandering and sleepiness due to low physical arousal, while static text reading in a non-native language creates cognitive overload and visual fatigue.\n\nA dual-stream reader combines precise audio narration with real-time cognitive text formatting: bionic fixation stems guide saccadic jumps across each word, syntactic chunking organizes clauses into vertical poetic stanzas, and Optimal Recognition Point anchoring keeps your foveal focus effortlessly centered.';
    });

    document.getElementById('btn-parse-custom-text').addEventListener('click', async () => {
      const rawText = document.getElementById('textarea-custom-text').value.trim();
      const title = document.getElementById('input-custom-title').value.trim() || 'Custom Reading Passage';
      if (!rawText) {
        showToast('Please paste or enter some text first.');
        return;
      }
      savePlayheadState(true);
      const bookData = window.EpubLoader.parseRawTextIntoBook(rawText, title);
      await saveBookToServerLibrary(bookData, 'text');
      loadBookWithSavedPlayhead(bookData, null);
      el.modalImport.classList.add('hidden');
      showToast(`Saved "${title}" to Library (${bookData.totalWords} words)`);
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.key === '1') {
        state.mode = 'bionic';
        applyVisualModeClasses();
        savePlayheadState(true);
      } else if (e.key === '2') {
        state.mode = 'chunking';
        applyVisualModeClasses();
        savePlayheadState(true);
      } else if (e.key === '3') {
        state.mode = 'rsvp';
        applyVisualModeClasses();
        savePlayheadState(true);
      } else if (e.key === '4') {
        state.mode = 'karaoke';
        applyVisualModeClasses();
        savePlayheadState(true);
      } else if (e.key === '5') {
        state.mode = 'teleprompter';
        applyVisualModeClasses();
        savePlayheadState(true);
      } else if (e.key === 'b' || e.key === 'B') {
        state.bionicEnabled = !state.bionicEnabled;
        el.chkBionicStems.checked = state.bionicEnabled;
        applyVisualModeClasses();
      } else if (e.key === 'l' || e.key === 'L') {
        document.getElementById('btn-open-library').click();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        el.btnPrevSentence.click();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        el.btnNextSentence.click();
      } else if (e.key === '[') {
        setSpeed(state.speed - 0.05, true);
      } else if (e.key === ']') {
        setSpeed(state.speed + 0.05, true);
      } else if (e.key === 't' || e.key === 'T') {
        el.chapterSidebar.classList.toggle('collapsed');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
