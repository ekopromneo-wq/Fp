import { useState } from 'react';
import { apiFetch } from '../lib/api.js';

const EMPTY_DRAFT = { name: '', color: '#235b4f', description: '', participants: '' };

// Участники в форме — строка имён через запятую (в MVP это просто
// информационный список без прав доступа, US-10.1); на бэкенд уходит
// массив {name}, contactId остаётся null.
function parseParticipants(text) {
  return String(text || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function participantsToText(project) {
  return (project.members || []).map((member) => member.name).join(', ');
}

/**
 * Состояние страницы «Проекты» (US-10.1): создание (тема обязательна,
 * описание/участники опциональны), правка, архивация, удаление (встречи
 * переходят в «Без проекта», ADR-030) и сводка проекта — встречи, открытые
 * задачи, хронология решений, счётчики. Список проектов живёт в App.jsx
 * (нужен и фильтрам библиотеки), сюда передаётся только loadProjects.
 */
export default function useProjects(setStatus, loadProjects) {
  const [newProjectDraft, setNewProjectDraft] = useState(EMPTY_DRAFT);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectEditDrafts, setProjectEditDrafts] = useState({});
  const [savingProjectId, setSavingProjectId] = useState(null);
  const [deletingProjectId, setDeletingProjectId] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [projectSummary, setProjectSummary] = useState(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);

  async function handleCreateProject(event) {
    event.preventDefault();

    if (!newProjectDraft.name.trim()) {
      setStatus('Заполни тему проекта');
      return;
    }

    setIsCreatingProject(true);

    try {
      const response = await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: newProjectDraft.name,
          color: newProjectDraft.color,
          description: newProjectDraft.description,
          participants: parseParticipants(newProjectDraft.participants),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось создать проект');
      }

      setNewProjectDraft(EMPTY_DRAFT);
      await loadProjects();
      setStatus(`Проект «${data.project.name}» создан`);
    } catch (error) {
      setStatus(error.message || 'Ошибка создания проекта');
    } finally {
      setIsCreatingProject(false);
    }
  }

  function getProjectDraft(project) {
    return (
      projectEditDrafts[project.id] || {
        name: project.name,
        color: project.color,
        description: project.description || '',
        participants: participantsToText(project),
      }
    );
  }

  function updateProjectDraft(project, field, value) {
    setProjectEditDrafts((current) => ({
      ...current,
      [project.id]: { ...getProjectDraft(project), [field]: value },
    }));
  }

  async function patchProject(projectId, payload, pendingMessage, doneMessage) {
    setSavingProjectId(projectId);

    if (pendingMessage) {
      setStatus(pendingMessage);
    }

    try {
      const response = await apiFetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить проект');
      }

      await loadProjects();

      if (expandedProjectId === projectId) {
        await loadProjectSummary(projectId);
      }

      setStatus(doneMessage);
      return true;
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения проекта');
      return false;
    } finally {
      setSavingProjectId(null);
    }
  }

  async function handleSaveProject(project) {
    const draft = getProjectDraft(project);

    if (!draft.name.trim()) {
      setStatus('Тема проекта не может быть пустой');
      return;
    }

    const saved = await patchProject(
      project.id,
      {
        name: draft.name,
        color: draft.color,
        description: draft.description,
        participants: parseParticipants(draft.participants),
      },
      null,
      `Проект «${draft.name.trim()}» сохранён`,
    );

    if (saved) {
      setProjectEditDrafts((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
    }
  }

  function handleToggleArchive(project) {
    return patchProject(
      project.id,
      { archived: !project.isArchived },
      null,
      project.isArchived ? `Проект «${project.name}» возвращён из архива` : `Проект «${project.name}» отправлен в архив`,
    );
  }

  async function handleDeleteProject(project) {
    const confirmed = window.confirm(
      `Удалить проект «${project.name}»? Встречи не удалятся — они перейдут в «Без проекта».`,
    );

    if (!confirmed) {
      return;
    }

    setDeletingProjectId(project.id);

    try {
      const response = await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE' });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось удалить проект');
      }

      if (expandedProjectId === project.id) {
        setExpandedProjectId(null);
        setProjectSummary(null);
      }

      await loadProjects();
      setStatus(`Проект «${project.name}» удалён, встречи остались без проекта`);
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления проекта');
    } finally {
      setDeletingProjectId(null);
    }
  }

  async function loadProjectSummary(projectId) {
    setIsLoadingSummary(true);

    try {
      const response = await apiFetch(`/api/projects/${projectId}/summary`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить сводку проекта');
      }

      setProjectSummary(data);
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки сводки проекта');
      setProjectSummary(null);
    } finally {
      setIsLoadingSummary(false);
    }
  }

  function handleToggleSummary(project) {
    if (expandedProjectId === project.id) {
      setExpandedProjectId(null);
      setProjectSummary(null);
      return;
    }

    setExpandedProjectId(project.id);
    setProjectSummary(null);
    loadProjectSummary(project.id);
  }

  return {
    newProjectDraft,
    setNewProjectDraft,
    isCreatingProject,
    handleCreateProject,
    getProjectDraft,
    updateProjectDraft,
    savingProjectId,
    handleSaveProject,
    handleToggleArchive,
    deletingProjectId,
    handleDeleteProject,
    expandedProjectId,
    projectSummary,
    isLoadingSummary,
    handleToggleSummary,
  };
}
