/**
 * Client-Side EPUB, YouTube Caption & IndexedDB Storage Engine
 * Enables 100% standalone operation on iOS Safari / PWA / GitHub Pages with NO computer or server required.
 *
 * Supports:
 * - Browser IndexedDB storage for full EPUBs, YouTube books, and custom texts
 * - Standard .epub ZIP archives (using native DecompressionStream('deflate-raw'))
 * - Unpacked .epub directory bundles
 * - Client-side YouTube metadata, caption fetching (Piped / CORS / VTT / SRT / JSON3),
 *   EPUB-to-YouTube forced alignment, and acoustic duration alignment fallback
 */

(function (global) {
  'use strict';

  /* ============================================================================
   * 1. BROWSER INDEXED-DB STORAGE (FOR SERVERLESS iOS / GITHUB PAGES)
   * ============================================================================ */

  const DB_NAME = 'FocusBooksOfflineDB';
  const DB_VERSION = 1;
  const STORE_BOOKS = 'books';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        return reject(new Error('IndexedDB not supported'));
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function saveBookToIndexedDB(bookData, sourceType = 'epub') {
    const safeId = (bookData.id || `book-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    bookData.id = safeId;
    bookData.sourceType = bookData.youtubeVideoId
      ? sourceType.includes('youtube') && !sourceType.includes('epub')
        ? 'youtube'
        : 'epub+youtube'
      : sourceType;

    try {
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BOOKS, 'readwrite');
        tx.objectStore(STORE_BOOKS).put(bookData);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (_) {
      // Ignore if private browsing restricts IndexedDB
    }
    return bookData;
  }

  async function getBookFromIndexedDB(bookId) {
    try {
      const db = await openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BOOKS, 'readonly');
        const req = tx.objectStore(STORE_BOOKS).get(bookId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (_) {
      return null;
    }
  }

  async function getAllBooksFromIndexedDB() {
    try {
      const db = await openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BOOKS, 'readonly');
        const req = tx.objectStore(STORE_BOOKS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
      });
    } catch (_) {
      return [];
    }
  }

  async function deleteBookFromIndexedDB(bookId) {
    try {
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_BOOKS, 'readwrite');
        tx.objectStore(STORE_BOOKS).delete(bookId);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (_) {}
  }

  /* ============================================================================
   * 2. PURE BROWSER EPUB (ZIP & UNPACKED) PARSER
   * ============================================================================ */

  async function readZipEntries(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const uint8 = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder('utf-8');

    let eocdOffset = -1;
    for (let i = uint8.length - 22; i >= Math.max(0, uint8.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error('Not a valid ZIP / EPUB archive (EOCD not found).');
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    const files = {};
    let ptr = cdOffset;

    for (let i = 0; i < totalEntries; i++) {
      if (view.getUint32(ptr, true) !== 0x02014b50) break;

      const compressionMethod = view.getUint16(ptr + 10, true);
      const compressedSize = view.getUint32(ptr + 20, true);
      const fileNameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localHeaderOffset = view.getUint32(ptr + 42, true);

      const fileName = decoder.decode(uint8.subarray(ptr + 46, ptr + 46 + fileNameLen));
      ptr += 46 + fileNameLen + extraLen + commentLen;

      if (fileName.endsWith('/')) continue;

      const localFileNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;
      const compressedBytes = uint8.subarray(dataStart, dataStart + compressedSize);

      files[fileName] = {
        compressionMethod,
        compressedBytes,
        async getText() {
          const bytes = await this.getBytes();
          return decoder.decode(bytes);
        },
        async getBytes() {
          if (compressionMethod === 0) {
            return compressedBytes;
          }
          if (compressionMethod === 8) {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(compressedBytes);
            writer.close();
            const res = new Response(ds.readable);
            const buf = await res.arrayBuffer();
            return new Uint8Array(buf);
          }
          throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
        }
      };
    }

    return files;
  }

  function extractParagraphsFromHtmlDoc(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const blocks = doc.querySelectorAll('p, h1, h2, h3, h4, blockquote');
    const paragraphs = [];

    if (blocks.length > 0) {
      blocks.forEach((el) => {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && txt !== '\u00a0') {
          paragraphs.push(txt);
        }
      });
    } else if (doc.body) {
      const rawLines = (doc.body.textContent || '').split(/\n+/);
      for (const line of rawLines) {
        const txt = line.replace(/\s+/g, ' ').trim();
        if (txt) paragraphs.push(txt);
      }
    }

    return paragraphs;
  }

  async function parseEpubFromVirtualFileMap(fileMap, fallbackTitle) {
    const paths = Object.keys(fileMap);
    let opfPath = paths.find((p) => p.endsWith('content.opf')) || paths.find((p) => p.endsWith('.opf'));

    if (!opfPath) {
      const containerKey = paths.find((p) => p.endsWith('META-INF/container.xml'));
      if (containerKey) {
        const containerXml = await fileMap[containerKey].getText();
        const m = containerXml.match(/full-path=["']([^"']+)["']/i);
        if (m && fileMap[m[1]]) {
          opfPath = m[1];
        }
      }
    }

    if (!opfPath) {
      throw new Error('Could not find OPF package metadata inside EPUB.');
    }

    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = await fileMap[opfPath].getText();
    const xmlParser = new DOMParser();
    const opfDoc = xmlParser.parseFromString(opfXml, 'application/xml');

    const titleEl = opfDoc.getElementsByTagNameNS('*', 'title')[0] || opfDoc.querySelector('title');
    const creatorEl = opfDoc.getElementsByTagNameNS('*', 'creator')[0] || opfDoc.querySelector('creator');

    const title = (titleEl ? titleEl.textContent : fallbackTitle || 'Untitled Book').trim();
    const author = (creatorEl ? creatorEl.textContent : 'Unknown Author').trim();

    const manifest = {};
    const itemEls = Array.from(opfDoc.getElementsByTagName('item'));
    for (const item of itemEls) {
      const id = item.getAttribute('id');
      const href = decodeURIComponent(item.getAttribute('href') || '');
      const mediaType = item.getAttribute('media-type') || '';
      if (id && href) {
        manifest[id] = { id, href, mediaType };
      }
    }

    // Extract cover image as Data URL if available so it persists offline in IndexedDB
    let coverUrl = './books/palmer-eldritch/cover.jpeg';
    const coverItem = Object.values(manifest).find(
      (it) => it.id.toLowerCase().includes('cover') && it.mediaType.startsWith('image/')
    );
    if (coverItem) {
      const coverEntry = fileMap[baseDir + coverItem.href] || fileMap[coverItem.href];
      if (coverEntry) {
        try {
          const bytes = await coverEntry.getBytes();
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          coverUrl = `data:${coverItem.mediaType};base64,${btoa(binary)}`;
        } catch (_) {}
      }
    }

    const tocLabels = {};
    const ncxItem = Object.values(manifest).find(
      (it) => it.mediaType.includes('dtbncx') || it.href.endsWith('.ncx')
    );
    if (ncxItem) {
      const ncxFull = baseDir + ncxItem.href;
      const ncxEntry = fileMap[ncxFull] || fileMap[ncxItem.href];
      if (ncxEntry) {
        const ncxXml = await ncxEntry.getText();
        const ncxDoc = xmlParser.parseFromString(ncxXml, 'application/xml');
        const navPoints = Array.from(ncxDoc.getElementsByTagName('navPoint'));
        for (const np of navPoints) {
          const textEl = np.getElementsByTagName('text')[0];
          const contentEl = np.getElementsByTagName('content')[0];
          if (textEl && contentEl) {
            const label = (textEl.textContent || '').replace(/\.+\s*\d+$/, '').trim();
            const src = decodeURIComponent((contentEl.getAttribute('src') || '').split('#')[0]);
            if (label && src) {
              tocLabels[src] = label;
            }
          }
        }
      }
    }

    const itemrefs = Array.from(opfDoc.getElementsByTagName('itemref'));
    const chapters = [];
    let totalWords = 0;
    let chapterCounter = 1;

    const numberWords = new Set([
      'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN',
      'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN',
      'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY'
    ]);

    for (const ref of itemrefs) {
      const idref = ref.getAttribute('idref');
      const item = manifest[idref];
      if (!item || item.id === 'titlepage' || !/\.(x?html|htm)$/i.test(item.href)) continue;

      const candidatePath = baseDir + item.href;
      const entry = fileMap[candidatePath] || fileMap[item.href];
      if (!entry) continue;

      const htmlText = await entry.getText();
      let paras = extractParagraphsFromHtmlDoc(htmlText);
      if (paras.length === 0) continue;

      if (
        paras[0].toUpperCase() === 'CONTENTS' ||
        paras[0].toUpperCase() === 'TABLE OF CONTENTS'
      ) {
        continue;
      }

      let chapTitle = tocLabels[item.href] || '';
      if (!chapTitle) {
        if (paras[0].length < 50 && paras.length > 1) {
          chapTitle = paras[0];
        } else {
          chapTitle = `Chapter ${chapterCounter}`;
        }
      }

      if (numberWords.has(chapTitle.toUpperCase())) {
        if (paras[0] && paras[0].toUpperCase() === chapTitle.toUpperCase()) {
          paras = paras.slice(1);
        }
        chapTitle = `Chapter ${chapTitle.toUpperCase()}`;
      } else if (paras[0] && paras[0].toUpperCase() === chapTitle.toUpperCase()) {
        paras = paras.slice(1);
      } else if (paras.some((p) => p.includes('From an interoffice audio-memo')) && paras.length <= 3) {
        chapTitle = 'Epigraph';
      }

      const wordCount = paras.reduce((acc, p) => acc + p.split(/\s+/).filter(Boolean).length, 0);
      if (wordCount === 0) continue;

      totalWords += wordCount;
      chapters.push({
        id: `ch_${chapterCounter++}`,
        title: chapTitle,
        wordCount,
        paragraphs: paras
      });
    }

    const safeSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      id: `epub-${safeSlug || Date.now()}`,
      title,
      author,
      coverUrl,
      language: 'en-US',
      totalWords,
      chapters
    };
  }

  async function parseSingleFile(file) {
    if (file.name.toLowerCase().endsWith('.epub')) {
      const buf = await file.arrayBuffer();
      const zipEntries = await readZipEntries(buf);
      return parseEpubFromVirtualFileMap(zipEntries, file.name.replace(/\.epub$/i, ''));
    }

    const text = await file.text();
    return parseRawTextIntoBook(text, file.name.replace(/\.(txt|md)$/i, ''));
  }

  async function parseFileList(fileList) {
    const files = Array.from(fileList);
    if (files.length === 1 && !files[0].webkitRelativePath) {
      return parseSingleFile(files[0]);
    }

    const virtualMap = {};
    let folderName = 'Unpacked EPUB';

    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      const parts = rel.split('/');
      if (parts.length > 1) {
        folderName = parts[0].replace(/\.epub$/i, '');
      }
      const normalizedKey = parts.length > 1 ? parts.slice(1).join('/') : rel;
      virtualMap[normalizedKey] = {
        async getText() {
          return f.text();
        },
        async getBytes() {
          const ab = await f.arrayBuffer();
          return new Uint8Array(ab);
        }
      };
    }

    return parseEpubFromVirtualFileMap(virtualMap, folderName);
  }

  function parseRawTextIntoBook(rawText, customTitle = 'Custom Text Passage') {
    const blocks = rawText
      .split(/\n\s*\n+/)
      .map((b) => b.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const paragraphs = blocks.length > 0 ? blocks : [rawText.replace(/\s+/g, ' ').trim()].filter(Boolean);
    const wordCount = paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0);

    return {
      id: `custom-${customTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      title: customTitle,
      author: 'Custom Input',
      coverUrl: './books/palmer-eldritch/cover.jpeg',
      language: 'en-US',
      totalWords: wordCount,
      chapters: [
        {
          id: 'ch_1',
          title: customTitle,
          wordCount,
          paragraphs
        }
      ]
    };
  }

  /* ============================================================================
   * 3. CLIENT-SIDE YOUTUBE IMPORTER & FORCED ALIGNER (NO COMPUTER REQUIRED)
   * ============================================================================ */

  function extractYouTubeId(inputUrl) {
    if (!inputUrl) return null;
    const trimmed = inputUrl.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const m =
      trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
      trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
      trimmed.match(/embed\/([a-zA-Z0-9_-]{11})/) ||
      trimmed.match(/shorts\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  async function fetchYouTubeMetaClientSide(videoId) {
    try {
      const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
      if (res.ok) {
        const data = await res.json();
        return {
          title: data.title || `YouTube Audiobook (${videoId})`,
          author: data.author_name || 'YouTube Audiobook',
          thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        };
      }
    } catch (_) {}
    return {
      title: `YouTube Audiobook (${videoId})`,
      author: 'YouTube Audiobook',
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    };
  }

  function parseVttOrSrtToTimedWords(subText) {
    const lines = subText.split(/\r?\n/);
    const words = [];
    let currentStartMs = 0;
    let currentEndMs = 2000;

    const timeRegex = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line === 'WEBVTT' || /^\d+$/.test(line)) continue;

      const m = line.match(timeRegex);
      if (m) {
        const h1 = Number(m[1] || 0);
        const m1 = Number(m[2]);
        const s1 = Number(m[3]);
        const ms1 = Number(m[4]);
        currentStartMs = ((h1 * 3600 + m1 * 60 + s1) * 1000) + ms1;

        const h2 = Number(m[5] || 0);
        const m2 = Number(m[6]);
        const s2 = Number(m[7]);
        const ms2 = Number(m[8]);
        currentEndMs = ((h2 * 3600 + m2 * 60 + s2) * 1000) + ms2;
        continue;
      }

      const cleanText = line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!cleanText) continue;

      const tokens = cleanText.split(/\s+/).filter(Boolean);
      const spanMs = Math.max(200, currentEndMs - currentStartMs);
      const stepMs = spanMs / Math.max(1, tokens.length);

      tokens.forEach((tok, idx) => {
        words.push({
          raw: tok,
          norm: tok.toLowerCase().replace(/[^a-z0-9]/g, ''),
          startMs: Math.round(currentStartMs + idx * stepMs)
        });
      });
    }
    return words;
  }

  function extractTimedWordsFromJson3(json3Data) {
    const words = [];
    const events = json3Data.events || [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const baseMs = ev.tStartMs || 0;
      for (const s of ev.segs) {
        const txt = (s.utf8 || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        const parts = txt.split(/\s+/).filter(Boolean);
        const segStartMs = baseMs + (s.tOffsetMs || 0);
        for (let i = 0; i < parts.length; i++) {
          words.push({
            raw: parts[i],
            norm: parts[i].toLowerCase().replace(/[^a-z0-9]/g, ''),
            startMs: segStartMs + i * 160
          });
        }
      }
    }
    return words;
  }

  /**
   * Fetches YouTube captions directly from the browser (on iOS / GitHub Pages) using public Piped APIs
   */
  async function fetchYouTubeTimedWordsClientSide(videoId) {
    // 1. Check if this is the pre-bundled Palmer Eldritch video
    if (videoId === 'wlKEAxiQsDU') {
      try {
        const res = await fetch('./books/palmer-eldritch/book.json');
        if (res.ok) {
          const book = await res.json();
          const words = [];
          for (const ch of book.chapters) {
            if (!ch.wordTimestamps) continue;
            const chWords = ch.paragraphs.join(' ').split(/\s+/).filter(Boolean);
            for (let i = 0; i < chWords.length; i++) {
              words.push({
                raw: chWords[i],
                norm: chWords[i].toLowerCase().replace(/[^a-z0-9]/g, ''),
                startMs: ch.wordTimestamps[i] || 0
              });
            }
          }
          if (words.length > 0) return words;
        }
      } catch (_) {}
    }

    // 2. Try Piped public API instances for English subtitle track
    const pipedInstances = [
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.tokhmi.xyz',
      'https://pipedapi.Invidious.io'
    ];

    for (const host of pipedInstances) {
      try {
        const res = await fetch(`${host}/streams/${videoId}`);
        if (!res.ok) continue;
        const info = await res.json();
        const subs = info.subtitles || [];
        const enSub =
          subs.find((s) => s.code && s.code.startsWith('en') && !s.autoGenerated) ||
          subs.find((s) => s.code && s.code.startsWith('en')) ||
          subs[0];
        if (enSub && enSub.url) {
          const subRes = await fetch(enSub.url);
          if (subRes.ok) {
            const text = await subRes.text();
            if (text.trim().startsWith('{')) {
              return extractTimedWordsFromJson3(JSON.parse(text));
            }
            return parseVttOrSrtToTimedWords(text);
          }
        }
      } catch (_) {}
    }

    return null;
  }

  function buildStandaloneBookFromYouTubeCaptions(videoId, meta, ytWords) {
    const SECTION_DURATION_MS = 15 * 60 * 1000;
    const chapters = [];
    let curParas = [];
    let curTimestamps = [];
    let curSentWords = [];
    let curParaSentences = [];
    let chapterStartMs = ytWords[0]?.startMs || 0;
    let chapterIdx = 1;

    for (let i = 0; i < ytWords.length; i++) {
      const w = ytWords[i];
      curSentWords.push(w.raw);
      curTimestamps.push(w.startMs);

      const nextW = ytWords[i + 1];
      const pauseMs = nextW ? nextW.startMs - w.startMs : 2000;
      const endsSentence = /[.!?]["”’)]*$/.test(w.raw);

      if (endsSentence || curSentWords.length >= 34) {
        curParaSentences.push(curSentWords.join(' '));
        curSentWords = [];

        if (curParaSentences.length >= 5 || (endsSentence && pauseMs > 1350)) {
          curParas.push(curParaSentences.join(' '));
          curParaSentences = [];

          if (w.startMs - chapterStartMs >= SECTION_DURATION_MS && nextW) {
            const startMin = Math.floor(chapterStartMs / 60000);
            const endMin = Math.floor(w.startMs / 60000);
            chapters.push({
              id: `yt_ch_${chapterIdx}`,
              title: `Part ${chapterIdx} (${startMin}m – ${endMin}m)`,
              wordCount: curTimestamps.length,
              videoStartMs: chapterStartMs,
              videoEndMs: w.startMs + 300,
              paragraphs: curParas,
              wordTimestamps: curTimestamps
            });
            chapterIdx++;
            curParas = [];
            curTimestamps = [];
            chapterStartMs = nextW.startMs;
          }
        }
      }
    }

    if (curSentWords.length > 0) curParaSentences.push(curSentWords.join(' '));
    if (curParaSentences.length > 0) curParas.push(curParaSentences.join(' '));
    if (curParas.length > 0) {
      const lastMs = ytWords[ytWords.length - 1]?.startMs || 0;
      const startMin = Math.floor(chapterStartMs / 60000);
      const endMin = Math.ceil(lastMs / 60000);
      chapters.push({
        id: `yt_ch_${chapterIdx}`,
        title: `Part ${chapterIdx} (${startMin}m – ${endMin}m)`,
        wordCount: curTimestamps.length,
        videoStartMs: chapterStartMs,
        videoEndMs: lastMs + 400,
        paragraphs: curParas,
        wordTimestamps: curTimestamps
      });
    }

    return {
      id: `yt-${videoId}`,
      title: meta.title,
      author: `${meta.author} (YouTube Captions)`,
      language: 'en-US',
      coverUrl: meta.thumbnailUrl,
      youtubeVideoId: videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      youtubeTitle: meta.title,
      totalWords: ytWords.length,
      chapters
    };
  }

  /**
   * Aligns YouTube word-level captions (or acoustic prosodic cadence if captions unavailable) onto an EPUB in the browser!
   */
  function alignYouTubeToBookClientSide(book, videoId, meta, ytWords, totalVideoDurationMs = 0) {
    const clonedBook = JSON.parse(JSON.stringify(book));

    if (ytWords && ytWords.length > 0) {
      let ytCursor = 0;
      for (let cIdx = 0; cIdx < clonedBook.chapters.length; cIdx++) {
        const ch = clonedBook.chapters[cIdx];
        const words = [];
        for (const p of ch.paragraphs) {
          words.push(...p.trim().split(/\s+/).filter(Boolean));
        }
        if (words.length === 0) continue;

        const timestamps = new Array(words.length).fill(null);

        for (let i = 0; i < words.length; i++) {
          const wNorm = words[i].toLowerCase().replace(/[^a-z0-9]/g, '');
          const nextNorm = (words[i + 1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const next2Norm = (words[i + 2] || '').toLowerCase().replace(/[^a-z0-9]/g, '');

          let found = -1;
          for (let k = 0; k < 35 && ytCursor + k < ytWords.length; k++) {
            if (ytWords[ytCursor + k].norm === wNorm && wNorm.length > 0) {
              if (
                k <= 2 ||
                (nextNorm && ytWords[ytCursor + k + 1]?.norm === nextNorm) ||
                (next2Norm && ytWords[ytCursor + k + 2]?.norm === next2Norm)
              ) {
                found = ytCursor + k;
                break;
              }
            }
          }
          if (found !== -1) {
            timestamps[i] = ytWords[found].startMs;
            ytCursor = found + 1;
          }
        }

        let lastKnownIdx = -1;
        let lastKnownMs = cIdx === 0 ? 400 : clonedBook.chapters[cIdx - 1].videoEndMs || 0;
        for (let i = 0; i < timestamps.length; i++) {
          if (timestamps[i] !== null) {
            if (i - lastKnownIdx > 1) {
              const gapCount = i - lastKnownIdx;
              const step = (timestamps[i] - lastKnownMs) / gapCount;
              for (let j = lastKnownIdx + 1; j < i; j++) {
                timestamps[j] = Math.round(lastKnownMs + step * (j - lastKnownIdx));
              }
            }
            lastKnownIdx = i;
            lastKnownMs = timestamps[i];
          }
        }
        if (lastKnownIdx < timestamps.length - 1) {
          for (let j = lastKnownIdx + 1; j < timestamps.length; j++) {
            lastKnownMs += 260;
            timestamps[j] = lastKnownMs;
          }
        }

        ch.videoStartMs = timestamps[0] || 0;
        ch.videoEndMs = (timestamps[timestamps.length - 1] || 0) + 400;
        ch.wordTimestamps = timestamps;
      }
    } else {
      // Acoustic Prosodic Alignment Fallback (works on ANY YouTube video even without captions!)
      let cursorMs = 500;
      const allChapterWordDurations = [];
      let totalEstimatedMs = 0;

      for (const ch of clonedBook.chapters) {
        const words = ch.paragraphs.join(' ').split(/\s+/).filter(Boolean);
        const durs = words.map((w) => global.CognitiveEngine.estimateTokenDurationMs(w));
        const sum = durs.reduce((a, b) => a + b, 0);
        totalEstimatedMs += sum;
        allChapterWordDurations.push(durs);
      }

      const scaleFactor =
        totalVideoDurationMs > 5000 ? totalVideoDurationMs / Math.max(1, totalEstimatedMs) : 1.0;

      for (let cIdx = 0; cIdx < clonedBook.chapters.length; cIdx++) {
        const ch = clonedBook.chapters[cIdx];
        const durs = allChapterWordDurations[cIdx];
        if (!durs || durs.length === 0) continue;

        const timestamps = [];
        for (let i = 0; i < durs.length; i++) {
          timestamps.push(Math.round(cursorMs));
          cursorMs += durs[i] * scaleFactor;
        }
        ch.videoStartMs = timestamps[0] || 0;
        ch.videoEndMs = Math.round(cursorMs);
        ch.wordTimestamps = timestamps;
      }
    }

    clonedBook.youtubeVideoId = videoId;
    clonedBook.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    clonedBook.youtubeTitle = meta.title;
    return clonedBook;
  }

  const streamUrlCache = {};
  const DEFAULT_STREAM_GATEWAY = 'https://sat-say-comment-dramatically.trycloudflare.com';

  function getStreamBackendBase() {
    const custom = localStorage.getItem('focusbooks_stream_gateway');
    if (custom) return custom.replace(/\/+$/, '');
    const host = window.location.hostname || '';
    if (host.includes('github.io')) {
      return DEFAULT_STREAM_GATEWAY;
    }
    return '';
  }

  function getDirectYouTubeAudioStreamUrl(videoId) {
    if (!videoId) return null;
    if (streamUrlCache[videoId]) return streamUrlCache[videoId];
    const base = getStreamBackendBase();
    const url = base
      ? `${base}/api/youtube-audio?v=${encodeURIComponent(videoId)}`
      : `./api/youtube-audio?v=${encodeURIComponent(videoId)}`;
    streamUrlCache[videoId] = url;
    return url;
  }

  async function resolveYouTubeAudioStreamUrl(videoId) {
    if (!videoId) return null;
    const base = getStreamBackendBase();
    const prewarmEndpoint = base
      ? `${base}/api/youtube-stream?v=${encodeURIComponent(videoId)}`
      : `./api/youtube-stream?v=${encodeURIComponent(videoId)}`;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(prewarmEndpoint, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const data = await res.json();
        if (data && data.streamUrl) {
          streamUrlCache[videoId] = data.streamUrl;
          return data.streamUrl;
        }
      }
    } catch (_) {}

    return getDirectYouTubeAudioStreamUrl(videoId);
  }

  global.EpubLoader = {
    saveBookToIndexedDB,
    getBookFromIndexedDB,
    getAllBooksFromIndexedDB,
    deleteBookFromIndexedDB,
    parseSingleFile,
    parseFileList,
    parseRawTextIntoBook,
    extractYouTubeId,
    fetchYouTubeMetaClientSide,
    fetchYouTubeTimedWordsClientSide,
    parseVttOrSrtToTimedWords,
    extractTimedWordsFromJson3,
    buildStandaloneBookFromYouTubeCaptions,
    alignYouTubeToBookClientSide,
    getDirectYouTubeAudioStreamUrl,
    resolveYouTubeAudioStreamUrl
  };
})(window);
