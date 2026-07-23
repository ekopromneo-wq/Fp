import { useState } from 'react';
import VoiceInputButton from './VoiceInputButton.jsx';
import { MEETING_TYPE_OPTIONS } from '../lib/exporters.js';

// Значения соответствуют фильтру бэкенда (listRecordings): 'bot' на сервере
// раскрывается в оба бот-источника (meeting_bot + recorder_bot).
const SOURCE_OPTIONS = [
  { value: '', label: 'Любой источник' },
  { value: 'frontend-upload', label: 'Загрузка файла' },
  { value: 'frontend-microphone', label: 'Микрофон' },
  { value: 'bot', label: 'Бот на встрече' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'Любой статус' },
  { value: 'uploaded', label: 'Загружено' },
  { value: 'queued', label: 'В очереди' },
  { value: 'transcribing', label: 'Расшифровываем' },
  { value: 'summarizing', label: 'Создаём протокол' },
  { value: 'done', label: 'Готово' },
  { value: 'failed', label: 'Ошибка' },
];

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18l-7 8v5l-4 2v-7z" />
    </svg>
  );
}

function LibraryControls({
  searchQuery,
  setSearchQuery,
  projectFilter,
  setProjectFilter,
  projectOptions,
  filters,
  setFilters,
  onDictate,
  setStatus,
  trashMode,
  onToggleTrash,
  sortOrder,
  onToggleSort,
  selectionMode,
  onToggleSelectionMode,
  onCreateMeeting,
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const activeExtraCount = Object.values(filters).filter(Boolean).length;

  function setFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="library-controls" aria-label="Фильтры библиотеки">
      <div className="library-controls-row">
        <label>
          Поиск
          <span className="search-input-group">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Название, файл, проект или текст стенограммы"
            />
            <VoiceInputButton onDictate={onDictate} onText={setSearchQuery} setStatus={setStatus} title="Голосовой поиск" />
          </span>
        </label>

        <label>
          Проект
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">Все проекты</option>
            {projectOptions.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
                {project.isArchived ? ' (архив)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="library-controls-actions">
        {/* #5: создать встречу загрузкой файла или ссылкой, с выбором шаблона обработки. */}
        <button className="button button-primary" type="button" onClick={onCreateMeeting}>
          ＋ Новая встреча
        </button>

        <button className="button button-secondary" type="button" onClick={onToggleTrash}>
          {trashMode ? '← К встречам' : 'Корзина'}
        </button>

        <button
          className="button button-secondary"
          type="button"
          onClick={onToggleSort}
          title="Порядок по времени создания"
        >
          {sortOrder === 'asc' ? '↑ Старые' : '↓ Новые'}
        </button>

        {/* #3: групповые действия — выбор нескольких встреч для удаления. */}
        <button
          className={`button button-secondary${selectionMode ? ' is-active' : ''}`}
          type="button"
          onClick={onToggleSelectionMode}
        >
          {selectionMode ? 'Отменить выбор' : 'Выбрать'}
        </button>

        <button
          className={`button button-secondary icon-button library-filter-toggle${isExpanded || activeExtraCount ? ' is-active' : ''}`}
          type="button"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Скрыть фильтры' : 'Фильтры'}
          title={isExpanded ? 'Скрыть фильтры' : 'Фильтры'}
        >
          <FilterIcon />
          {activeExtraCount ? <span className="filter-badge">{activeExtraCount}</span> : null}
        </button>
      </div>

      {isExpanded ? (
        <div className="library-extra-filters">
          <label>
            Дата с
            <input type="date" value={filters.dateFrom} onChange={(event) => setFilter('dateFrom', event.target.value)} />
          </label>

          <label>
            Дата по
            <input type="date" value={filters.dateTo} onChange={(event) => setFilter('dateTo', event.target.value)} />
          </label>

          <label>
            Статус
            <select value={filters.status} onChange={(event) => setFilter('status', event.target.value)}>
              {STATUS_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Источник
            <select value={filters.source} onChange={(event) => setFilter('source', event.target.value)}>
              {SOURCE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Тип встречи
            <select value={filters.meetingType} onChange={(event) => setFilter('meetingType', event.target.value)}>
              <option value="">Любой тип</option>
              {MEETING_TYPE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Участник
            <input
              value={filters.participant}
              onChange={(event) => setFilter('participant', event.target.value)}
              placeholder="Имя спикера или контакта"
            />
          </label>

          <label>
            Задачи
            <select value={filters.hasTasks} onChange={(event) => setFilter('hasTasks', event.target.value)}>
              <option value="">Неважно</option>
              <option value="yes">Есть задачи</option>
              <option value="no">Нет задач</option>
            </select>
          </label>

          {activeExtraCount ? (
            <button
              className="button button-secondary library-filters-reset"
              type="button"
              onClick={() =>
                setFilters({ dateFrom: '', dateTo: '', status: '', source: '', meetingType: '', participant: '', hasTasks: '' })
              }
            >
              Сбросить
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default LibraryControls;
