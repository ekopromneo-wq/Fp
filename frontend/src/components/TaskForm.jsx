export default function TaskForm({ draft, onFieldChange }) {
  return (
    <>
      <label>
        Исполнитель
        <input
          value={draft.assignee}
          onChange={(event) => onFieldChange('assignee', event.target.value)}
          placeholder="Не указан"
        />
      </label>

      <label>
        Срок
        <input
          value={draft.dueText}
          onChange={(event) => onFieldChange('dueText', event.target.value)}
          placeholder="Не указан"
        />
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
