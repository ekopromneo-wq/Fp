import { formatDate } from '../lib/format.js';
import TaskForm from './TaskForm.jsx';

export default function TaskRow({
  task,
  draft,
  isSaving,
  isDeleting,
  isSendingBitrix,
  onFieldChange,
  onSave,
  onConfirm,
  onDismiss,
  onDelete,
  onSendToBitrix,
}) {
  return (
    <div className={`task-row task-status-${task.status}`}>
      <div className="task-row-header">
        <strong>{task.status === 'confirmed' ? 'Подтверждена' : 'Извлечена'}</strong>
        <span>{formatDate(task.updatedAt)}</span>
      </div>

      <TaskForm draft={draft} onFieldChange={(field, value) => onFieldChange(task, field, value)} />

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
