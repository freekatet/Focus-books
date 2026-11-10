/**
 * Cognitive Audio-Visual Reader — Core Linguistic & Visual Engine
 *
 * Implements:
 * 1. Mode 1: Bionic Reading fixation stem calculation (30%-50% initial stem bolding)
 * 2. Mode 2: Syntactic Chunking (3-6 word grammatical clause segmentation)
 * 3. Mode 3: Rapid Serial Visual Presentation (RSVP) with ORP (Optimal Recognition Point) anchoring
 * 4. Mode 4: Dynamic Karaoke / Spotlight token timestamp alignment
 * 5. Mode 5: Paced Teleprompter / Guided RSVP-Chunk Hybrid timing
 * 6. Exact Word-Level Timestamp Integration (YouTube json3 / Forced Alignment)
 */

(function (global) {
  'use strict';

  const PREPOSITIONS_AND_SUBORDINATORS = new Set([
    'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'upon',
    'through', 'throughout', 'across', 'behind', 'between', 'beyond', 'under',
    'over', 'above', 'below', 'after', 'before', 'without', 'within', 'during',
    'toward', 'towards', 'against', 'among', 'around', 'amid', 'beside', 'besides',
    'despite', 'except', 'inside', 'outside', 'near', 'off', 'past', 'since',
    'until', 'till', 'up', 'down', 'about', 'along', 'because', 'although',
    'though', 'while', 'whilst', 'where', 'wherever', 'when', 'whenever',
    'whether', 'unless', 'that', 'which', 'who', 'whom', 'whose', 'as', 'if'
  ]);

  const COORDINATING_CONJUNCTIONS = new Set([
    'and', 'but', 'or', 'nor', 'yet', 'so'
  ]);

  const DETERMINERS_AND_MODIFIERS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those',
    'my', 'your', 'his', 'her', 'its', 'our', 'their',
    'some', 'any', 'no', 'every', 'each', 'either', 'neither',
    'very', 'quite', 'rather', 'too', 'more', 'most', 'less', 'least', 'not'
  ]);

  const AUXILIARY_VERBS = new Set([
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must'
  ]);

  const COMMON_ABBREVIATIONS = new Set([
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'mt.',
    'vs.', 'etc.', 'e.g.', 'i.e.', 'fig.', 'inc.', 'ltd.', 'co.', 'corp.',
    'u.s.', 'a.m.', 'p.m.', 'p.', 'pp.', 'no.', 'vol.'
  ]);

  function splitTokenAffixes(rawWord) {
    const match = rawWord.match(/^([^a-zA-Z0-9\u00C0-\u024F]*)([a-zA-Z0-9\u00C0-\u024F][\w\u00C0-\u024F'’\-]*[a-zA-Z0-9\u00C0-\u024F]|[a-zA-Z0-9\u00C0-\u024F])([^a-zA-Z0-9\u00C0-\u024F]*)$/);
    if (!match) {
      return { prefix: '', core: rawWord, suffix: '' };
    }
    return {
      prefix: match[1] || '',
      core: match[2] || '',
      suffix: match[3] || ''
    };
  }

  /**
   * Mode 1: Bionic Reading Fixation Stem Algorithm (per specification):
   * - 1-3 char words: Bold the first 1 character
   * - 4-6 char words: Bold the first 2 characters
   * - 7-9 char words: Bold the first 3 characters
   * - 10+ char words: Bold the first 4-5 characters
   */
  function computeBionicParts(rawWord, intensityDelta = 0) {
    const { prefix, core, suffix } = splitTokenAffixes(rawWord);
    const len = core.length;
    if (len === 0) {
      return { prefix: '', fixation: rawWord, remainder: '', suffix: '' };
    }

    let stemLen;
    if (len <= 3) {
      stemLen = 1;
    } else if (len <= 6) {
      stemLen = 2;
    } else if (len <= 9) {
      stemLen = 3;
    } else if (len <= 12) {
      stemLen = 4;
    } else {
      stemLen = 5;
    }

    if (intensityDelta !== 0 && len > 2) {
      stemLen = Math.max(1, Math.min(len - 1, stemLen + intensityDelta));
    }

    return {
      prefix,
      fixation: core.slice(0, stemLen),
      remainder: core.slice(stemLen),
      suffix
    };
  }

  /**
   * Mode 3: Optimal Recognition Point (ORP) calculation for RSVP.
   * Eye fixations naturally land slightly left of center (~30%-35% into the word).
   */
  function computeORPParts(rawWord) {
    const { prefix, core, suffix } = splitTokenAffixes(rawWord);
    const len = core.length;
    if (len === 0) {
      const mid = Math.floor(rawWord.length / 2);
      return {
        left: rawWord.slice(0, mid),
        orp: rawWord.charAt(mid) || '',
        right: rawWord.slice(mid + 1)
      };
    }

    let orpIdx;
    if (len === 1) {
      orpIdx = 0;
    } else if (len <= 5) {
      orpIdx = 1;
    } else if (len <= 9) {
      orpIdx = 2;
    } else if (len <= 13) {
      orpIdx = 3;
    } else {
      orpIdx = 4;
    }

    return {
      left: prefix + core.slice(0, orpIdx),
      orp: core.charAt(orpIdx),
      right: core.slice(orpIdx + 1) + suffix
    };
  }

  function estimateTokenDurationMs(rawWord) {
    const { core, suffix } = splitTokenAffixes(rawWord);
    const charLen = Math.max(1, core.length);
    let duration = 175 + charLen * 24;

    if (/[.!?]+/.test(suffix)) {
      duration += 260;
    } else if (/[,;:—–]+/.test(suffix) || rawWord.endsWith('--') || rawWord.includes('–')) {
      duration += 150;
    }

    return Math.round(duration);
  }

  function splitIntoSentences(paragraphText) {
    const tokens = paragraphText.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const sentences = [];
    let current = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      current.push(tok);

      const lower = tok.toLowerCase().replace(/^["'“‘(]+/, '');
      const isAbbrev =
        COMMON_ABBREVIATIONS.has(lower) ||
        /^[a-z]\.$/i.test(lower) ||
        /^[A-Z]\.[A-Z]\.$/.test(tok);

      const endsWithTerminal = /[.!?…]+["'”’)]*$/.test(tok);
      const nextTok = tokens[i + 1];

      if (endsWithTerminal && !isAbbrev) {
        sentences.push(current.join(' '));
        current = [];
      } else if (current.length >= 42 && /[,;—–]["'”’)]*$/.test(tok) && nextTok) {
        sentences.push(current.join(' '));
        current = [];
      }
    }

    if (current.length > 0) {
      sentences.push(current.join(' '));
    }

    return sentences;
  }

  function segmentIntoSyntacticChunks(wordTokens) {
    if (wordTokens.length <= 5) {
      return [wordTokens];
    }

    const chunks = [];
    let currentChunk = [];

    for (let i = 0; i < wordTokens.length; i++) {
      const token = wordTokens[i];
      currentChunk.push(token);

      const remaining = wordTokens.length - 1 - i;
      if (remaining === 0) {
        if (currentChunk.length === 1 && chunks.length > 0 && chunks[chunks.length - 1].length <= 5) {
          chunks[chunks.length - 1].push(...currentChunk);
        } else {
          chunks.push(currentChunk);
        }
        currentChunk = [];
        break;
      }

      const len = currentChunk.length;
      const rawText = token.raw;
      const cleanLower = token.core.toLowerCase();

      const nextToken = wordTokens[i + 1];
      const nextLower = nextToken ? nextToken.core.toLowerCase() : '';

      if (remaining === 1 && len < 6) {
        continue;
      }

      const hasStrongPunct = /[,;:—–.!?)”"]$/.test(rawText) || rawText.endsWith('–') || rawText.endsWith('—');

      const bindsForward =
        DETERMINERS_AND_MODIFIERS.has(cleanLower) ||
        AUXILIARY_VERBS.has(cleanLower) ||
        cleanLower === 'to';

      const nextStartsPhrase =
        PREPOSITIONS_AND_SUBORDINATORS.has(nextLower) ||
        COORDINATING_CONJUNCTIONS.has(nextLower);

      let shouldBreak = false;

      if (hasStrongPunct && len >= 2) {
        shouldBreak = true;
      } else if (len >= 6) {
        if (!bindsForward || len >= 7) {
          shouldBreak = true;
        }
      } else if (len >= 3 && !bindsForward) {
        if (nextStartsPhrase && remaining >= 2) {
          shouldBreak = true;
        } else if (len >= 5 && remaining >= 3) {
          shouldBreak = true;
        }
      }

      if (shouldBreak) {
        chunks.push(currentChunk);
        currentChunk = [];
      }
    }

    if (currentChunk.length > 0) {
      if (currentChunk.length === 1 && chunks.length > 0 && chunks[chunks.length - 1].length <= 5) {
        chunks[chunks.length - 1].push(...currentChunk);
      } else {
        chunks.push(currentChunk);
      }
    }

    return chunks;
  }

  /**
   * Parses a chapter object into structured tokens, syntactic chunks, sentences, and paragraphs.
   * Automatically uses `chapter.wordTimestamps` (ms) if present from YouTube / Forced Alignment!
   */
  function parseChapterCognitive(chapter) {
    const tokens = [];
    const chunks = [];
    const sentences = [];
    const paragraphs = [];

    const externalTimestamps = Array.isArray(chapter.wordTimestamps) ? chapter.wordTimestamps : null;
    const hasExactTimestamps = Boolean(externalTimestamps && externalTimestamps.length > 0);

    let globalTokenIndex = 0;
    let globalChunkIndex = 0;
    let globalSentenceIndex = 0;
    let cumulativeTimeMs = chapter.videoStartMs || 0;

    const rawParagraphs = chapter.paragraphs || [];

    for (let pIdx = 0; pIdx < rawParagraphs.length; pIdx++) {
      const pText = rawParagraphs[pIdx];
      const rawSentences = splitIntoSentences(pText);
      const paraSentenceIndices = [];
      const paraChunkIndices = [];
      const paraTokenIndices = [];

      for (let sIdx = 0; sIdx < rawSentences.length; sIdx++) {
        const sText = rawSentences[sIdx];
        const rawWords = sText.split(/\s+/).filter(Boolean);
        if (rawWords.length === 0) continue;

        const sentenceIndex = globalSentenceIndex++;
        const sentenceTokens = [];
        let charCursor = 0;

        for (let wIdx = 0; wIdx < rawWords.length; wIdx++) {
          const raw = rawWords[wIdx];
          const { prefix, core, suffix } = splitTokenAffixes(raw);
          const bionic = computeBionicParts(raw, 0);
          const orp = computeORPParts(raw);
          const estimatedDur = estimateTokenDurationMs(raw);

          const tIdx = globalTokenIndex++;
          let startMs;
          let endMs;
          let durationMs;

          if (hasExactTimestamps && typeof externalTimestamps[tIdx] === 'number') {
            startMs = externalTimestamps[tIdx];
            const nextExt = externalTimestamps[tIdx + 1];
            if (typeof nextExt === 'number' && nextExt > startMs) {
              // Cap single word visual hold to a reasonable max during long musical/chapter pauses
              durationMs = Math.min(1800, Math.max(80, nextExt - startMs));
              endMs = startMs + durationMs;
            } else {
              durationMs = estimatedDur;
              endMs = startMs + durationMs;
            }
            cumulativeTimeMs = Math.max(cumulativeTimeMs, endMs);
          } else {
            startMs = cumulativeTimeMs;
            durationMs = estimatedDur;
            endMs = startMs + durationMs;
            cumulativeTimeMs = endMs;
          }

          const tokenObj = {
            index: tIdx,
            raw,
            prefix,
            core,
            suffix,
            bionic,
            orp,
            paragraphIndex: pIdx,
            sentenceIndex,
            wordIndexInSentence: wIdx,
            chunkIndex: -1,
            charStartInSentence: charCursor,
            charEndInSentence: charCursor + raw.length,
            durationMs,
            startMs,
            endMs
          };

          charCursor += raw.length + 1;
          tokens.push(tokenObj);
          sentenceTokens.push(tokenObj);
          paraTokenIndices.push(tokenObj.index);
        }

        const syntacticGroups = segmentIntoSyntacticChunks(sentenceTokens);
        const sentenceChunkIndices = [];

        for (const group of syntacticGroups) {
          const chunkIdx = globalChunkIndex++;
          const chunkStartMs = group[0].startMs;
          const chunkEndMs = group[group.length - 1].endMs;

          for (const t of group) {
            t.chunkIndex = chunkIdx;
          }

          const chunkObj = {
            index: chunkIdx,
            paragraphIndex: pIdx,
            sentenceIndex,
            tokenIndices: group.map((t) => t.index),
            firstTokenIndex: group[0].index,
            lastTokenIndex: group[group.length - 1].index,
            text: group.map((t) => t.raw).join(' '),
            startMs: chunkStartMs,
            endMs: chunkEndMs,
            durationMs: Math.max(100, chunkEndMs - chunkStartMs)
          };

          chunks.push(chunkObj);
          sentenceChunkIndices.push(chunkIdx);
          paraChunkIndices.push(chunkIdx);
        }

        if (!hasExactTimestamps) {
          cumulativeTimeMs += 140;
        }

        const sentenceStartMs = sentenceTokens[0].startMs;
        const sentenceEndMs = sentenceTokens[sentenceTokens.length - 1].endMs;

        sentences.push({
          index: sentenceIndex,
          paragraphIndex: pIdx,
          text: rawWords.join(' '),
          tokenIndices: sentenceTokens.map((t) => t.index),
          firstTokenIndex: sentenceTokens[0].index,
          lastTokenIndex: sentenceTokens[sentenceTokens.length - 1].index,
          chunkIndices: sentenceChunkIndices,
          startMs: sentenceStartMs,
          endMs: sentenceEndMs,
          durationMs: Math.max(150, sentenceEndMs - sentenceStartMs)
        });

        paraSentenceIndices.push(sentenceIndex);
      }

      if (paraTokenIndices.length > 0) {
        paragraphs.push({
          index: pIdx,
          text: pText,
          sentenceIndices: paraSentenceIndices,
          chunkIndices: paraChunkIndices,
          tokenIndices: paraTokenIndices,
          firstTokenIndex: paraTokenIndices[0],
          lastTokenIndex: paraTokenIndices[paraTokenIndices.length - 1]
        });
      }
    }

    const firstStartMs = tokens.length > 0 ? tokens[0].startMs : 0;
    const lastEndMs = tokens.length > 0 ? tokens[tokens.length - 1].endMs : 0;

    return {
      chapterId: chapter.id,
      title: chapter.title,
      hasExactTimestamps,
      videoStartMs: firstStartMs,
      videoEndMs: lastEndMs,
      tokens,
      chunks,
      sentences,
      paragraphs,
      totalDurationMs: Math.max(1000, lastEndMs - firstStartMs)
    };
  }

  function findTokenBySentenceCharIndex(sentence, tokens, charIndex) {
    const indices = sentence.tokenIndices;
    for (let i = 0; i < indices.length; i++) {
      const tok = tokens[indices[i]];
      if (charIndex >= tok.charStartInSentence && charIndex <= tok.charEndInSentence + 1) {
        return tok.index;
      }
      if (tok.charStartInSentence > charIndex) {
        return i > 0 ? indices[i - 1] : tok.index;
      }
    }
    return indices[indices.length - 1];
  }

  /**
   * Binary search to find the exact active token at `targetMs` (in O(log N) for 60Hz YouTube sync).
   */
  function findTokenByTimestampMs(tokens, targetMs) {
    if (!tokens || tokens.length === 0) return 0;
    if (targetMs <= tokens[0].startMs) return 0;
    if (targetMs >= tokens[tokens.length - 1].startMs) return tokens.length - 1;

    let low = 0;
    let high = tokens.length - 1;
    let best = 0;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const tok = tokens[mid];
      if (tok.startMs <= targetMs) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  global.CognitiveEngine = {
    splitTokenAffixes,
    computeBionicParts,
    computeORPParts,
    estimateTokenDurationMs,
    splitIntoSentences,
    segmentIntoSyntacticChunks,
    parseChapterCognitive,
    findTokenBySentenceCharIndex,
    findTokenByTimestampMs
  };
})(window);
