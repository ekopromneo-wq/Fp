import { useState } from 'react';

const CONFIDENCE_LABELS = {
  high: 'высокая уверенность',
  medium: 'средняя уверенность',
  low: 'низкая уверенность',
};

export default function SpeakerRow({
  speaker,
  draft,
  isSaving,
  isMerging,
  match,
  contactMatch,
  otherSpeakers,
  isSpeakerSaved,
  onDraftChange,
  onApplyCandidate,
  onSave,
  onAcceptSuggestion,
  onRejectSuggestion,
  onMerge,
}) {
  const hasMultipleCandidates = (match?.candidates?.length || 0) > 1;
  const hasMultipleContactCandidates = (contactMatch?.candidates?.length || 0) > 1;
  const hasPendingSuggestion = speaker.suggestionStatus === 'pending' && speaker.suggestedName;
  // Раскрыт по умолчанию, только если есть AI-подсказка имени (её надо решить) —
  // иначе список спикеров превращается в стену форм; правка по тапу.
  const [expanded, setExpanded] = useState(hasPendingSuggestion);

  return (
    <div className={`speaker-row${expanded ? ' is-expanded' : ''}`}>
      <div className="speaker-row-summary">
        <button
          type="button"
          className="speaker-row-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="speaker-row-toggle-main">
            <strong className="speaker-label-mini">{speaker.label}</strong>
            <span className="speaker-name-mini">
              {draft.displayName || speaker.displayName || 'имя не задано'}
              {speaker.id ? '' : ' · из стенограммы'}
            </span>
          </span>
          {hasPendingSuggestion ? <span className="speaker-suggest-badge">✨ {speaker.suggestedName}</span> : null}
          <span className="speaker-row-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>

      {expanded ? (
      <div className="speaker-row-body">
      {hasPendingSuggestion ? (
        <div className="speaker-suggestion">
          <p>
            {speaker.label} → <strong>{speaker.suggestedName}</strong>
            {speaker.suggestionConfidence ? (
              <span className={`confidence-badge confidence-${speaker.suggestionConfidence}`}>
                {CONFIDENCE_LABELS[speaker.suggestionConfidence] || speaker.suggestionConfidence}
              </span>
            ) : null}
          </p>
          {speaker.suggestionEvidence ? <p className="muted-text">«{speaker.suggestionEvidence}»</p> : null}
          <div className="speaker-suggestion-actions">
            <button className="button button-primary" type="button" onClick={onAcceptSuggestion} disabled={isSaving}>
              Принять
            </button>
            <button className="button button-secondary" type="button" onClick={onRejectSuggestion} disabled={isSaving}>
              Отклонить
            </button>
          </div>
        </div>
      ) : null}

      <label>
        Имя в протоколе
        <input
          value={draft.displayName}
          onChange={(event) => onDraftChange(speaker, 'displayName', event.target.value)}
          placeholder="Спикер"
        />
      </label>

      {hasMultipleCandidates ? (
        <label>
          Похожие сотрудники в Битрикс24
          <select
            value=""
            onChange={(event) => {
              const candidate = match.candidates.find((item) => item.id === event.target.value);

              if (candidate) {
                onApplyCandidate(speaker, candidate);
              }
            }}
          >
            <option value="">Выбери сотрудника...</option>
            {match.candidates.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {hasMultipleContactCandidates ? (
        <label>
          Похожие контакты
          <select
            value=""
            onChange={(event) => {
              const candidate = contactMatch.candidates.find((item) => item.id === event.target.value);

              if (candidate) {
                onApplyCandidate(speaker, candidate);
              }
            }}
          >
            <option value="">Выбери контакт...</option>
            {contactMatch.candidates.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label>
        Контакт
        <input
          value={draft.contactName}
          onChange={(event) => onDraftChange(speaker, 'contactName', event.target.value)}
          placeholder="Имя контакта"
        />
      </label>

      <label>
        Email
        <input
          value={draft.contactEmail}
          onChange={(event) => onDraftChange(speaker, 'contactEmail', event.target.value)}
          placeholder="name@example.com"
        />
      </label>

      <button className="button button-secondary" type="button" onClick={() => onSave(speaker)} disabled={isSaving}>
        {isSaving ? 'Сохраняем...' : isSpeakerSaved ? 'Сохранён' : 'Сохранить спикера'}
      </button>

      {otherSpeakers?.length ? (
        <label className="speaker-merge">
          Объединить с
          <select
            value=""
            onChange={(event) => {
              if (event.target.value) {
                onMerge(event.target.value);
              }
            }}
            disabled={isMerging}
          >
            <option value="">Выбери спикера...</option>
            {otherSpeakers.map((other) => (
              <option value={other.label} key={other.label}>
                {other.displayName || other.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      </div>
      ) : null}
    </div>
  );
}
