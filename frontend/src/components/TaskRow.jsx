import { useState } from 'react';
import { formatDate } from '../lib/format.js';
import { TASK_STATUS_LABELS as STATUS_LABELS } from '../lib/statusLabels.js';
import TaskForm from './TaskForm.jsx';

export default function TaskRow({
  task,
  draft,
  isSaving,
  isDeleting,
  isSendingBitrix,
  isSendingEmail,
  isSendingTelegram,
  isSelected,
  assigneeMatch,
  onFieldChange,
  onSave,
  onConfirm,
  onDismiss,
  onDelete,
  onSendToBitrix,
  onToggleBitrixPanel,
  onBitrixDraftChange,
  isBitrixPanelOpen,
  bitrixDirectory,
  bitrixDraft,
  bitrixMatch,
  bitrixDuplicates,
  onSendEmail,
  onSendTelegram,
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
          task.externalRefs.bitrix24.url ? (
            <a className="bitrix-sent-badge" href={task.externalRefs.bitrix24.url} target="_blank" rel="noreferrer">
              В Б24 #{task.externalRefs.bitrix24.taskId} →
            </a>
          ) : (
            <span className="bitrix-sent-badge">В Б24 #{task.externalRefs.bitrix24.taskId}</span>
          )
        ) : (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => onToggleBitrixPanel(task)}
            disabled={isSaving}
          >
            {isBitrixPanelOpen ? 'Свернуть Битрикс24' : 'В Битрикс24'}
          </button>
        )}
        {/* US-11.3: личный чат исполнителю. Кнопка есть только когда исполнитель
            однозначно сопоставлен с контактом, у которого привязан Telegram. */}
        {task.externalRefs?.telegram ? (
          <span className="bitrix-sent-badge">В Telegram ✓</span>
        ) : assigneeMatch?.autoMatch?.telegramChatId ? (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => onSendTelegram(task, assigneeMatch.autoMatch.telegramChatId)}
            disabled={isSaving || isSendingTelegram}
          >
            {isSendingTelegram ? 'Отправляем...' : `В Telegram: ${assigneeMatch.autoMatch.name}`}
          </button>
        ) : assigneeMatch?.autoMatch ? (
          <span className="muted-text task-telegram-hint">
            У «{assigneeMatch.autoMatch.name}» не привязан Telegram — задача остаётся в Stenogram.
          </span>
        ) : null}
      </div>

      {/* US-11.4: сотрудника и группу проекта выбирает пользователь. */}
      {isBitrixPanelOpen ? (
        <div className="bitrix-send-panel">
          {bitrixDirectory.isLoading ? <p className="muted-text">Получаем сотрудников и группы из Битрикс24...</p> : null}
          {bitrixDirectory.error ? <p className="task-bitrix-error">{bitrixDirectory.error}</p> : null}

          {bitrixDirectory.loaded && !bitrixDirectory.error ? (
            <>
              <label>
                Сотрудник Битрикс24
                <select
                  value={bitrixDraft.responsibleId}
                  onChange={(event) => onBitrixDraftChange(task, 'responsibleId', event.target.value)}
                >
                  <option value="">Не выбран</option>
                  {bitrixDirectory.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </select>
              </label>

              {!bitrixDraft.responsibleId ? (
                <p className="muted-text">
                  {bitrixMatch?.candidates?.length
                    ? 'Есть похожие сотрудники — выберите из списка.'
                    : 'Сотрудник не найден в Битрикс24 — без выбора задача не отправится.'}
                </p>
              ) : null}

              <label>
                Группа проекта
                <select
                  value={bitrixDraft.groupId}
                  onChange={(event) => onBitrixDraftChange(task, 'groupId', event.target.value)}
                >
                  <option value="">Без группы</option>
                  {bitrixDirectory.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>

              {bitrixDuplicates ? (
                <div className="task-bitrix-duplicate" role="alert">
                  <strong>В Битрикс24 уже есть задача с таким названием:</strong>
                  <ul>
                    {bitrixDuplicates.items.map((duplicate) => (
                      <li key={duplicate.id}>
                        {duplicate.url ? (
                          <a href={duplicate.url} target="_blank" rel="noreferrer">
                            #{duplicate.id} {duplicate.title}
                          </a>
                        ) : (
                          `#${duplicate.id} ${duplicate.title}`
                        )}
                      </li>
                    ))}
                  </ul>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => onSendToBitrix(task, { confirmDuplicate: true })}
                    disabled={isSendingBitrix}
                  >
                    {isSendingBitrix ? 'Отправляем...' : 'Всё равно создать'}
                  </button>
                </div>
              ) : (
                <button
                  className="button button-primary"
                  type="button"
                  onClick={() => onSendToBitrix(task)}
                  disabled={isSendingBitrix || !bitrixDraft.responsibleId}
                >
                  {isSendingBitrix ? 'Отправляем...' : 'Создать задачу в Битрикс24'}
                </button>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
