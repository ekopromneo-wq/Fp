import { useEffect, useMemo, useRef, useState } from 'react';
import { cleanTranscriptText } from '../lib/transcriptClean.js';

const SEEK_SECONDS = 10;
const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

function msToSec(ms) {
  return typeof ms === 'number' ? ms / 1000 : null;
}

function getSegments(transcript) {
  if (Array.isArray(transcript?.segments) && transcript.segments.length) {
    return transcript.segments;
  }

  // Older/edge-case rows without a segments array - fall back to one
  // untimed block so the rest of the view (search/export/edit) still works.
  return transcript?.text ? [{ speaker: null, text: transcript.text, startMs: null, endMs: null }] : [];
}

function speakerDisplayName(label, speakers) {
  if (!label) {
    return null;
  }

  return speakers?.find((speaker) => speaker.label === label)?.displayName || label;
}

function highlightMatches(text, query) {
  if (!query) {
    return text;
  }

  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));

  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={index}>{part}</mark>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function buildPlainTranscript(segments, speakers, mode) {
  return segments
    .map((segment) => {
      const text = mode === 'cleaned' ? cleanTranscriptText(segment.text) : segment.text;
      const speaker = speakerDisplayName(segment.speaker, speakers);
      return speaker ? `${speaker}:\n${text}` : text;
    })
    .join('\n\n');
}

function buildMarkdownTranscript(segments, speakers, mode) {
  return segments
    .map((segment) => {
      const text = mode === 'cleaned' ? cleanTranscriptText(segment.text) : segment.text;
      const speaker = speakerDisplayName(segment.speaker, speakers);
      return speaker ? `### ${speaker}\n\n${text}` : text;
    })
    .join('\n\n');
}

// Dynamically imported - docx (with its embedded zip packer) roughly
// doubles the app's JS bundle, and DOCX export is a rarely-used path, so it
// shouldn't cost every page load just to be available.
async function buildDocxBlob(segments, speakers, mode, title) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const children = [new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 })];

  for (const segment of segments) {
    const text = mode === 'cleaned' ? cleanTranscriptText(segment.text) : segment.text;
    const speaker = speakerDisplayName(segment.speaker, speakers);

    if (speaker) {
      children.push(new Paragraph({ children: [new TextRun({ text: speaker, bold: true })] }));
    }

    children.push(new Paragraph({ text }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function copyPlainText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function transcriptFilename(title, extension) {
  const baseName = (title || 'recording')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${baseName || 'recording'}-transcript.${extension}`;
}

export default function TranscriptView({ recording, audioUrl, onUpdateTranscript, setStatus }) {
  const transcript = recording?.transcript;
  const [mode, setMode] = useState('verbatim');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [draftSegments, setDraftSegments] = useState(null);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const audioRef = useRef(null);
  const segmentRefs = useRef(new Map());

  const baseSegments = useMemo(() => getSegments(transcript), [transcript]);
  const segments = isEditing && draftSegments ? draftSegments : baseSegments;
  const hasTimestamps = baseSegments.some((segment) => typeof segment.startMs === 'number');
  // Every label reassignment (draftSegments) needs to appear in the dropdown
  // immediately, not just the labels present in the original transcript -
  // otherwise picking "+ новый спикер" once wouldn't let you pick that same
  // new label for a second segment.
  const availableLabels = useMemo(
    () => [...new Set((isEditing && draftSegments ? draftSegments : baseSegments).map((segment) => segment.speaker).filter(Boolean))],
    [isEditing, draftSegments, baseSegments],
  );

  useEffect(() => {
    setMode('verbatim');
    setIsEditing(false);
    setDraftSegments(null);
    setSearchQuery('');
  }, [recording?.id]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const displayText = (segmentText) => (mode === 'cleaned' && !isEditing ? cleanTranscriptText(segmentText) : segmentText);

  const matches = useMemo(() => {
    if (!searchQuery.trim()) {
      return [];
    }

    const query = searchQuery.trim().toLowerCase();
    const found = [];

    segments.forEach((segment, index) => {
      if (displayText(segment.text || '').toLowerCase().includes(query)) {
        found.push(index);
      }
    });

    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, searchQuery, mode]);

  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (matches.length === 0) {
      return;
    }

    const targetIndex = matches[currentMatchIndex % matches.length];
    segmentRefs.current.get(targetIndex)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentMatchIndex, matches]);

  function handleSeek(deltaSeconds) {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime + deltaSeconds);
    }
  }

  function handleTimeUpdate() {
    if (!hasTimestamps || !audioRef.current) {
      return;
    }

    const currentSec = audioRef.current.currentTime;
    const index = baseSegments.findIndex((segment) => {
      const start = msToSec(segment.startMs);
      const end = msToSec(segment.endMs);
      return start !== null && end !== null && currentSec >= start && currentSec < end;
    });

    if (index !== currentSegmentIndex) {
      setCurrentSegmentIndex(index);

      if (index >= 0) {
        segmentRefs.current.get(index)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function startEditing() {
    setMode('verbatim');
    setDraftSegments(baseSegments.map((segment) => ({ ...segment })));
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setDraftSegments(null);
    setFindText('');
    setReplaceText('');
  }

  function applyBulkReplace() {
    if (!findText || !draftSegments) {
      return;
    }

    setDraftSegments((current) => current.map((segment) => ({ ...segment, text: segment.text.split(findText).join(replaceText) })));
  }

  async function saveEdits() {
    if (!draftSegments) {
      return;
    }

    setIsSaving(true);

    try {
      const text = draftSegments.map((segment) => segment.text).join('\n\n');
      await onUpdateTranscript({ text, segments: draftSegments });
      setStatus?.('Стенограмма сохранена');
      cancelEditing();
    } catch (error) {
      setStatus?.(error.message || 'Не удалось сохранить стенограмму');
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleLock() {
    try {
      await onUpdateTranscript({ locked: !transcript.isLocked });
      setStatus?.(transcript.isLocked ? 'Стенограмма разблокирована' : 'Стенограмма заблокирована от редактирования');
    } catch (error) {
      setStatus?.(error.message || 'Не удалось изменить блокировку');
    }
  }

  async function handleCopy() {
    await copyPlainText(buildPlainTranscript(baseSegments, recording.speakers, mode));
    setStatus?.('Стенограмма скопирована');
  }

  async function handleDownload(format) {
    if (format === 'txt') {
      downloadBlob(
        transcriptFilename(recording.title, 'txt'),
        new Blob([buildPlainTranscript(baseSegments, recording.speakers, mode)], { type: 'text/plain;charset=utf-8' }),
      );
    } else if (format === 'md') {
      downloadBlob(
        transcriptFilename(recording.title, 'md'),
        new Blob([buildMarkdownTranscript(baseSegments, recording.speakers, mode)], { type: 'text/markdown;charset=utf-8' }),
      );
    } else if (format === 'docx') {
      const blob = await buildDocxBlob(baseSegments, recording.speakers, mode, recording.title);
      downloadBlob(transcriptFilename(recording.title, 'docx'), blob);
    }
  }

  if (!transcript) {
    return <p className="muted-text">Стенограммы пока нет. Запусти обработку записи.</p>;
  }

  return (
    <div className="transcript-view">
      {audioUrl ? (
        <div className="transcript-audio-controls">
          <audio ref={audioRef} controls preload="metadata" src={audioUrl} onTimeUpdate={handleTimeUpdate} />
          <div className="transcript-audio-buttons">
            <button type="button" className="button button-secondary" onClick={() => handleSeek(-SEEK_SECONDS)}>
              ⏪ {SEEK_SECONDS}с
            </button>
            <button type="button" className="button button-secondary" onClick={() => handleSeek(SEEK_SECONDS)}>
              {SEEK_SECONDS}с ⏩
            </button>
            {PLAYBACK_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                className={`summary-length-option ${playbackRate === rate ? 'active' : ''}`}
                onClick={() => setPlaybackRate(rate)}
              >
                {rate}×
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="transcript-toolbar">
        <div className="summary-length-toggle" role="group" aria-label="Режим стенограммы">
          <button
            type="button"
            className={`summary-length-option ${mode === 'verbatim' ? 'active' : ''}`}
            onClick={() => setMode('verbatim')}
            disabled={isEditing}
          >
            Дословно
          </button>
          <button
            type="button"
            className={`summary-length-option ${mode === 'cleaned' ? 'active' : ''}`}
            onClick={() => setMode('cleaned')}
            disabled={isEditing}
          >
            Без слов-паразитов
          </button>
        </div>

        <div className="transcript-search">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Поиск по стенограмме"
          />
          {matches.length > 0 ? (
            <>
              <span className="muted-text">
                {(currentMatchIndex % matches.length) + 1} / {matches.length}
              </span>
              <button type="button" className="button icon-button button-secondary" onClick={() => setCurrentMatchIndex((i) => i - 1)}>
                ↑
              </button>
              <button type="button" className="button icon-button button-secondary" onClick={() => setCurrentMatchIndex((i) => i + 1)}>
                ↓
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="transcript-actions">
        <button type="button" className="button button-secondary" onClick={handleCopy}>
          Скопировать стенограмму
        </button>
        <button type="button" className="button button-secondary" onClick={() => handleDownload('txt')}>
          .txt
        </button>
        <button type="button" className="button button-secondary" onClick={() => handleDownload('md')}>
          .md
        </button>
        <button type="button" className="button button-secondary" onClick={() => handleDownload('docx')}>
          .docx
        </button>
        {!isEditing ? (
          <button type="button" className="button button-secondary" onClick={startEditing} disabled={transcript.isLocked}>
            Редактировать
          </button>
        ) : null}
        <button type="button" className="button button-secondary" onClick={toggleLock}>
          {transcript.isLocked ? 'Разблокировать' : 'Заблокировать от редактирования'}
        </button>
      </div>

      {transcript.isLocked ? <p className="muted-text">Стенограмма заблокирована от редактирования.</p> : null}

      {isEditing ? (
        <div className="transcript-bulk-replace">
          <input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="Найти" />
          <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="Заменить на" />
          <button type="button" className="button button-secondary" onClick={applyBulkReplace} disabled={!findText}>
            Заменить везде
          </button>
        </div>
      ) : null}

      <div className="transcript-segments">
        {segments.map((segment, index) => {
          const speaker = speakerDisplayName(segment.speaker, recording.speakers);
          const isCurrent = !isEditing && index === currentSegmentIndex;

          return (
            <div
              key={index}
              ref={(el) => {
                if (el) segmentRefs.current.set(index, el);
                else segmentRefs.current.delete(index);
              }}
              className={`transcript-segment ${isCurrent ? 'is-current-segment' : ''}`}
            >
              {isEditing ? (
                <select
                  className="transcript-segment-speaker-select"
                  value={segment.speaker || ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    const nextLabel = value === '__new__' ? window.prompt('Имя нового спикера')?.trim() : value;

                    if (!nextLabel) {
                      return;
                    }

                    setDraftSegments((current) => current.map((s, i) => (i === index ? { ...s, speaker: nextLabel } : s)));
                  }}
                >
                  {availableLabels.map((label) => (
                    <option key={label} value={label}>
                      {speakerDisplayName(label, recording.speakers) || label}
                    </option>
                  ))}
                  <option value="__new__">+ новый спикер...</option>
                </select>
              ) : speaker ? (
                <strong className="transcript-segment-speaker">{speaker}</strong>
              ) : null}
              {isEditing ? (
                <textarea
                  className="transcript-segment-editor"
                  value={segment.text}
                  onChange={(event) => {
                    const nextText = event.target.value;
                    setDraftSegments((current) => current.map((s, i) => (i === index ? { ...s, text: nextText } : s)));
                  }}
                />
              ) : (
                <p className="transcript-segment-text">{highlightMatches(displayText(segment.text), searchQuery)}</p>
              )}
            </div>
          );
        })}
      </div>

      {isEditing ? (
        <div className="transcript-edit-actions">
          <button type="button" className="button button-primary" onClick={saveEdits} disabled={isSaving}>
            {isSaving ? 'Сохраняем...' : 'Сохранить изменения'}
          </button>
          <button type="button" className="button button-secondary" onClick={cancelEditing} disabled={isSaving}>
            Отменить
          </button>
        </div>
      ) : null}
    </div>
  );
}
