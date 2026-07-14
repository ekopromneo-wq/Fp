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

  return (
    <div className="speaker-row">
      <div className="speaker-row-header">
        <strong>{speaker.label}</strong>
        <span>{speaker.id ? 'Сохранён' : 'Из стенограммы'}</span>
      </div>

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
  );
}
