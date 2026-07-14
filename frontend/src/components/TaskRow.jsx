import { useState } from 'react';
import { formatDate } from '../lib/format.js';
import TaskForm from './TaskForm.jsx';

const STATUS_LABELS = {
  extracted: 'Извлечена',
  confirmed: 'Подтверждена',
  sent: 'Отправлена',
  done: 'Готова',
  dismissed: 'Скрыта',
};

export default function TaskRow({
  task,
  draft,
  isSaving,
  isDeleting,
  isSendingBitrix,
  isSendingEmail,
  isSelected,
  assigneeMatch,
  onFieldChange,
  onSave,
  onConfirm,
  onDismiss,
  onDelete,
  onSendToBitrix,
  onSendEmail,
  onApplyAssigneeCandidate,
  onToggleSelect,
}) {
  const [emailDraft, setEmailDraft] = useState(assigneeMatch?.autoMatch?.email || '');
  const hasMultipleCandidates = (assigneeMatch?.candidates?.length || 0) > 1;

  return (
    <div className={`task-row task-status-${task.status}`}>
      <div className="task-row-header">
        <label className="task-row-select">
          <input type="checkbox" checked={Boolean(isSelected)} onChange={() => onToggleSelect?.(task)} />
        </label>
        <strong>{STATUS_LABELS[task.status] || task.status}</strong>
        <span>{formatDate(task.updatedAt)}</span>
      </div>

      <TaskForm draft={draft} onFieldChange={(field, value) => onFieldChange(task, field, value)} dueDate={task.dueDate} />

      {task.assigneeExternal ? (
        <div className="task-external-assignee">
          <p>Исполнитель не найден среди контактов — возможно, внешний человек.</p>

          {hasMultipleCandidates ? (
            <label>
              Похожие контакты
              <select
                value=""
                onChange={(event) => {
                  const candidate = assigneeMatch.candidates.find((item) => item.id === event.target.value);

                  if (candidate) {
                    onApplyAssigneeCandidate(task, candidate);
                    setEmailDraft(candidate.email || '');
                  }
                }}
              >
                <option value="">Выбери контакт...</option>
                {assigneeMatch.candidates.map((candidate) => (
                  <option value={candidate.id} key={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            Отправить на email
            <input value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} placeholder="name@example.com" />
          </label>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => onSendEmail(task, emailDraft)}
            disabled={isSendingEmail || !emailDraft.trim()}
          >
            {isSendingEmail ? 'Отправляем...' : 'Отправить задачу на email'}
          </button>
        </div>
      ) : null}

      <div className="task-actions">
        <button className="button button-secondary" type="button" onClick={() => onSave(task)} disabled={isSaving}>
          {isSaving ? 'Сохраняем...' : 'Сохранить'}
        </button>
        <button
          className="button button-primary"
          type="button"
          onClick={() => onConfirm(task)}
          disabled={isSaving || task.status === 'confirmed'}
        >
          Подтвердить
        </button>
        <button className="button button-danger" type="button" onClick={() => onDismiss(task)} disabled={isSaving}>
          Скрыть
        </button>
        <button className="button button-danger" type="button" onClick={() => onDelete(task)} disabled={isSaving || isDeleting}>
          {isDeleting ? 'Удаляем...' : 'Удалить'}
        </button>
        {task.externalRefs?.bitrix24 ? (
          <span className="bitrix-sent-badge">В Б24 #{task.externalRefs.bitrix24.taskId}</span>
        ) : (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => onSendToBitrix(task)}
            disabled={isSaving || isSendingBitrix}
          >
            {isSendingBitrix ? 'Отправляем...' : 'В Битрикс24'}
          </button>
        )}
      </div>
    </div>
  );
}
