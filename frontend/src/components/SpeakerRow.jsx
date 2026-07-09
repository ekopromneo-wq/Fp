export default function SpeakerRow({ speaker, draft, isSaving, match, isSpeakerSaved, onDraftChange, onApplyCandidate, onSave }) {
  const hasMultipleCandidates = (match?.candidates?.length || 0) > 1;

  return (
    <div className="speaker-row">
      <div className="speaker-row-header">
        <strong>{speaker.label}</strong>
        <span>{speaker.id ? 'Сохранён' : 'Из стенограммы'}</span>
      </div>

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
    </div>
  );
}
