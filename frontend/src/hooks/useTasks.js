import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';

/**
 * Owns the task list state for the currently open recording: per-task edit
 * drafts, the new-task form, selection + bulk actions (US-9.2), contact
 * matching and the per-task email/Bitrix sends. Mutations write back into
 * the recording via setSelectedRecording, exactly as the pre-split App.jsx
 * did.
 */
export default function useTasks({ selectedRecording, setSelectedRecording, setStatus, loadRecordingDetail }) {
  const [savingTaskId, setSavingTaskId] = useState(null);
  const [deletingTaskId, setDeletingTaskId] = useState(null);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState({});
  const [selectedTaskIds, setSelectedTaskIds] = useState(new Set());
  const [taskAssigneeMatches, setTaskAssigneeMatches] = useState({});
  const [isLoadingTaskAssigneeMatches, setIsLoadingTaskAssigneeMatches] = useState(false);
  const [sendingTaskEmailId, setSendingTaskEmailId] = useState(null);
  const [sendingTaskTelegramId, setSendingTaskTelegramId] = useState(null);
  const [bulkAssigneeDraft, setBulkAssigneeDraft] = useState('');
  const [bulkDueTextDraft, setBulkDueTextDraft] = useState('');
  const [isBulkUpdatingTasks, setIsBulkUpdatingTasks] = useState(false);
  const [newTaskDraft, setNewTaskDraft] = useState({ assignee: '', dueText: '', description: '' });
  const [isSendingBitrixTaskId, setIsSendingBitrixTaskId] = useState(null);

  function getTaskDraft(task) {
    return (
      taskDrafts[task.id] || {
        assignee: task.assignee || '',
        dueText: task.dueText || '',
        description: task.description || '',
      }
    );
  }

  function updateTaskDraft(task, field, value) {
    setTaskDrafts((current) => ({
      ...current,
      [task.id]: {
        ...getTaskDraft(task),
        [field]: value,
      },
    }));
  }

  function applyTaskUpdate(task) {
    setSelectedRecording((current) => {
      if (!current?.tasks) {
        return current;
      }

      const tasks =
        task.status === 'dismissed'
          ? current.tasks.filter((item) => item.id !== task.id)
          : current.tasks.map((item) => (item.id === task.id ? task : item));

      return { ...current, tasks };
    });
  }

  function appendTask(task) {
    setSelectedRecording((current) =>
      current ? { ...current, tasks: [...(current.tasks || []), task] } : current,
    );
  }

  function removeTask(taskId) {
    setSelectedRecording((current) =>
      current?.tasks ? { ...current, tasks: current.tasks.filter((task) => task.id !== taskId) } : current,
    );
    setTaskDrafts((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }

  function updateNewTaskDraft(field, value) {
    setNewTaskDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleAddTask(event) {
    event.preventDefault();

    if (!selectedRecording) {
      return;
    }

    if (!newTaskDraft.description.trim()) {
      setStatus('Заполни описание задачи');
      return;
    }

    setIsAddingTask(true);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify(newTaskDraft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось добавить задачу');
      }

      appendTask(data.task);
      setNewTaskDraft({ assignee: '', dueText: '', description: '' });
      setStatus('Задача добавлена');
    } catch (error) {
      setStatus(error.message || 'Ошибка добавления задачи');
    } finally {
      setIsAddingTask(false);
    }
  }

  async function updateTask(task, patch, successMessage) {
    if (!selectedRecording) {
      return;
    }

    setSavingTaskId(task.id);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось обновить задачу');
      }

      applyTaskUpdate(data.task);
      setTaskDrafts((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setStatus(successMessage);
    } catch (error) {
      setStatus(error.message || 'Ошибка обновления задачи');
    } finally {
      setSavingTaskId(null);
    }
  }

  async function handleSaveTask(task) {
    const draft = getTaskDraft(task);

    await updateTask(
      task,
      {
        assignee: draft.assignee,
        dueText: draft.dueText,
        description: draft.description,
      },
      'Задача сохранена',
    );
  }

  async function handleConfirmTask(task) {
    await updateTask(task, { status: 'confirmed' }, 'Задача подтверждена');
  }

  async function handleDismissTask(task) {
    await updateTask(task, { status: 'dismissed' }, 'Задача скрыта');
  }

  async function handleDeleteTask(task) {
    if (!selectedRecording) {
      return;
    }

    const confirmed = window.confirm('Удалить задачу окончательно?');

    if (!confirmed) {
      return;
    }

    setDeletingTaskId(task.id);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks/${task.id}`, {
        method: 'DELETE',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось удалить задачу');
      }

      removeTask(task.id);
      setStatus('Задача удалена');
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления задачи');
    } finally {
      setDeletingTaskId(null);
    }
  }

  // Кнопка «В Telegram: <контакт>» (US-11.3) зависит от сопоставления
  // исполнителей, поэтому оно подгружается тихо при открытии записи, а не
  // только по ручной кнопке «Подобрать исполнителей» (она остаётся для
  // повторного прогона после правки контактов).
  useEffect(() => {
    setTaskAssigneeMatches({});

    if (!selectedRecording?.id || !selectedRecording?.tasks?.length) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch(`/api/recordings/${selectedRecording.id}/task-assignee-matches`);
        const data = await response.json();

        if (!cancelled && response.ok) {
          setTaskAssigneeMatches(Object.fromEntries((data.matches || []).map((match) => [match.taskId, match])));
        }
      } catch {
        // Тихая фоновая загрузка: без сопоставления задачи просто останутся без
        // кнопки Telegram, ручная кнопка подбора никуда не девается.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRecording?.id, selectedRecording?.tasks?.length]);

  async function handleMatchTaskAssignees() {
    if (!selectedRecording) {
      return;
    }

    setIsLoadingTaskAssigneeMatches(true);
    setStatus('Ищем совпадения исполнителей в контактах...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/task-assignee-matches`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сопоставить исполнителей с контактами');
      }

      setTaskAssigneeMatches(Object.fromEntries((data.matches || []).map((match) => [match.taskId, match])));
      setStatus('Исполнители сопоставлены с контактами');
    } catch (error) {
      setStatus(error.message || 'Ошибка сопоставления исполнителей');
    } finally {
      setIsLoadingTaskAssigneeMatches(false);
    }
  }

  function applyTaskAssigneeCandidate(task, candidate) {
    setTaskDrafts((current) => ({
      ...current,
      [task.id]: { ...getTaskDraft(task), assignee: candidate.name },
    }));
  }

  function toggleTaskSelection(task) {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(task.id)) {
        next.delete(task.id);
      } else {
        next.add(task.id);
      }
      return next;
    });
  }

  async function handleSendTaskEmail(task, email) {
    if (!selectedRecording || !email?.trim()) {
      return;
    }

    setSendingTaskEmailId(task.id);
    setStatus('Отправляем задачу на email...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks/${task.id}/send-email`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить задачу на email');
      }

      applyTaskUpdate(data.task);
      setStatus('Задача отправлена на email');
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки задачи на email');
    } finally {
      setSendingTaskEmailId(null);
    }
  }

  async function handleSendTaskTelegram(task, chatId) {
    if (!selectedRecording || !chatId) {
      return;
    }

    setSendingTaskTelegramId(task.id);
    setStatus('Отправляем задачу в Telegram...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/tasks/${task.id}/send-telegram`, {
        method: 'POST',
        body: JSON.stringify({ chatId }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить задачу в Telegram');
      }

      applyTaskUpdate(data.task);
      setStatus('Задача отправлена в Telegram');
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки задачи в Telegram');
    } finally {
      setSendingTaskTelegramId(null);
    }
  }

  async function handleSendTaskToBitrix(task) {
    if (!selectedRecording) {
      return;
    }

    setIsSendingBitrixTaskId(task.id);
    setStatus(`Отправляем задачу в Битрикс24...`);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/bitrix`, {
        method: 'POST',
        body: JSON.stringify({ taskIds: [task.id] }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось отправить задачу в Битрикс24');
      }

      const result = data.results?.[0];

      if (result && !result.ok) {
        throw new Error(result.error || 'Битрикс24 отклонил задачу');
      }

      await loadRecordingDetail(selectedRecording.id, { quiet: true });
      setStatus('Задача отправлена в Битрикс24');
    } catch (error) {
      setStatus(error.message || 'Ошибка отправки в Битрикс24');
    } finally {
      setIsSendingBitrixTaskId(null);
    }
  }

  // Bulk actions (US-9.2) loop the existing single-task PATCH endpoint over
  // the selected ids - task counts per meeting are small, so a dedicated
  // bulk backend route isn't worth the extra abstraction (same call as
  // handleConfirmTask/handleSaveTask, just repeated).
  async function handleBulkConfirm() {
    if (!selectedRecording?.tasks?.length) {
      return;
    }

    const targets = selectedTaskIds.size
      ? selectedRecording.tasks.filter((task) => selectedTaskIds.has(task.id))
      : selectedRecording.tasks.filter((task) => task.status !== 'confirmed' && task.status !== 'dismissed');

    if (!targets.length) {
      setStatus('Нечего подтверждать');
      return;
    }

    setIsBulkUpdatingTasks(true);
    setStatus(`Подтверждаем ${targets.length} задач...`);

    try {
      for (const task of targets) {
        await updateTask(task, { status: 'confirmed' }, null);
      }
      setStatus(`Подтверждено задач: ${targets.length}`);
    } finally {
      setIsBulkUpdatingTasks(false);
    }
  }

  async function handleBulkAssign() {
    if (!selectedRecording?.tasks?.length || !bulkAssigneeDraft.trim() || !selectedTaskIds.size) {
      setStatus('Выбери задачи и укажи исполнителя');
      return;
    }

    const targets = selectedRecording.tasks.filter((task) => selectedTaskIds.has(task.id));
    setIsBulkUpdatingTasks(true);
    setStatus(`Назначаем исполнителя для ${targets.length} задач...`);

    try {
      for (const task of targets) {
        await updateTask(task, { assignee: bulkAssigneeDraft.trim() }, null);
      }
      setBulkAssigneeDraft('');
      setStatus(`Исполнитель назначен для ${targets.length} задач`);
    } finally {
      setIsBulkUpdatingTasks(false);
    }
  }

  async function handleBulkDueText() {
    if (!selectedRecording?.tasks?.length || !bulkDueTextDraft.trim() || !selectedTaskIds.size) {
      setStatus('Выбери задачи и укажи срок');
      return;
    }

    const targets = selectedRecording.tasks.filter((task) => selectedTaskIds.has(task.id));
    setIsBulkUpdatingTasks(true);
    setStatus(`Меняем срок для ${targets.length} задач...`);

    try {
      for (const task of targets) {
        await updateTask(task, { dueText: bulkDueTextDraft.trim() }, null);
      }
      setBulkDueTextDraft('');
      setStatus(`Срок изменён для ${targets.length} задач`);
    } finally {
      setIsBulkUpdatingTasks(false);
    }
  }

  return {
    savingTaskId,
    deletingTaskId,
    isAddingTask,
    selectedTaskIds,
    taskAssigneeMatches,
    isLoadingTaskAssigneeMatches,
    sendingTaskEmailId,
    sendingTaskTelegramId,
    handleSendTaskTelegram,
    bulkAssigneeDraft,
    setBulkAssigneeDraft,
    bulkDueTextDraft,
    setBulkDueTextDraft,
    isBulkUpdatingTasks,
    newTaskDraft,
    isSendingBitrixTaskId,
    getTaskDraft,
    updateTaskDraft,
    updateNewTaskDraft,
    handleAddTask,
    handleSaveTask,
    handleConfirmTask,
    handleDismissTask,
    handleDeleteTask,
    handleMatchTaskAssignees,
    applyTaskAssigneeCandidate,
    toggleTaskSelection,
    handleSendTaskEmail,
    handleSendTaskToBitrix,
    handleBulkConfirm,
    handleBulkAssign,
    handleBulkDueText,
  };
}
