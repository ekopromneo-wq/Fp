import { formatDate } from '../lib/format.js';
import VoiceInputButton from './VoiceInputButton.jsx';

export default function TaskForm({ draft, onFieldChange, dueDate, onDictate, setStatus }) {
  return (
    <>
      <label>
        Исполнитель
        <input
          value={draft.assignee}
          onChange={(event) => onFieldChange('assignee', event.target.value)}
          placeholder="?"
        />
      </label>

      <label>
        Срок
        <input
          value={draft.dueText}
          onChange={(event) => onFieldChange('dueText', event.target.value)}
          placeholder="?"
        />
        {dueDate ? <span className="task-resolved-date">→ {formatDate(dueDate)}</span> : null}
      </label>

      <label>
        Что сделать
        <div className="task-description-with-dictate">
          <textarea
            value={draft.description}
            onChange={(event) => onFieldChange('description', event.target.value)}
            rows={3}
            placeholder="Описание задачи"
          />
          {/* US-13.2: создание задачи голосом — надиктовка в описание. */}
          {onDictate ? (
            <VoiceInputButton
              onDictate={onDictate}
              onText={(text) => onFieldChange('description', draft.description ? `${draft.description} ${text}` : text)}
              setStatus={setStatus}
              title="Надиктовать задачу"
            />
          ) : null}
        </div>
      </label>
    </>
  );
}
