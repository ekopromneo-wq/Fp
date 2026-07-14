import { formatDate } from '../lib/format.js';

export default function TaskForm({ draft, onFieldChange, dueDate }) {
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
        <textarea
          value={draft.description}
          onChange={(event) => onFieldChange('description', event.target.value)}
          rows={3}
          placeholder="Описание задачи"
        />
      </label>
    </>
  );
}
