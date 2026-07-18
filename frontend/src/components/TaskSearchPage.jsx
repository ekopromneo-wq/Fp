import { useEffect } from 'react';
import VoiceInputButton from './VoiceInputButton.jsx';
import { formatDate } from '../lib/format.js';
import { getTaskStatusLabel, TASK_STATUS_LABELS } from '../lib/statusLabels.js';
import { buildTaskSearchExport, downloadTextFile } from '../lib/exporters.js';
import { track } from '../lib/api.js';

/**
 * Страница поиска по задачам всех встреч (US-10.2): текстовый запрос по
 * исполнителю/описанию + фильтры статус/проект/диапазон сроков, переход к
 * встрече-источнику и экспорт результатов в .md. Состояние живёт в
 * useTaskSearch, компонент презентационный — по образцу ContactsPage.
 */
function TaskSearchPage({ search, projectOptions, onOpenRecording, onDictate, setStatus }) {
  const { taskFilters, setTaskFilters, taskResults, isSearchingTasks, hasSearchedTasks, searchTasks, resetTaskSearch } = search;

  // Воронка активации (NFR §9): пользователь открыл раздел задач.
  useEffect(() => {
    track('tasks_opened');
  }, []);

  function setFilter(key, value) {
    setTaskFilters((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    searchTasks();
  }

  function handleExport() {
    downloadTextFile('tasks-search.md', buildTaskSearchExport(taskResults, taskFilters));
    setStatus('Результаты поиска задач скачаны');
  }

  return (
    <section className="task-search-page" aria-label="Поиск задач">
      <form className="task-search-form" onSubmit={handleSubmit}>
        <label>
          Что ищем
          <span className="search-input-group">
            <input
              value={taskFilters.search}
              onChange={(event) => setFilter('search', event.target.value)}
              placeholder="Текст задачи или исполнитель"
            />
            <VoiceInputButton
              onDictate={onDictate}
              onText={(text) => setFilter('search', text)}
              setStatus={setStatus}
              title="Голосовой поиск"
            />
          </span>
        </label>

        <label>
          Статус
          <select value={taskFilters.status} onChange={(event) => setFilter('status', event.target.value)}>
            <option value="">Любой статус</option>
            {Object.entries(TASK_STATUS_LABELS)
              .filter(([value]) => value !== 'dismissed')
              .map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
          </select>
        </label>

        <label>
          Проект
          <select value={taskFilters.projectId} onChange={(event) => setFilter('projectId', event.target.value)}>
            <option value="">Все проекты</option>
            {projectOptions.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
                {project.isArchived ? ' (архив)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          Срок с
          <input type="date" value={taskFilters.dueFrom} onChange={(event) => setFilter('dueFrom', event.target.value)} />
        </label>

        <label>
          Срок по
          <input type="date" value={taskFilters.dueTo} onChange={(event) => setFilter('dueTo', event.target.value)} />
        </label>

        <div className="task-search-actions">
          <button className="button button-primary" type="submit" disabled={isSearchingTasks}>
            {isSearchingTasks ? 'Ищем...' : 'Найти задачи'}
          </button>
          <button className="button button-secondary" type="button" onClick={resetTaskSearch} disabled={isSearchingTasks}>
            Сбросить
          </button>
          <button className="button button-secondary" type="button" onClick={handleExport} disabled={!taskResults.length}>
            Скачать .md
          </button>
        </div>
      </form>

      {!hasSearchedTasks ? (
        <p className="muted-text">Задай запрос или фильтры и нажми «Найти задачи» — ищем по задачам всех встреч.</p>
      ) : taskResults.length === 0 ? (
        <p className="muted-text">Ничего не найдено — попробуй смягчить фильтры.</p>
      ) : (
        <div className="task-search-results">
          <p className="muted-text">Найдено задач: {taskResults.length}</p>
          {taskResults.map((task) => (
            <article className="task-search-result" key={task.id}>
              <div className="task-search-result-main">
                <strong>{task.description}</strong>
                <div className="task-search-result-meta">
                  <span>{task.assignee || '?'}</span>
                  <span>{task.dueDate ? formatDate(task.dueDate) : task.dueText || '?'}</span>
                  <span className="status-pill">{getTaskStatusLabel(task.status)}</span>
                </div>
              </div>
              <button className="button button-secondary" type="button" onClick={() => onOpenRecording(task.recordingId)}>
                {task.recordingTitle || 'К встрече'} →
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default TaskSearchPage;
