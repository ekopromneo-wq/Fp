import { useEffect, useState } from 'react';
import { apiFetch, isProcessingStatus } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import { getStatusLabel, getTaskStatusLabel } from '../lib/statusLabels.js';

// Приоритет блоков по US-13.1: текущая обработка → готовые протоколы → задачи →
// предстоящие встречи → ошибки.
const BLOCKS = [
  { key: 'processing', label: 'Сейчас обрабатывается' },
  { key: 'ready', label: 'Готовые протоколы' },
  { key: 'tasks', label: 'Задачи' },
  { key: 'upcoming', label: 'Предстоящие встречи' },
  { key: 'failed', label: 'Ошибки' },
];

const OPEN_TASK_STATUSES = new Set(['extracted', 'confirmed', 'sent', 'in_progress']);

function isOverdue(task) {
  return task.dueDate && new Date(task.dueDate).getTime() < Date.now() && OPEN_TASK_STATUSES.has(task.status);
}

function todayLine() {
  return new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Контекстный главный экран (US-13.1): первое действие — запись, дальше блоки
 * по приоритету, всего около десятка карточек. Состав блоков настраивается и
 * запоминается (uiStore).
 */
export default function HomePage({
  recordings,
  isLoading,
  isMicRecording,
  onStartRecording,
  onOpenRecording,
  setActivePage,
  hiddenBlocks,
  onToggleBlock,
  onUploadFile,
  meetingBotDraft,
  setMeetingBotDraft,
  onJoinMeeting,
  isJoiningMeeting,
}) {
  const [tasks, setTasks] = useState(null); // null = ещё грузятся
  const [upcoming, setUpcoming] = useState([]);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [showBotModal, setShowBotModal] = useState(false);

  // Задачи по всем встречам — тем же поиском, что и страница «Поиск задач»;
  // сортировка по сроку уже на сервере, просроченные окажутся первыми.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch('/api/tasks/search');
        const data = await response.json();

        if (!cancelled) {
          setTasks(response.ok ? (data.tasks || []).filter((task) => OPEN_TASK_STATUSES.has(task.status)) : []);
        }
      } catch {
        // Главный экран не должен падать из-за блока задач — он просто останется пустым.
        if (!cancelled) {
          setTasks([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // US-16.5: предстоящие встречи из подключённого календаря. Пусто (нет
  // календаря/подключения) — блок не показывается.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch('/api/calendar/upcoming');
        const data = await response.json();
        if (!cancelled && response.ok) {
          setUpcoming(data.upcoming || []);
        }
      } catch {
        // блок встреч необязателен
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const processing = recordings.filter((recording) => isProcessingStatus(recording.status));
  const ready = recordings.filter((recording) => recording.status === 'done').slice(0, 4);
  const failed = recordings.filter((recording) => recording.status === 'failed').slice(0, 3);
  const openTasks = (tasks || []).slice(0, 5);
  const isHidden = (key) => hiddenBlocks.includes(key);

  return (
    <section className="home-page" aria-label="Главный экран">
      <div className="home-hero">
        <div className="home-hero-head">
          <div>
            <p className="eyebrow">{todayLine()}</p>
            <h2>{isMicRecording ? 'Идёт запись' : 'Записать встречу'}</h2>
          </div>
          <button
            className="button button-secondary icon-button home-hero-config"
            type="button"
            onClick={() => setIsConfiguring((current) => !current)}
            aria-label="Настроить главный экран"
            title="Настроить главный экран"
          >
            ⚙
          </button>
        </div>
        {/* Запись — центральная кнопка-микрофон внизу; на главной оставляем только
            загрузку файла и приглашение бота, компактными кнопками. */}
        <div className="home-hero-actions">
          <label className="button button-secondary home-hero-action">
            Загрузить
            <input
              type="file"
              accept="audio/*,video/*,.webm,.mp3,.wav,.m4a,.ogg,.mp4,.mov,.mkv"
              hidden
              onChange={onUploadFile}
            />
          </label>
          <button
            className="button button-secondary home-hero-action"
            type="button"
            onClick={() => setShowBotModal(true)}
          >
            Пригласить бота
          </button>
        </div>
      </div>

      {showBotModal ? (
        <div className="modal-overlay" onClick={() => setShowBotModal(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Пригласить бота на встречу" onClick={(event) => event.stopPropagation()}>
            <h3>Пригласить бота на встречу</h3>
            <form
              className="modal-form"
              onSubmit={(event) => {
                onJoinMeeting(event);
                setShowBotModal(false);
                setActivePage('library');
              }}
            >
              <input
                autoFocus
                value={meetingBotDraft.meetingUrl}
                onChange={(event) => setMeetingBotDraft((current) => ({ ...current, meetingUrl: event.target.value }))}
                placeholder="Ссылка на встречу (Zoom, Meet, Телемост...)"
              />
              <input
                value={meetingBotDraft.title}
                onChange={(event) => setMeetingBotDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Название встречи (необязательно)"
              />
              <div className="modal-actions">
                <button className="button button-primary" type="submit" disabled={isJoiningMeeting}>
                  {isJoiningMeeting ? 'Отправляем...' : 'Пригласить'}
                </button>
                <button className="button button-secondary" type="button" onClick={() => setShowBotModal(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isConfiguring ? (
        <div className="home-config">
          {BLOCKS.map((block) => (
            <label key={block.key} className="settings-toggle">
              <input type="checkbox" checked={!isHidden(block.key)} onChange={() => onToggleBlock(block.key)} />
              {block.label}
            </label>
          ))}
        </div>
      ) : null}

      {!isHidden('processing') && processing.length ? (
        <section className="home-block" aria-label="Сейчас обрабатывается">
          <h3>Сейчас обрабатывается</h3>
          <div className="home-cards">
            {processing.map((recording) => (
              <button key={recording.id} type="button" className="home-card" onClick={() => onOpenRecording(recording.id)}>
                <strong>{recording.title}</strong>
                <span className={`status-pill status-${recording.status}`}>{getStatusLabel(recording.status)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {!isHidden('ready') ? (
        <section className="home-block" aria-label="Готовые протоколы">
          <h3>Готовые протоколы</h3>
          {ready.length ? (
            <div className="home-cards">
              {ready.map((recording) => (
                <button key={recording.id} type="button" className="home-card" onClick={() => onOpenRecording(recording.id)}>
                  <strong>{recording.title}</strong>
                  <span className="muted-text">{formatDate(recording.createdAt)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted-text">{isLoading ? 'Загружаем...' : 'Готовых протоколов пока нет.'}</p>
          )}
        </section>
      ) : null}

      {!isHidden('tasks') ? (
        <section className="home-block" aria-label="Задачи">
          <div className="home-block-head">
            <h3>Задачи</h3>
            <button className="home-see-all" type="button" onClick={() => setActivePage('tasksearch')}>
              Все задачи
            </button>
          </div>
          {openTasks.length ? (
            <div className="home-cards">
              {openTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={`home-card ${isOverdue(task) ? 'home-card-overdue' : ''}`}
                  onClick={() => onOpenRecording(task.recordingId)}
                >
                  <strong>{task.description}</strong>
                  <span className="muted-text">
                    {task.assignee || 'без исполнителя'}
                    {task.dueText ? ` · ${task.dueText}` : ''}
                  </span>
                  <span className="home-card-badges">
                    {isOverdue(task) ? <span className="overdue-pill">Просрочена</span> : null}
                    <span className="status-pill">{getTaskStatusLabel(task.status)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted-text">{tasks === null ? 'Загружаем...' : 'Открытых задач нет.'}</p>
          )}
        </section>
      ) : null}

      {!isHidden('upcoming') && upcoming.length ? (
        <section className="home-block" aria-label="Предстоящие встречи">
          <h3>Предстоящие встречи</h3>
          <div className="home-cards">
            {upcoming.map((meeting) => (
              <div key={meeting.eventId} className="home-card home-card-static">
                <strong>{meeting.title}</strong>
                <span className="muted-text">
                  {new Date(meeting.startsAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!isHidden('failed') && failed.length ? (
        <section className="home-block home-block-failed" aria-label="Ошибки">
          <h3>Ошибки</h3>
          <div className="home-cards">
            {failed.map((recording) => (
              <button key={recording.id} type="button" className="home-card home-card-overdue" onClick={() => onOpenRecording(recording.id)}>
                <strong>{recording.title}</strong>
                <span className="muted-text">Обработка не удалась — откройте, чтобы перезапустить</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
