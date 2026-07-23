import { useState } from 'react';
import { formatDate } from '../lib/format.js';
import { getStatusLabel, getTaskStatusLabel } from '../lib/statusLabels.js';

/**
 * Страница «Проекты» (US-10.1): список с счётчиками (встречи / открытые
 * задачи), создание (тема обязательна, описание/участники/цвет — нет),
 * правка, архивация, удаление (встречи переходят в «Без проекта») и
 * раскрываемая сводка: встречи, открытые задачи, хронология решений
 * «дата → решение → встреча». Состояние — в useProjects, по образцу
 * ContactsPage.
 */
function ProjectsPage({ projects, projectsPage, onOpenRecording }) {
  const {
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
  } = projectsPage;

  const [showCreate, setShowCreate] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState(null);

  // #11: поиск по названию, сортировка (по названию / по времени последней
  // обработки), закрепление проектов сверху — сортировка и закреп сохраняются
  // на устройстве между сессиями.
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const [pinnedIds, setPinnedIds] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('stenogram-pinned-projects') || '[]'));
    } catch {
      return new Set();
    }
  });

  function togglePin(projectId) {
    setPinnedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        localStorage.setItem('stenogram-pinned-projects', JSON.stringify([...next]));
      } catch {
        // localStorage может быть недоступен — закреп просто не переживёт сессию.
      }
      return next;
    });
  }

  function sortProjects(list) {
    const sorted = [...list].sort((a, b) =>
      sortBy === 'name'
        ? a.name.localeCompare(b.name, 'ru')
        : new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime(),
    );
    // Закреплённые — всегда первыми, порядок между ними сохраняет выбранную сортировку.
    return [...sorted.filter((p) => pinnedIds.has(p.id)), ...sorted.filter((p) => !pinnedIds.has(p.id))];
  }

  const query = searchQuery.trim().toLowerCase();
  const matchesQuery = (project) => !query || project.name.toLowerCase().includes(query);

  const activeProjects = sortProjects(projects.filter((project) => !project.isArchived && matchesQuery(project)));
  const archivedProjects = projects.filter((project) => project.isArchived && matchesQuery(project));

  function renderProject(project) {
    const draft = getProjectDraft(project);
    const isExpanded = expandedProjectId === project.id;
    const isEditing = editingProjectId === project.id;

    return (
      <article className={`project-card ${project.isArchived ? 'is-archived' : ''}`} key={project.id}>
        <div className="project-card-header">
          {!project.isArchived ? (
            <button
              type="button"
              className={`project-pin-toggle${pinnedIds.has(project.id) ? ' is-pinned' : ''}`}
              onClick={() => togglePin(project.id)}
              aria-label={pinnedIds.has(project.id) ? 'Открепить проект' : 'Закрепить проект сверху'}
              title={pinnedIds.has(project.id) ? 'Открепить' : 'Закрепить сверху'}
            >
              {pinnedIds.has(project.id) ? '★' : '☆'}
            </button>
          ) : null}
          <span className="project-chip" style={{ '--project-color': project.color }}>
            {project.name}
          </span>
          {project.isArchived ? <span className="muted-text">в архиве с {formatDate(project.archivedAt)}</span> : null}
          <span className="project-card-counters">
            {project.meetingsCount ?? 0} встреч · {project.openTasksCount ?? 0} открытых задач
          </span>
        </div>

        {project.description ? <p className="muted-text project-card-description">{project.description}</p> : null}

        {project.members?.length ? (
          <p className="muted-text project-card-members">Участники: {project.members.map((member) => member.name).join(', ')}</p>
        ) : null}

        {isEditing ? (
          <div className="project-card-edit">
            <label>
              Тема
              <input value={draft.name} onChange={(event) => updateProjectDraft(project, 'name', event.target.value)} />
            </label>
            <label>
              Цвет
              <input
                className="project-color-input"
                type="color"
                value={draft.color}
                onChange={(event) => updateProjectDraft(project, 'color', event.target.value)}
                aria-label="Цвет проекта"
              />
            </label>
            <label>
              Описание
              <input
                value={draft.description}
                onChange={(event) => updateProjectDraft(project, 'description', event.target.value)}
                placeholder="Необязательно"
              />
            </label>
            <label>
              Участники
              <input
                value={draft.participants}
                onChange={(event) => updateProjectDraft(project, 'participants', event.target.value)}
                placeholder="Имена через запятую"
              />
            </label>
          </div>
        ) : null}

        <div className="project-card-actions">
          {isEditing ? (
            <>
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  handleSaveProject(project);
                  setEditingProjectId(null);
                }}
                disabled={savingProjectId === project.id}
              >
                {savingProjectId === project.id ? 'Сохраняем...' : 'Сохранить'}
              </button>
              <button className="button button-secondary" type="button" onClick={() => setEditingProjectId(null)}>
                Отмена
              </button>
            </>
          ) : (
            <button className="button button-secondary" type="button" onClick={() => setEditingProjectId(project.id)}>
              Изменить
            </button>
          )}
          <button className="button button-secondary" type="button" onClick={() => handleToggleSummary(project)}>
            {isExpanded ? 'Скрыть сводку' : 'Сводка'}
          </button>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => handleToggleArchive(project)}
            disabled={savingProjectId === project.id}
          >
            {project.isArchived ? 'Вернуть из архива' : 'В архив'}
          </button>
          <button
            className="button button-danger"
            type="button"
            onClick={() => handleDeleteProject(project)}
            disabled={deletingProjectId === project.id}
          >
            {deletingProjectId === project.id ? 'Удаляем...' : 'Удалить'}
          </button>
        </div>

        {isExpanded ? (
          <div className="project-summary">
            {isLoadingSummary || !projectSummary ? (
              <p className="muted-text">Собираем сводку...</p>
            ) : (
              <>
                <div className="project-summary-counters">
                  <span>Встреч: {projectSummary.counters.meetings}</span>
                  <span>Открытых задач: {projectSummary.counters.openTasks}</span>
                  <span>Закрытых задач: {projectSummary.counters.doneTasks}</span>
                  <span>Решений: {projectSummary.counters.decisions}</span>
                </div>

                <h4>Встречи</h4>
                {projectSummary.recordings.length ? (
                  <ul className="project-summary-list">
                    {projectSummary.recordings.map((recording) => (
                      <li key={recording.id}>
                        <button className="link-button" type="button" onClick={() => onOpenRecording(recording.id)}>
                          {recording.title}
                        </button>
                        <span className="muted-text">
                          {' '}
                          · {formatDate(recording.createdAt)} · {getStatusLabel(recording.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-text">В проекте пока нет встреч.</p>
                )}

                <h4>Открытые задачи</h4>
                {projectSummary.openTasks.length ? (
                  <ul className="project-summary-list">
                    {projectSummary.openTasks.map((task) => (
                      <li key={task.id}>
                        {task.description}
                        <span className="muted-text">
                          {' '}
                          · {task.assignee || '?'} · {task.dueDate ? formatDate(task.dueDate) : task.dueText || '?'} ·{' '}
                          {getTaskStatusLabel(task.status)} ·{' '}
                        </span>
                        <button className="link-button" type="button" onClick={() => onOpenRecording(task.recordingId)}>
                          {task.recordingTitle}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-text">Открытых задач нет.</p>
                )}

                <h4>Хронология решений</h4>
                {projectSummary.decisions.length ? (
                  <ul className="project-summary-list project-decision-timeline">
                    {projectSummary.decisions.map((decision, index) => (
                      <li key={`${decision.recordingId}-${index}`}>
                        <span className="muted-text">{formatDate(decision.date)}</span> —{' '}
                        {decision.disputed ? <span className="protocol-decision-disputed">⚠ {decision.text}</span> : decision.text} —{' '}
                        <button className="link-button" type="button" onClick={() => onOpenRecording(decision.recordingId)}>
                          {decision.recordingTitle}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-text">Решений в протоколах пока нет.</p>
                )}
              </>
            )}
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <section className="projects-page" aria-label="Проекты">
      {/* #11: поиск по названию + сортировка (имя / последняя обработка). */}
      <div className="projects-toolbar">
        <input
          className="projects-search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Поиск проекта по названию"
        />
        <button
          className="button button-secondary"
          type="button"
          onClick={() => setSortBy((current) => (current === 'name' ? 'recent' : 'name'))}
          title="Сортировка проектов"
        >
          {sortBy === 'name' ? 'По названию' : 'По активности'}
        </button>
      </div>

      <button
        className="button button-primary add-toggle"
        type="button"
        onClick={() => setShowCreate((current) => !current)}
        aria-expanded={showCreate}
      >
        {showCreate ? 'Свернуть' : '＋ Новый проект'}
      </button>

      {showCreate ? (
      <form className="project-create-panel" onSubmit={handleCreateProject}>
        <h3>Новый проект</h3>
        <div className="project-create-fields">
          <label>
            Тема
            <input
              value={newProjectDraft.name}
              onChange={(event) => setNewProjectDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Обязательное поле"
            />
          </label>
          <label>
            Цвет
            <input
              className="project-color-input"
              type="color"
              value={newProjectDraft.color}
              onChange={(event) => setNewProjectDraft((current) => ({ ...current, color: event.target.value }))}
              aria-label="Цвет проекта"
            />
          </label>
          <label>
            Описание
            <input
              value={newProjectDraft.description}
              onChange={(event) => setNewProjectDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="Необязательно"
            />
          </label>
          <label>
            Участники
            <input
              value={newProjectDraft.participants}
              onChange={(event) => setNewProjectDraft((current) => ({ ...current, participants: event.target.value }))}
              placeholder="Имена через запятую, необязательно"
            />
          </label>
        </div>
        <button className="button button-primary" type="submit" disabled={isCreatingProject}>
          {isCreatingProject ? 'Создаём...' : 'Создать проект'}
        </button>
      </form>
      ) : null}

      {projects.length === 0 ? <p className="muted-text">Проектов пока нет — создай первый, чтобы объединять встречи по темам.</p> : null}

      {activeProjects.length ? <div className="project-list">{activeProjects.map(renderProject)}</div> : null}

      {archivedProjects.length ? (
        <details className="projects-archive">
          <summary>Архив ({archivedProjects.length})</summary>
          <div className="project-list">{archivedProjects.map(renderProject)}</div>
        </details>
      ) : null}
    </section>
  );
}

export default ProjectsPage;
