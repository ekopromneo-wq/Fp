import { useRef, useState } from 'react';
import { formatDate } from '../lib/format.js';

const PROTOCOL_SECTION_LABELS = {
  participants: 'Участники',
  agenda: 'Повестка',
  discussions: 'Обсуждения',
  decisions: 'Решения',
  risks: 'Риски',
  questions: 'Открытые вопросы',
  nextSteps: 'Следующие шаги',
};

function sectionToLines(items, sectionKey) {
  if (!Array.isArray(items)) {
    return '';
  }

  if (sectionKey === 'decisions') {
    return items.map((item) => item?.text || '').join('\n');
  }

  return items.join('\n');
}

function linesToSection(text, sectionKey) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // Editing a decision is treated as the user confirming it - disputed
  // (an AI-only "not sure this was actually agreed" signal) resets to false
  // rather than trying to preserve it per-line across a free-text edit.
  return sectionKey === 'decisions' ? lines.map((text) => ({ text, disputed: false })) : lines;
}

function DictateButton({ isActive, isBusy, onToggle, label }) {
  return (
    <button
      type="button"
      className={`button icon-button button-secondary protocol-dictate-button${isActive ? ' is-recording' : ''}`}
      onClick={onToggle}
      disabled={isBusy && !isActive}
      title={isActive ? 'Остановить надиктовку' : `Надиктовать (${label})`}
      aria-label={isActive ? 'Остановить надиктовку' : `Надиктовать: ${label}`}
    >
      {isActive ? '⏹' : '🎙'}
    </button>
  );
}

export default function ProtocolView({ recording, onUpdateProtocol, onGenerateProtocol, onDictate, setStatus }) {
  const summary = recording.summary;
  const template = recording.protocolTemplate || { label: 'Совещание', sections: ['participants', 'agenda', 'discussions', 'decisions', 'risks', 'questions', 'nextSteps'] };

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLocking, setIsLocking] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [dictatingField, setDictatingField] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  function startEditing() {
    setDraft({
      summary: summary?.summary || '',
      executiveSummary: summary?.executiveSummary || '',
      protocol: Object.fromEntries(template.sections.map((key) => [key, sectionToLines(summary?.protocol?.[key], key)])),
    });
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setDraft(null);
  }

  async function saveEdits() {
    if (!draft) {
      return;
    }

    setIsSaving(true);

    try {
      const protocol = { ...(summary?.protocol || {}) };
      for (const key of template.sections) {
        protocol[key] = linesToSection(draft.protocol[key], key);
      }

      await onUpdateProtocol({ summary: draft.summary, executiveSummary: draft.executiveSummary, protocol });
      setStatus?.('Протокол сохранён');
      cancelEditing();
    } catch (error) {
      setStatus?.(error.message || 'Не удалось сохранить протокол');
    } finally {
      setIsSaving(false);
    }
  }

  async function toggleLock() {
    setIsLocking(true);

    try {
      await onUpdateProtocol({ locked: !summary.isLocked });
      setStatus?.(summary.isLocked ? 'Протокол разблокирован' : 'Протокол заблокирован от изменений');
    } catch (error) {
      setStatus?.(error.message || 'Не удалось изменить блокировку');
    } finally {
      setIsLocking(false);
    }
  }

  async function regenerateWithInstruction() {
    if (!instruction.trim()) {
      setStatus?.('Опиши, что изменить в протоколе');
      return;
    }

    setIsRegenerating(true);

    try {
      await onGenerateProtocol({ instruction: instruction.trim() });
      setInstruction('');
      setStatus?.('Протокол перегенерирован');
    } catch (error) {
      setStatus?.(error.message || 'Не удалось перегенерировать протокол');
    } finally {
      setIsRegenerating(false);
    }
  }

  async function toggleDictate(fieldKey, appendTo) {
    if (dictatingField === fieldKey) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (dictatingField) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setStatus?.('Надиктовка не поддерживается в этом браузере');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : {};
      const recorder = new MediaRecorder(stream, options);
      chunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setDictatingField(null);

        if (!chunksRef.current.length) {
          return;
        }

        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        setStatus?.('Распознаём надиктовку...');

        try {
          const text = await onDictate(blob);

          if (text) {
            appendTo(text);
          }

          setStatus?.(text ? 'Надиктовка добавлена' : 'Не удалось распознать речь');
        } catch (error) {
          setStatus?.(error.message || 'Не удалось распознать надиктовку');
        }
      };

      recorder.start();
      setDictatingField(fieldKey);
      setStatus?.('Идёт надиктовка...');
    } catch (error) {
      setStatus?.(error.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён' : error.message || 'Не удалось начать надиктовку');
    }
  }

  function appendToDraftField(field) {
    return (text) => {
      setDraft((current) => ({ ...current, [field]: current[field] ? `${current[field]}\n${text}` : text }));
    };
  }

  function appendToDraftSection(sectionKey) {
    return (text) => {
      setDraft((current) => ({
        ...current,
        protocol: {
          ...current.protocol,
          [sectionKey]: current.protocol[sectionKey] ? `${current.protocol[sectionKey]}\n${text}` : text,
        },
      }));
    };
  }

  if (!summary) {
    return <p className="muted-text">Протокола пока нет. Сделай его после появления стенограммы.</p>;
  }

  return (
    <div className="protocol-view">
      <div className="protocol-print-header">
        <h2>{recording.title}</h2>
        <p>{formatDate(recording.createdAt)} · {template.label}</p>
      </div>

      <div className="protocol-toolbar">
        {summary.isEdited ? <span className="protocol-edited-badge">Есть ручные правки</span> : null}
        {summary.isLocked ? <span className="protocol-locked-badge">Заблокирован</span> : null}

        {!isEditing ? (
          <button className="button button-secondary" type="button" onClick={startEditing} disabled={summary.isLocked}>
            Редактировать
          </button>
        ) : (
          <>
            <button className="button button-primary" type="button" onClick={saveEdits} disabled={isSaving}>
              {isSaving ? 'Сохраняем...' : 'Сохранить'}
            </button>
            <button className="button button-secondary" type="button" onClick={cancelEditing} disabled={isSaving}>
              Отмена
            </button>
          </>
        )}

        <button className="button button-secondary" type="button" onClick={toggleLock} disabled={isLocking}>
          {summary.isLocked ? 'Разблокировать' : 'Заблокировать'}
        </button>

        <button className="button button-secondary" type="button" onClick={() => window.print()}>
          Печать / PDF
        </button>
      </div>

      {summary.executiveSummary || isEditing ? (
        <section className="protocol-section executive-summary">
          <h4>Executive summary</h4>
          {isEditing ? (
            <div className="protocol-field-with-dictate">
              <textarea
                value={draft.executiveSummary}
                onChange={(event) => setDraft((current) => ({ ...current, executiveSummary: event.target.value }))}
                rows={3}
              />
              <DictateButton
                isActive={dictatingField === 'executiveSummary'}
                isBusy={Boolean(dictatingField)}
                onToggle={() => toggleDictate('executiveSummary', appendToDraftField('executiveSummary'))}
                label="executive summary"
              />
            </div>
          ) : (
            <p>{summary.executiveSummary}</p>
          )}
        </section>
      ) : null}

      <section className="protocol-section">
        <h4>Резюме (полная версия)</h4>
        {isEditing ? (
          <div className="protocol-field-with-dictate">
            <textarea
              value={draft.summary}
              onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
              rows={6}
            />
            <DictateButton
              isActive={dictatingField === 'summary'}
              isBusy={Boolean(dictatingField)}
              onToggle={() => toggleDictate('summary', appendToDraftField('summary'))}
              label="резюме"
            />
          </div>
        ) : (
          <p>{summary.summary}</p>
        )}

        {!isEditing && summary.actionItems?.length ? (
          <>
            <h4>Action items</h4>
            <ul>
              {summary.actionItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : null}

        {!isEditing && summary.topics?.length ? (
          <div className="topic-list">
            {summary.topics.map((topic) => (
              <span key={topic}>{topic}</span>
            ))}
          </div>
        ) : null}
      </section>

      <div className="protocol-grid">
        {template.sections.map((key) => (
          <section className="protocol-section" key={key}>
            <h4>{PROTOCOL_SECTION_LABELS[key]}</h4>
            {isEditing ? (
              <div className="protocol-field-with-dictate">
                <textarea
                  value={draft.protocol[key]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, protocol: { ...current.protocol, [key]: event.target.value } }))
                  }
                  rows={4}
                  placeholder="По одному пункту на строку"
                />
                <DictateButton
                  isActive={dictatingField === key}
                  isBusy={Boolean(dictatingField)}
                  onToggle={() => toggleDictate(key, appendToDraftSection(key))}
                  label={PROTOCOL_SECTION_LABELS[key]}
                />
              </div>
            ) : summary.protocol?.[key]?.length ? (
              <ul>
                {summary.protocol[key].map((item, index) =>
                  key === 'decisions' ? (
                    <li key={`${item.text}-${index}`} className={item.disputed ? 'protocol-decision-disputed' : ''}>
                      {item.text}
                    </li>
                  ) : (
                    <li key={`${item}-${index}`}>{item}</li>
                  ),
                )}
              </ul>
            ) : (
              <p className="muted-text">Не выделено.</p>
            )}
          </section>
        ))}
      </div>

      <section className="protocol-section protocol-regenerate">
        <h4>Перегенерировать с инструкцией</h4>
        <div className="protocol-field-with-dictate">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={2}
            placeholder="Например: сделай упор на риски и открытые вопросы"
            disabled={isRegenerating}
          />
          <DictateButton
            isActive={dictatingField === 'instruction'}
            isBusy={Boolean(dictatingField)}
            onToggle={() => toggleDictate('instruction', (text) => setInstruction((current) => (current ? `${current}\n${text}` : text)))}
            label="инструкция"
          />
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={regenerateWithInstruction}
          disabled={isRegenerating || summary.isLocked}
        >
          {isRegenerating ? 'Перегенерируем...' : 'Перегенерировать'}
        </button>
      </section>
    </div>
  );
}
