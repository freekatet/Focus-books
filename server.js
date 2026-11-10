const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOOKS_DIR = path.join(PUBLIC_DIR, 'books');
const YT_CACHE_DIR = path.join(BOOKS_DIR, 'yt-cache');
const SAVED_BOOKS_DIR = path.join(BOOKS_DIR, 'saved');
const COVERS_DIR = path.join(BOOKS_DIR, 'covers');
const LIBRARY_INDEX_PATH = path.join(BOOKS_DIR, 'library.json');
const DEFAULT_DESKTOP_EPUB = '/Users/frexkatet/Desktop/The Three Stigmata of Palmer Eldritch.epub';
const APPLE_BOOKS_ICLOUD_DIR = path.join(
  os.homedir(),
  'Library/Mobile Documents/iCloud~com~apple~iBooks/Documents'
);

fs.mkdirSync(YT_CACHE_DIR, { recursive: true });
fs.mkdirSync(SAVED_BOOKS_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4'
};

/* ============================================================================
 * PERSISTENT LIBRARY & PLAYHEAD STATE MANAGER
 * ============================================================================ */

function loadLibraryState() {
  if (fs.existsSync(LIBRARY_INDEX_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(LIBRARY_INDEX_PATH, 'utf-8'));
    } catch (_) {}
  }

  // Initialize default library with pre-loaded Palmer Eldritch (EPUB + YouTube Sync)
  const initial = {
    lastActiveBookId: 'palmer-eldritch',
    settings: {
      theme: 'bw-dark',
      fontSize: 20,
      lineHeight: 2.0,
      dimOpacity: 0.45,
      bionicEnabled: true,
      bionicDelta: 0
    },
    books: [
      {
        id: 'palmer-eldritch',
        title: 'The Three Stigmata of Palmer Eldritch',
        author: 'Philip K. Dick',
        coverUrl: '/books/palmer-eldritch/cover.jpeg',
        sourceType: 'epub+youtube',
        youtubeVideoId: 'wlKEAxiQsDU',
        youtubeUrl: 'https://www.youtube.com/watch?v=wlKEAxiQsDU',
        totalWords: 70414,
        chapterCount: 15,
        dataUrl: '/books/palmer-eldritch/book.json',
        progress: {
          chapterIndex: 1,
          chapterTitle: 'Chapter ONE',
          tokenIndex: 0,
          videoTimeMs: 30800,
          overallProgressPct: 0,
          speed: 1.0,
          mode: 'bionic',
          audioEngine: 'youtube',
          updatedAt: new Date().toISOString()
        }
      }
    ]
  };
  saveLibraryState(initial);
  return initial;
}

function saveLibraryState(libState) {
  fs.writeFileSync(LIBRARY_INDEX_PATH, JSON.stringify(libState, null, 2), 'utf-8');
}

function registerOrUpdateBookInLibrary(bookData, sourceType = 'epub', keepActiveId = false) {
  const lib = loadLibraryState();
  const safeId = (bookData.id || `book-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
  bookData.id = safeId;

  let dataUrl = `./books/saved/${safeId}.json`;
  if (safeId === 'palmer-eldritch') {
    dataUrl = './books/palmer-eldritch/book.json';
    fs.writeFileSync(path.join(BOOKS_DIR, 'palmer-eldritch', 'book.json'), JSON.stringify(bookData), 'utf-8');
  } else {
    fs.writeFileSync(path.join(SAVED_BOOKS_DIR, `${safeId}.json`), JSON.stringify(bookData), 'utf-8');
  }

  const existingIdx = lib.books.findIndex((b) => b.id === safeId);
  const startChapIdx = bookData.chapters && bookData.chapters.length > 1 && bookData.chapters[0].title === 'Epigraph' ? 1 : 0;
  const firstChap = bookData.chapters?.[startChapIdx] || bookData.chapters?.[0] || { title: 'Chapter 1', videoStartMs: 0 };

  const detectedSourceType = bookData.youtubeVideoId
    ? sourceType.includes('youtube') && !sourceType.includes('epub')
      ? 'youtube'
      : 'epub+youtube'
    : sourceType;

  const summaryEntry = {
    id: safeId,
    title: bookData.title || 'Untitled Book',
    author: bookData.author || 'Unknown Author',
    coverUrl: bookData.coverUrl || './books/palmer-eldritch/cover.jpeg',
    sourceType: detectedSourceType,
    youtubeVideoId: bookData.youtubeVideoId || '',
    youtubeUrl: bookData.youtubeUrl || '',
    sourcePath: bookData.sourcePath || '',
    totalWords: bookData.totalWords || 0,
    chapterCount: bookData.chapters ? bookData.chapters.length : 1,
    dataUrl,
    progress:
      existingIdx >= 0 && lib.books[existingIdx].progress
        ? lib.books[existingIdx].progress
        : {
            chapterIndex: startChapIdx,
            chapterTitle: firstChap.title || 'Chapter 1',
            tokenIndex: 0,
            videoTimeMs: firstChap.videoStartMs || 0,
            overallProgressPct: 0,
            speed: 1.0,
            mode: 'bionic',
            audioEngine: bookData.youtubeVideoId ? 'youtube' : 'webspeech',
            updatedAt: new Date().toISOString()
          }
  };

  if (existingIdx >= 0) {
    lib.books[existingIdx] = summaryEntry;
  } else {
    lib.books.push(summaryEntry);
  }

  if (!keepActiveId) {
    lib.lastActiveBookId = safeId;
  }
  saveLibraryState(lib);
  return summaryEntry;
}

function readJsonBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const str = Buffer.concat(chunks).toString('utf-8');
        resolve(str ? JSON.parse(str) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/* ============================================================================
 * EPUB PARSING UTILITIES
 * ============================================================================ */

function stripHtmlTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractParagraphsFromXhtml(xhtml) {
  const bodyMatch = xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let content = bodyMatch ? bodyMatch[1] : xhtml;
  content = content.replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/gi, '');

  const pParagraphs = [];
  const blockRegex = /<(p|h1|h2|h3|h4|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockRegex.exec(content)) !== null) {
    const text = stripHtmlTags(match[2]);
    if (text && text !== '\u00a0') {
      pParagraphs.push(text);
    }
  }

  const leafDivParagraphs = [];
  const leafBlockRegex = /<(p|h1|h2|h3|h4|blockquote|div|li)[^>]*>((?:(?!<(?:p|h1|h2|h3|h4|blockquote|div|li)\b)[\s\S])*?)<\/\1>/gi;
  while ((match = leafBlockRegex.exec(content)) !== null) {
    const text = stripHtmlTags(match[2]);
    if (text && text !== '\u00a0') {
      leafDivParagraphs.push(text);
    }
  }

  const pWords = pParagraphs.reduce((s, p) => s + p.split(/\s+/).length, 0);
  const divWords = leafDivParagraphs.reduce((s, p) => s + p.split(/\s+/).length, 0);
  return divWords > pWords * 1.2 ? leafDivParagraphs : pParagraphs;
}

function findOpfFile(epubDir) {
  const containerXmlPath = path.join(epubDir, 'META-INF', 'container.xml');
  if (fs.existsSync(containerXmlPath)) {
    const xml = fs.readFileSync(containerXmlPath, 'utf-8');
    const match = xml.match(/full-path=["']([^"']+)["']/i);
    if (match) {
      const candidate = path.join(epubDir, match[1]);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const directOpf = path.join(epubDir, 'content.opf');
  if (fs.existsSync(directOpf)) return directOpf;
  return null;
}

function extractOrGenerateCoverForBook(bookId, title, author, epubPath, baseDir, manifest) {
  if (bookId === 'palmer-eldritch' || bookId === 'the-three-stigmata-of-palmer-eldritch') {
    return './books/palmer-eldritch/cover.jpeg';
  }

  let foundCoverPath = null;
  for (const d of [epubPath, baseDir]) {
    for (const f of ['cover.jpeg', 'cover.jpg', 'cover.png', 'images/cover.jpg', 'images/cover.jpeg', 'Images/cover.jpg', 'images/cover.bmp']) {
      const p = path.join(d, f);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        foundCoverPath = p;
        break;
      }
    }
    if (foundCoverPath) break;
  }

  if (!foundCoverPath) {
    const items = Object.values(manifest);
    const coverItem =
      items.find((it) => it.mediaType.startsWith('image/') && /cover/i.test(`${it.id} ${it.href} ${it.props || ''}`)) ||
      items.find((it) => it.mediaType.startsWith('image/'));
    if (coverItem) {
      const p = path.join(baseDir, coverItem.href);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        foundCoverPath = p;
      }
    }
  }

  if (foundCoverPath) {
    const ext = path.extname(foundCoverPath).toLowerCase() || '.jpg';
    const destName = `${bookId}${ext}`;
    const destPath = path.join(COVERS_DIR, destName);
    try {
      fs.copyFileSync(foundCoverPath, destPath);
      return `./books/covers/${destName}`;
    } catch (_) {}
  }

  // Generate a stylized SVG book cover when the EPUB does not embed an image
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const words = String(title).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 16 && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  const titleSvg = lines
    .slice(0, 4)
    .map((ln, idx) => `<tspan x="150" dy="${idx === 0 ? 0 : 34}">${esc(ln)}</tspan>`)
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450" width="300" height="450">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141824"/>
      <stop offset="100%" stop-color="#090b10"/>
    </linearGradient>
  </defs>
  <rect width="300" height="450" rx="12" fill="url(#bg)" stroke="#f59e0b" stroke-width="3"/>
  <rect x="18" y="18" width="264" height="414" rx="6" fill="none" stroke="rgba(245,158,11,0.3)" stroke-width="1.5"/>
  <text x="150" y="140" text-anchor="middle" fill="#f8fafc" font-family="Georgia, serif" font-size="26" font-weight="bold">${titleSvg}</text>
  <line x1="90" y1="295" x2="210" y2="295" stroke="#f59e0b" stroke-width="2"/>
  <text x="150" y="335" text-anchor="middle" fill="#f59e0b" font-family="system-ui, sans-serif" font-size="16" font-weight="600">${esc(author)}</text>
  <text x="150" y="405" text-anchor="middle" fill="#64748b" font-family="monospace" font-size="11" letter-spacing="2">APPLE BOOKS EDITION</text>
</svg>`;
  const svgName = `${bookId}.svg`;
  fs.writeFileSync(path.join(COVERS_DIR, svgName), svg, 'utf-8');
  return `./books/covers/${svgName}`;
}

function splitParagraphsByInternalChapters(paras, fallbackTitle) {
  const wordCount = paras.reduce((s, p) => s + p.split(/\s+/).filter(Boolean).length, 0);
  if (wordCount < 4500) {
    return [{ title: fallbackTitle, paragraphs: paras }];
  }

  const chapterHeadingRegex = /^(?:CHAPTER|BOOK|PART)\s+(?:[IVXLCDM]+|\d+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY)\b(?:\s*[:.-]?\s*.*)?$/i;
  const sections = [];
  let currentTitle = fallbackTitle;
  let currentParas = [];

  for (const p of paras) {
    const trimmed = p.trim();
    if (trimmed.length <= 75 && chapterHeadingRegex.test(trimmed)) {
      if (currentParas.length > 0) {
        sections.push({ title: currentTitle, paragraphs: currentParas });
        currentParas = [];
      }
      currentTitle = trimmed;
    } else {
      currentParas.push(p);
    }
  }
  if (currentParas.length > 0) {
    sections.push({ title: currentTitle, paragraphs: currentParas });
  }
  return sections.length > 1 ? sections : [{ title: fallbackTitle, paragraphs: paras }];
}

function parseUnpackedEpubDir(epubPath) {
  const opfPath = findOpfFile(epubPath);
  if (!opfPath) {
    throw new Error(`Could not find content.opf in ${epubPath}`);
  }
  const baseDir = path.dirname(opfPath);
  const opfXml = fs.readFileSync(opfPath, 'utf-8');

  const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const creatorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  let title = titleMatch ? stripHtmlTags(titleMatch[1]) : path.basename(epubPath, '.epub');
  let author = creatorMatch ? stripHtmlTags(creatorMatch[1]) : 'Unknown Author';

  if (title.toLowerCase() === 'annilihation' || title.toLowerCase() === 'annihilation') {
    title = 'Annihilation';
    if (author === 'Unknown' || author === 'Unknown Author') author = 'Jeff VanderMeer';
  }
  if (author.includes(',')) {
    const parts = author.split(',').map((s) => s.trim());
    if (parts.length === 2) author = `${parts[1]} ${parts[0]}`;
  }

  const manifest = {};
  const itemRegex = /<item\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = itemRegex.exec(opfXml)) !== null) {
    const attrs = m[1];
    const idMatch = attrs.match(/id=["']([^"']+)["']/i);
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    const mediaMatch = attrs.match(/media-type=["']([^"']+)["']/i);
    const propMatch = attrs.match(/properties=["']([^"']+)["']/i);
    if (idMatch && hrefMatch) {
      manifest[idMatch[1]] = {
        id: idMatch[1],
        href: decodeURIComponent(hrefMatch[1]),
        mediaType: mediaMatch ? mediaMatch[1] : '',
        props: propMatch ? propMatch[1] : ''
      };
    }
  }

  const tocLabels = {};
  const ncxItem = Object.values(manifest).find(
    (it) => it.mediaType.includes('dtbncx') || it.href.endsWith('.ncx')
  );
  if (ncxItem) {
    const ncxPath = path.join(baseDir, ncxItem.href);
    if (fs.existsSync(ncxPath)) {
      const ncxXml = fs.readFileSync(ncxPath, 'utf-8');
      const navPointRegex = /<navPoint[^>]*>[\s\S]*?<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\s+src=["']([^"'#]+)(?:#[^"']*)?["']/gi;
      let nm;
      while ((nm = navPointRegex.exec(ncxXml)) !== null) {
        const label = stripHtmlTags(nm[1]).replace(/\.+\s*\d+$/, '').trim();
        const src = decodeURIComponent(nm[2]);
        tocLabels[src] = label;
      }
    }
  }

  const spineIds = [];
  const itemrefRegex = /<itemref\s+[^>]*idref=["']([^"']+)["'][^>]*\/?>/gi;
  while ((m = itemrefRegex.exec(opfXml)) !== null) {
    spineIds.push(m[1]);
  }

  const chapters = [];
  let totalWords = 0;
  let chapterIndex = 1;

  for (const idref of spineIds) {
    const item = manifest[idref];
    if (!item || !item.href.match(/\.(x?html|htm)$/i)) continue;
    if (item.id === 'titlepage') continue;

    const fullPath = path.join(baseDir, item.href);
    if (!fs.existsSync(fullPath)) continue;

    const html = fs.readFileSync(fullPath, 'utf-8');
    let paras = extractParagraphsFromXhtml(html);
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
        chapTitle = `Section ${chapterIndex}`;
      }
    }

    const romanOrWordNums = [
      'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN',
      'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN',
      'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY'
    ];
    if (romanOrWordNums.includes(chapTitle.toUpperCase())) {
      if (paras[0] && paras[0].toUpperCase() === chapTitle.toUpperCase()) {
        paras = paras.slice(1);
      }
      chapTitle = `Chapter ${chapTitle.toUpperCase()}`;
    } else if (paras[0] && paras[0].toUpperCase() === chapTitle.toUpperCase()) {
      paras = paras.slice(1);
    } else if (paras.some((p) => p.includes('From an interoffice audio-memo')) && paras.length <= 3) {
      chapTitle = 'Epigraph';
    }

    const subSections = splitParagraphsByInternalChapters(paras, chapTitle);
    for (const sec of subSections) {
      const wordCount = sec.paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0);
      if (wordCount === 0) continue;

      totalWords += wordCount;
      chapters.push({
        id: `ch_${chapterIndex++}`,
        title: sec.title,
        wordCount,
        paragraphs: sec.paragraphs
      });
    }
  }

  const rawId = path.basename(epubPath, '.epub').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const bookId = rawId === 'the-three-stigmata-of-palmer-eldritch' ? 'palmer-eldritch' : rawId;
  const coverUrl = extractOrGenerateCoverForBook(bookId, title, author, epubPath, baseDir, manifest);

  return {
    id: bookId,
    title,
    author,
    language: 'en-US',
    sourcePath: epubPath,
    coverUrl,
    totalWords,
    chapters
  };
}

function syncAppleBooksLibrary() {
  if (!fs.existsSync(APPLE_BOOKS_ICLOUD_DIR)) {
    throw new Error(`Apple Books iCloud directory not found at ${APPLE_BOOKS_ICLOUD_DIR}`);
  }
  const entries = fs.readdirSync(APPLE_BOOKS_ICLOUD_DIR).filter((name) => name.endsWith('.epub'));
  const imported = [];

  for (const name of entries) {
    const fullPath = path.join(APPLE_BOOKS_ICLOUD_DIR, name);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      // Preserve our YouTube-synced Palmer Eldritch book so we don't overwrite its 70,309 word timestamps
      if (name.toLowerCase().includes('palmer eldritch')) continue;
      const bookData = parseUnpackedEpubDir(fullPath);
      if (bookData.totalWords > 0 && bookData.chapters.length > 0) {
        const summary = registerOrUpdateBookInLibrary(bookData, 'epub', true);
        imported.push(summary);
      }
    } catch (err) {
      console.warn(`Skipped ${name}: ${err.message}`);
    }
  }
  return { count: imported.length, books: imported, library: loadLibraryState() };
}

/* ============================================================================
 * YOUTUBE AUDIOBOOK & WORD-LEVEL JSON3 CAPTION IMPORTER / ALIGNER
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

function fetchYouTubeOEmbed(videoId) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    https
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({
              title: parsed.title || `YouTube Audiobook (${videoId})`,
              author: parsed.author_name || 'YouTube Audiobook',
              thumbnailUrl: parsed.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          } catch (_) {
            resolve({
              title: `YouTube Audiobook (${videoId})`,
              author: 'YouTube Audiobook',
              thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            });
          }
        });
      })
      .on('error', () => {
        resolve({
          title: `YouTube Audiobook (${videoId})`,
          author: 'YouTube Audiobook',
          thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        });
      });
  });
}

function ensureYouTubeJson3Captions(videoId) {
  return new Promise((resolve, reject) => {
    const cachedPath = path.join(YT_CACHE_DIR, `${videoId}.json3`);
    if (fs.existsSync(cachedPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(cachedPath, 'utf-8'));
        return resolve(data);
      } catch (_) {}
    }

    const outTemplate = path.join(YT_CACHE_DIR, `dl_${videoId}`);
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--js-runtimes', 'node',
      '--no-simulate',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', 'en.*',
      '--sub-format', 'json3',
      '--skip-download',
      '-o', outTemplate,
      ytUrl
    ];

    execFile('yt-dlp', args, { timeout: 45000 }, (err) => {
      const files = fs.readdirSync(YT_CACHE_DIR).filter((f) => f.startsWith(`dl_${videoId}`) && f.endsWith('.json3'));
      if (files.length === 0) {
        return reject(new Error(err ? err.message : 'No English captions found on this YouTube video.'));
      }
      const chosenFile = path.join(YT_CACHE_DIR, files[0]);
      fs.copyFileSync(chosenFile, cachedPath);
      files.forEach((f) => {
        try {
          fs.unlinkSync(path.join(YT_CACHE_DIR, f));
        } catch (_) {}
      });

      try {
        const data = JSON.parse(fs.readFileSync(cachedPath, 'utf-8'));
        resolve(data);
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
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

function alignYouTubeCaptionsToBook(book, videoId, meta, ytWords) {
  let ytCursor = 0;

  for (let cIdx = 0; cIdx < book.chapters.length; cIdx++) {
    const ch = book.chapters[cIdx];
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
    let lastKnownMs = cIdx === 0 ? 400 : book.chapters[cIdx - 1].videoEndMs || 0;
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

  book.youtubeVideoId = videoId;
  book.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  book.youtubeTitle = meta.title;
  return book;
}

/* ============================================================================
 * HTTP SERVER & API ROUTES
 * ============================================================================ */

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // API: Get Library Index & Saved Playhead States
  if (pathname === '/api/library' && req.method === 'GET') {
    const lib = loadLibraryState();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(lib));
    return;
  }

  // API: Save newly uploaded/parsed book into Persistent Library
  if (pathname === '/api/library/save-book' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      if (!payload.book) throw new Error('Missing book object');
      const entry = registerOrUpdateBookInLibrary(payload.book, payload.sourceType || 'epub');
      const lib = loadLibraryState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ entry, library: lib }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Save Playhead Position & Reader Settings
  if (pathname === '/api/library/progress' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const lib = loadLibraryState();

      if (payload.bookId) {
        lib.lastActiveBookId = payload.bookId;
        const bookEntry = lib.books.find((b) => b.id === payload.bookId);
        if (bookEntry && payload.progress) {
          bookEntry.progress = {
            ...bookEntry.progress,
            ...payload.progress,
            updatedAt: new Date().toISOString()
          };
        }
      }

      if (payload.settings) {
        lib.settings = { ...lib.settings, ...payload.settings };
      }

      saveLibraryState(lib);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Delete book from Library
  if (pathname === '/api/library/book' && req.method === 'DELETE') {
    const id = parsedUrl.searchParams.get('id');
    const lib = loadLibraryState();
    lib.books = lib.books.filter((b) => b.id !== id);
    if (lib.lastActiveBookId === id) {
      lib.lastActiveBookId = lib.books[0]?.id || '';
    }
    saveLibraryState(lib);
    const savedFile = path.join(SAVED_BOOKS_DIR, `${id}.json`);
    if (fs.existsSync(savedFile)) {
      try {
        fs.unlinkSync(savedFile);
      } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(lib));
    return;
  }

  // API 1: Load local EPUB from disk & save to Library
  if (pathname === '/api/load-epub' && req.method === 'GET') {
    const targetPath = parsedUrl.searchParams.get('path') || DEFAULT_DESKTOP_EPUB;
    try {
      if (!fs.existsSync(targetPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `File not found: ${targetPath}` }));
        return;
      }
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const bookData = parseUnpackedEpubDir(targetPath);
        registerOrUpdateBookInLibrary(bookData, 'epub');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(bookData));
      } else {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-'));
        execFile('unzip', ['-q', targetPath, '-d', tmpDir], (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Failed to unzip EPUB: ${err.message}` }));
            return;
          }
          try {
            const bookData = parseUnpackedEpubDir(tmpDir);
            bookData.sourcePath = targetPath;
            registerOrUpdateBookInLibrary(bookData, 'epub');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(bookData));
          } catch (parseErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: parseErr.message }));
          }
        });
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API 2: Standalone YouTube Video + Word-Level Caption Importer & Save to Library
  if (pathname === '/api/youtube-import' && req.method === 'GET') {
    const ytUrl = parsedUrl.searchParams.get('url') || '';
    const videoId = extractYouTubeId(ytUrl);
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid YouTube URL or Video ID.' }));
      return;
    }

    try {
      const [meta, json3] = await Promise.all([
        fetchYouTubeOEmbed(videoId),
        ensureYouTubeJson3Captions(videoId)
      ]);
      const ytWords = extractTimedWordsFromJson3(json3);
      if (ytWords.length === 0) {
        throw new Error('Caption track contained 0 words.');
      }
      const bookData = buildStandaloneBookFromYouTubeCaptions(videoId, meta, ytWords);
      registerOrUpdateBookInLibrary(bookData, 'youtube');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(bookData));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API 3: Align YouTube Audiobook Captions to Currently Loaded EPUB & Update in Library
  if (pathname === '/api/youtube-align' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const videoId = extractYouTubeId(payload.url);
      if (!videoId || !payload.book) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing YouTube URL or book payload.' }));
        return;
      }
      const [meta, json3] = await Promise.all([
        fetchYouTubeOEmbed(videoId),
        ensureYouTubeJson3Captions(videoId)
      ]);
      const ytWords = extractTimedWordsFromJson3(json3);
      const alignedBook = alignYouTubeCaptionsToBook(payload.book, videoId, meta, ytWords);
      registerOrUpdateBookInLibrary(alignedBook, 'epub+youtube');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(alignedBook));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API 4: Sync Apple Books (Mac iCloud Books Container -> FocusBooks Library for Mac & iOS)
  if (pathname === '/api/sync-apple-books' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      const result = syncAppleBooksLibrary();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API 5: Resolve Live Direct Audio Stream URL for ANY YouTube Video ID on the fly (Zero file download)
  if (pathname === '/api/youtube-stream' && req.method === 'GET') {
    const videoId = extractYouTubeId(parsedUrl.searchParams.get('v') || parsedUrl.searchParams.get('url') || '');
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid YouTube Video ID' }));
      return;
    }
    execFile(
      'yt-dlp',
      ['--js-runtimes', 'node', '-g', '-f', 'ba[ext=m4a]/ba', `https://www.youtube.com/watch?v=${videoId}`],
      { timeout: 12000 },
      (err, stdout) => {
        const streamUrl = (stdout || '').trim().split('\n')[0];
        if (err || !streamUrl) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not resolve direct stream' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ videoId, streamUrl }));
      }
    );
    return;
  }

  // Static file serving
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Cognitive Audio-Visual Reader running at http://localhost:${PORT}`);
});
