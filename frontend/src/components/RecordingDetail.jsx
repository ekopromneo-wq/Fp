import { useEffect, useRef, useState } from 'react';
import JobsList from './JobsList.jsx';
import FeedbackWidget from './FeedbackWidget.jsx';
import SpeakerRow from './SpeakerRow.jsx';
import TaskForm from './TaskForm.jsx';
import TaskRow from './TaskRow.jsx';
import ProtocolView from './ProtocolView.jsx';
import SendPanel from './SendPanel.jsx';
import TranscriptView from './TranscriptView.jsx';
import TranscribingProgress from './TranscribingProgress.jsx';
import BotConnectionLog from './BotConnectionLog.jsx';
import StepCard from './StepCard.jsx';
import { getAudioUrl, isProcessingStatus } from '../lib/api.js';
import { MEETING_TYPE_OPTIONS, PROCESSING_TEMPLATE_OPTIONS } from '../lib/exporters.js';
import { formatDate, formatFileSize, pluralizeRu } from '../lib/format.js';
import { getStatusLabel } from '../lib/statusLabels.js';

/**
 * Правая панель детали записи. Фаза 1 пошагового экрана: вместо длинной «простыни»
 * — шаги-аккордеоны (Обработка → Стенограмма → Протокол → Задачи → Поделиться) с
 * авто-раскрытием текущего шага и единым CTA «Что дальше». Настройки записи спрятаны
 * за шестерёнку, служебное — в свёрнутый блок. `tasks`, `speakers`, `sending` — целые
 * результаты хуков, секции потребляют почти все их поля.
 */
function RecordingDetail({
  recording,
  onOpenSettings,
  canProcess,
  canExport,
  processingId,
  cancellingId,
  onProcess,
  onCancelProcessing,
  isStoppingMeetingBot,
  onStopMeetingBot,
  summaryLength,
  setSummaryLength,
  isSummarizing,
  onSummarize,
  onDeleteSummary,
  onCopyExport,
  onDownloadExport,
  onDownloadDocxExport,
  recordingDraft,
  setRecordingDraft,
  projectOptions,
  isGeneratingTitle,
  onGenerateTitle,
  isSavingRecording,
  onSaveRecordingMetadata,
  sending,
  sendConfig,
  onCopyShareLink,
  onUpdateProtection,
  onUpdateTranscript,
  onUpdateProtocol,
  onDictate,
  onAppendFragment,
  isAppendingFragment,
  setStatus,
  tasks,
  speakers,
  isJobsCollapsed,
  onToggleJobsCollapsed,
}) {
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Онбординг первого запуска — показываем один раз (флаг в localStorage).
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return !localStorage.getItem('stenogram-detail-onboarded');
    } catch {
      return false;
    }
  });
  function dismissOnboarding() {
    try {
      localStorage.setItem('stenogram-detail-onboarded', '1');
    } catch {
      // localStorage может быть недоступен (приватный режим) — не критично.
    }
    setShowOnboarding(false);
  }

  const hasTranscript = Boolean(recording.transcript);
  const hasSummary = Boolean(recording.summary);
  const hasTasks = Boolean(recording.tasks?.length);
  const processing = isProcessingStatus(recording.status);
  const speakerCount = recording.speakers?.length || 0;
  const taskCount = recording.tasks?.length || 0;
  // «Требует внимания» — что стоит доделать, показываем бейджем в свёрнутом шаге.
  const unnamedSpeakers = (recording.speakers || []).filter((speaker) => !speaker.displayName).length;
  const tasksNoAssignee = (recording.tasks || []).filter((task) => !task.assignee).length;
  const [shareSkipped, setShareSkipped] = useState(false);
  // #9: выбор шаблона для «Пересобрать по шаблону» — стартует с текущего шаблона
  // записи (или 'standard', если ещё не задан).
  const [rebuildTemplate, setRebuildTemplate] = useState(recording.processingTemplate || 'standard');

  // Текущий шаг — по достигнутому результату (маркер ● в списке шагов).
  const activeStep = hasSummary ? 3 : hasTranscript ? 2 : 1;

  // Аккордеон: при открытии записи ВСЕ шаги свёрнуты — пользователь видит компактный
  // маршрут целиком. Авто-раскрытие только когда прогресс случился на глазах
  // (обработка завершилась → открываем следующий шаг).
  const [openStep, setOpenStep] = useState(null);
  const prevStepRef = useRef(activeStep);
  useEffect(() => {
    setOpenStep(null);
    prevStepRef.current = activeStep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id]);
  useEffect(() => {
    if (prevStepRef.current !== activeStep) {
      prevStepRef.current = activeStep;
      setOpenStep(activeStep);
    }
  }, [activeStep]);
  const toggleStep = (n) => setOpenStep((current) => (current === n ? null : n));

  // Открыл «Поделиться» заново — снимаем отметку «пропущено».
  useEffect(() => {
    if (openStep === 5) {
      setShareSkipped(false);
    }
  }, [openStep]);

  function stepState(n) {
    const locked = ((n >= 2 && n <= 4) && !hasTranscript) || (n === 5 && !canExport);
    if (locked) return 'locked';
    if (n === activeStep) return 'current';
    const hasOutput =
      (n === 1 && hasTranscript) ||
      (n === 2 && hasTranscript) ||
      (n === 3 && hasSummary) ||
      (n === 4 && hasTasks);
    return hasOutput ? 'done' : 'available';
  }

  // US-1.5: дозапись фрагмента возможна только у серверной встречи (у неё уже
  // есть аудио) и когда она не в обработке — иначе воркер читает то же аудио.
  const canAppendFragment =
    Boolean(recording.id) && !String(recording.id).startsWith('local-') && !isProcessingStatus(recording.status);

  // Единый CTA «Что дальше» — одно понятное следующее действие по статусу.
  let cta = null;
  if (processing) {
    cta = { processing: true, hint: 'Идёт обработка — результат появится автоматически' };
  } else if (!hasTranscript && canProcess) {
    cta = {
      label: recording.status === 'failed' ? 'Перезапустить обработку' : 'Обработать запись',
      hint: 'Распознаем речь и определим спикеров',
      onClick: () => onProcess(recording),
    };
  } else if (hasTranscript && !hasSummary) {
    cta = {
      label: isSummarizing ? 'Готовим…' : 'Сделать протокол',
      hint: 'Соберём протокол и задачи по стенограмме',
      onClick: () => onSummarize(recording),
      disabled: isSummarizing,
    };
  }

  const summaryLengthToggle = (
    <div className="protocol-length">
      <span className="protocol-length-caption">Детализация протокола</span>
      <div className="summary-length-toggle" role="group" aria-label="Детализация протокола">
        {[
          { value: 'brief', label: 'Кратко' },
          { value: 'medium', label: 'Средне' },
          { value: 'long', label: 'Подробно' },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            className={`summary-length-option${summaryLength === option.value ? ' active' : ''}`}
            onClick={() => setSummaryLength(option.value)}
            disabled={isSummarizing}
            aria-pressed={summaryLength === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="detail-header">
        <div>
          <p className="eyebrow">Детали</p>
          <h2>{recording.title}</h2>
        </div>
        <div className="detail-header-status">
          <span className={`status-pill status-${recording.status}`}>{getStatusLabel(recording.status)}</span>
          <TranscribingProgress
            recordingId={recording.id}
            status={recording.status}
            durationSeconds={recording.durationSeconds}
          />
          <button
            className={`button button-secondary icon-button detail-settings-toggle${isSettingsOpen ? ' is-active' : ''}`}
            type="button"
            onClick={() => setIsSettingsOpen((current) => !current)}
            aria-expanded={isSettingsOpen}
            aria-label="Настройки записи"
            title="Настройки записи"
          >
            ⚙
          </button>
        </div>
      </div>

      {recording.status === 'failed' && recording.failureCount > 1 ? (
        <div className="critical-failure-banner" role="alert">
          <p>
            Похоже, с этой записью систематическая проблема — обработка не удалась уже несколько раз подряд, автоматический
            перезапуск не помогает.
            {recording.jobs?.[0]?.error ? ` Последняя ошибка: ${recording.jobs[0].error}` : ''} Если это
            повторится, обратитесь в поддержку — опишите название записи и текст ошибки выше.
          </p>
        </div>
      ) : null}

      {recording.source === 'meeting_bot' ? (
        <section className="detail-section meeting-bot-status">
          <h3>Бот на встрече</h3>
          <p className="muted-text">
            Ссылка:{' '}
            <a href={recording.meetingUrl} target="_blank" rel="noreferrer">
              {recording.meetingUrl}
            </a>
          </p>
          {recording.status === 'queued' || recording.status === 'processing' ? (
            <>
              <p className="muted-text">Бот подключается или уже записывает встречу. Транскрипт появится автоматически после её завершения.</p>
              <button
                className="button button-danger"
                type="button"
                onClick={() => onStopMeetingBot(recording)}
                disabled={isStoppingMeetingBot}
              >
                {isStoppingMeetingBot ? 'Останавливаем...' : 'Остановить бота'}
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {/* Настройки записи спрятаны за шестерёнку, чтобы не мешать основному потоку. */}
      {isSettingsOpen ? (
        <section className="recording-edit-panel" aria-label="Настройки записи">
          <label>
            Название
            <input
              value={recordingDraft.title}
              onChange={(event) => setRecordingDraft((current) => ({ ...current, title: event.target.value }))}
            />
          </label>

          <fieldset className="project-multi-select">
            <legend>Проекты</legend>
            {projectOptions.length === 0 ? <p className="muted-text">Проектов пока нет — создайте на странице «Проекты».</p> : null}
            {projectOptions
              .filter((project) => !project.isArchived || recordingDraft.projectIds.includes(project.id))
              .map((project) => (
                <label className="project-multi-option" key={project.id}>
                  <input
                    type="checkbox"
                    checked={recordingDraft.projectIds.includes(project.id)}
                    onChange={(event) =>
                      setRecordingDraft((current) => ({
                        ...current,
                        projectIds: event.target.checked
                          ? [...current.projectIds, project.id]
                          : current.projectIds.filter((id) => id !== project.id),
                      }))
                    }
                  />
                  <span className="project-chip" style={{ '--project-color': project.color }}>
                    {project.name}
                  </span>
                  {project.isArchived ? <span className="muted-text">(в архиве)</span> : null}
                </label>
              ))}
          </fieldset>

          <label>
            Тип встречи
            <select
              value={recordingDraft.meetingType}
              onChange={(event) => setRecordingDraft((current) => ({ ...current, meetingType: event.target.value }))}
            >
              {MEETING_TYPE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {/* US-2.3: известные имена/термины до обработки — подсказки для ASR. */}
          <label>
            Известные имена и термины
            <textarea
              rows={2}
              placeholder="Например: Иванов, ООО «Ромашка», API, CRM — через запятую"
              value={recordingDraft.asrHints || ''}
              onChange={(event) => setRecordingDraft((current) => ({ ...current, asrHints: event.target.value }))}
            />
            <span className="field-hint">Помогает точнее распознать имена, аббревиатуры и термины. Применяется при обработке.</span>
          </label>

          <div className="recording-protection-inline">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={Boolean(recording.confidential)}
                onChange={(event) => onUpdateProtection(recording, { confidential: event.target.checked })}
              />
              Конфиденциально
            </label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={Boolean(recording.downloadLocked)}
                onChange={(event) => onUpdateProtection(recording, { downloadLocked: event.target.checked })}
              />
              Запретить скачивание файлов
            </label>
          </div>

          <div className="recording-edit-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={onGenerateTitle}
              disabled={isGeneratingTitle || (!recording.transcript && !recording.summary)}
            >
              {isGeneratingTitle ? 'Думаем...' : 'AI-название'}
            </button>
            {recording.autoNamed ? <span className="auto-name-badge">AI</span> : null}
          </div>

          <button className="button button-secondary" type="button" onClick={onSaveRecordingMetadata} disabled={isSavingRecording}>
            {isSavingRecording ? 'Сохраняем...' : 'Сохранить запись'}
          </button>
        </section>
      ) : null}

      {/* Онбординг первого запуска — как читать пошаговый экран. */}
      {showOnboarding ? (
        <div className="detail-onboarding" role="note">
          <div className="detail-onboarding-body">
            <strong>Запись — по шагам</strong>
            <p>Идите сверху вниз: «Обработать» → стенограмма → протокол → задачи → отправка. Готовые шаги сворачиваются с ✓, ненужные — просто пропускайте. Настройки записи — под шестерёнкой.</p>
          </div>
          <button className="button button-secondary" type="button" onClick={dismissOnboarding}>
            Понятно
          </button>
        </div>
      ) : null}

      {/* «Что дальше» — единственное крупное следующее действие. */}
      {cta ? (
        <div className={`detail-next${cta.processing ? ' is-processing' : ''}`}>
          <span className="detail-next-eyebrow">Что дальше</span>
          {cta.label ? (
            <button className={`button button-primary detail-next-cta${cta.disabled ? ' is-busy' : ''}`} type="button" onClick={cta.onClick} disabled={cta.disabled}>
              {cta.label}
            </button>
          ) : null}
          <span className="detail-next-hint">
            {cta.processing ? <span className="busy-spinner" aria-hidden="true" /> : null}
            {cta.hint}
          </span>
        </div>
      ) : null}

      <div className="detail-stepper">
        {/* ① Обработка */}
        <StepCard
          n="1"
          title="Обработка"
          state={stepState(1)}
          summaryText={stepState(1) === 'done' ? 'стенограмма готова' : null}
          open={openStep === 1}
          onToggle={() => toggleStep(1)}
        >
          <div className="detail-action-group detail-primary-actions">
            <button
              className={`button button-primary${processingId === recording.id ? ' is-busy' : ''}`}
              type="button"
              onClick={() => onProcess(recording)}
              disabled={!canProcess || (hasTranscript && recording.status !== 'failed')}
              title={hasTranscript && recording.status !== 'failed' ? 'Запись уже обработана — используйте «Расшифровать заново»' : undefined}
            >
              {processingId === recording.id
                ? 'Запускаем...'
                : recording.status === 'failed'
                  ? 'Перезапустить обработку'
                  : hasTranscript
                    ? 'Обработка выполнена'
                    : 'Запустить обработку'}
            </button>
            {recording.transcript && !isProcessingStatus(recording.status) ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={() => onProcess(recording, { retranscribe: true })}
                disabled={!canProcess}
                title="Расшифровать заново текущим методом диаризации — стенограмма будет перезаписана"
              >
                Расшифровать заново
              </button>
            ) : null}
            {isProcessingStatus(recording.status) ? (
              <button
                className="button button-danger"
                type="button"
                onClick={() => onCancelProcessing(recording)}
                disabled={cancellingId === recording.id}
              >
                {cancellingId === recording.id ? 'Отменяем...' : 'Отменить'}
              </button>
            ) : null}
            {canAppendFragment ? (
              <label
                className={`button button-secondary${isAppendingFragment ? ' is-disabled' : ''}`}
                title="Добавить ещё один аудиофайл к этой встрече — он будет склеен, протокол пересоберётся"
              >
                {isAppendingFragment ? 'Добавляем...' : 'Добавить фрагмент'}
                <input
                  type="file"
                  accept="audio/*,video/*"
                  hidden
                  disabled={isAppendingFragment}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) {
                      onAppendFragment(recording, file);
                    }
                  }}
                />
              </label>
            ) : null}
          </div>
        </StepCard>

        {/* ② Стенограмма и спикеры */}
        <StepCard
          n="2"
          title="Стенограмма и спикеры"
          state={stepState(2)}
          summaryText={hasTranscript && speakerCount ? `${speakerCount} ${pluralizeRu(speakerCount, ['спикер', 'спикера', 'спикеров'])}` : null}
          warnText={hasTranscript && unnamedSpeakers ? `${unnamedSpeakers} ${pluralizeRu(unnamedSpeakers, ['спикер', 'спикера', 'спикеров'])} без имени` : null}
          open={openStep === 2}
          onToggle={() => toggleStep(2)}
          lockedHint="после обработки"
        >
          <TranscriptView
            recording={recording}
            audioUrl={getAudioUrl(recording)}
            onUpdateTranscript={onUpdateTranscript}
            setStatus={setStatus}
          />

          <div className="speaker-section-header">
            <h3>Спикеры</h3>
            {recording.speakers?.length ? (
              <div className="speaker-section-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={speakers.handleMatchSpeakersToBitrix}
                  disabled={speakers.isLoadingSpeakerMatches}
                >
                  {speakers.isLoadingSpeakerMatches ? 'Ищем...' : 'Подобрать по Битрикс24'}
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={speakers.handleMatchSpeakersToContacts}
                  disabled={speakers.isLoadingContactMatches}
                >
                  {speakers.isLoadingContactMatches ? 'Ищем...' : 'Подобрать по контактам'}
                </button>
              </div>
            ) : null}
          </div>
          {recording.speakers?.length ? (
            <div className="speaker-list">
              {recording.speakers.map((speaker) => (
                <SpeakerRow
                  key={speaker.label}
                  speaker={speaker}
                  draft={speakers.getSpeakerDraft(speaker)}
                  isSaving={speakers.savingSpeakerLabel === speaker.label}
                  isMerging={speakers.mergingSpeakerLabel === speaker.label}
                  match={speakers.speakerMatches[speaker.label]}
                  contactMatch={speakers.contactSpeakerMatches[speaker.label]}
                  otherSpeakers={recording.speakers.filter((item) => item.label !== speaker.label)}
                  isSpeakerSaved={Boolean(speaker.id) && !speakers.speakerDrafts[speaker.label]}
                  onDraftChange={speakers.updateSpeakerDraft}
                  onApplyCandidate={speakers.applySpeakerCandidate}
                  onSave={speakers.handleSaveSpeaker}
                  onAcceptSuggestion={() => speakers.handleSpeakerSuggestion(speaker, 'accepted')}
                  onRejectSuggestion={() => speakers.handleSpeakerSuggestion(speaker, 'rejected')}
                  onMerge={(targetLabel) => speakers.handleMergeSpeaker(speaker.label, targetLabel)}
                />
              ))}
            </div>
          ) : (
            <p className="muted-text">Спикеры появятся после стенограммы с сегментами ASR.</p>
          )}
        </StepCard>

        {/* ③ Протокол */}
        <StepCard
          n="3"
          title="Протокол"
          state={stepState(3)}
          summaryText={hasSummary ? 'готов' : null}
          open={openStep === 3}
          onToggle={() => toggleStep(3)}
          lockedHint="после стенограммы"
        >
          <div className="detail-action-group detail-protocol-group">
            {summaryLengthToggle}
            <button
              className={`button button-primary${isSummarizing ? ' is-busy' : ''}`}
              type="button"
              onClick={() => onSummarize(recording)}
              disabled={isSummarizing}
            >
              {isSummarizing ? 'Готовим...' : recording.summary ? 'Переделать протокол' : 'Сделать протокол'}
            </button>
          </div>

          {/* #9: пересобрать по другому шаблону обработки (краткий/+задачи/развёрнутый)
              простой нативной кнопкой, отдельно от toggle длины выше. */}
          <div className="detail-action-group detail-rebuild-group">
            <label className="detail-rebuild-select">
              Шаблон обработки
              <select value={rebuildTemplate} onChange={(event) => setRebuildTemplate(event.target.value)} disabled={isSummarizing}>
                {PROCESSING_TEMPLATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={`button button-secondary${isSummarizing ? ' is-busy' : ''}`}
              type="button"
              onClick={() => onSummarize(recording, { processingTemplate: rebuildTemplate })}
              disabled={isSummarizing}
              title="Пересобрать протокол и задачи по выбранному шаблону"
            >
              Пересобрать по шаблону
            </button>
            {hasSummary ? (
              <button
                className="button button-danger"
                type="button"
                onClick={() => {
                  if (window.confirm('Удалить протокол и задачи? Стенограмма останется.')) {
                    onDeleteSummary(recording);
                  }
                }}
                disabled={isSummarizing}
                title="Удалить протокол и задачи (стенограмма останется)"
              >
                Удалить протокол
              </button>
            ) : null}
          </div>

          <div className="protocol-print-area">
            <ProtocolView
              recording={recording}
              onUpdateProtocol={onUpdateProtocol}
              onGenerateProtocol={(options) => onSummarize(recording, options)}
              onDictate={onDictate}
              setStatus={setStatus}
            />
          </div>
        </StepCard>

        {/* ④ Задачи */}
        <StepCard
          n="4"
          title="Задачи"
          state={stepState(4)}
          summaryText={hasTasks ? `${taskCount} ${pluralizeRu(taskCount, ['задача', 'задачи', 'задач'])}` : null}
          warnText={hasTasks && tasksNoAssignee ? `${tasksNoAssignee} без исполнителя` : null}
          open={openStep === 4}
          onToggle={() => toggleStep(4)}
          lockedHint="после стенограммы"
        >
          <form className="task-row task-create-form" onSubmit={tasks.handleAddTask}>
            <div className="task-row-header">
              <strong>Новая задача</strong>
            </div>

            <TaskForm draft={tasks.newTaskDraft} onFieldChange={tasks.updateNewTaskDraft} onDictate={onDictate} setStatus={setStatus} />

            <button className="button button-primary" type="submit" disabled={tasks.isAddingTask}>
              {tasks.isAddingTask ? 'Добавляем...' : 'Добавить задачу'}
            </button>
          </form>

          {!recording.tasks?.length && recording.summary ? (
            <p className="muted-text tasks-empty-note">Задачи извлечь не удалось — добавьте вручную выше.</p>
          ) : null}

          {recording.tasks?.length ? (
            <>
              <div className="task-bulk-toolbar">
                <button className="button button-secondary" type="button" onClick={tasks.handleMatchTaskAssignees} disabled={tasks.isLoadingTaskAssigneeMatches}>
                  {tasks.isLoadingTaskAssigneeMatches ? 'Ищем...' : 'Подобрать исполнителей по контактам'}
                </button>
                <button className="button button-secondary" type="button" onClick={tasks.handleBulkConfirm} disabled={tasks.isBulkUpdatingTasks}>
                  {tasks.selectedTaskIds.size ? `Подтвердить выбранные (${tasks.selectedTaskIds.size})` : 'Подтвердить все'}
                </button>
                <div className="task-bulk-field">
                  <input
                    value={tasks.bulkAssigneeDraft}
                    onChange={(event) => tasks.setBulkAssigneeDraft(event.target.value)}
                    placeholder="Исполнитель для выбранных"
                    disabled={tasks.isBulkUpdatingTasks}
                  />
                  <button className="button button-secondary" type="button" onClick={tasks.handleBulkAssign} disabled={tasks.isBulkUpdatingTasks || !tasks.selectedTaskIds.size}>
                    Назначить
                  </button>
                </div>
                <div className="task-bulk-field">
                  <input
                    value={tasks.bulkDueTextDraft}
                    onChange={(event) => tasks.setBulkDueTextDraft(event.target.value)}
                    placeholder="Срок для выбранных"
                    disabled={tasks.isBulkUpdatingTasks}
                  />
                  <button className="button button-secondary" type="button" onClick={tasks.handleBulkDueText} disabled={tasks.isBulkUpdatingTasks || !tasks.selectedTaskIds.size}>
                    Изменить срок
                  </button>
                </div>
              </div>

              <div className="task-list">
                {recording.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    draft={tasks.getTaskDraft(task)}
                    isSaving={tasks.savingTaskId === task.id}
                    isDeleting={tasks.deletingTaskId === task.id}
                    isSendingBitrix={tasks.isSendingBitrixTaskId === task.id}
                    isSendingEmail={tasks.sendingTaskEmailId === task.id}
                    isSendingTelegram={tasks.sendingTaskTelegramId === task.id}
                    isSelected={tasks.selectedTaskIds.has(task.id)}
                    assigneeMatch={tasks.taskAssigneeMatches[task.id]}
                    onFieldChange={tasks.updateTaskDraft}
                    onSave={tasks.handleSaveTask}
                    onConfirm={tasks.handleConfirmTask}
                    onDismiss={tasks.handleDismissTask}
                    onDelete={tasks.handleDeleteTask}
                    onSendToBitrix={tasks.handleSendTaskToBitrix}
                    onToggleBitrixPanel={tasks.handleToggleBitrixPanel}
                    onBitrixDraftChange={tasks.updateBitrixDraft}
                    isBitrixPanelOpen={tasks.bitrixPanelTaskId === task.id}
                    bitrixDirectory={tasks.bitrixDirectory}
                    bitrixDraft={tasks.bitrixDrafts[task.id] || { responsibleId: '', groupId: '' }}
                    bitrixMatch={tasks.bitrixDirectory.matches?.[task.id]}
                    bitrixDuplicates={tasks.bitrixDuplicates?.taskId === task.id ? tasks.bitrixDuplicates : null}
                    onSendEmail={tasks.handleSendTaskEmail}
                    onSendTelegram={tasks.handleSendTaskTelegram}
                    onApplyAssigneeCandidate={tasks.applyTaskAssigneeCandidate}
                    onToggleSelect={tasks.toggleTaskSelection}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="muted-text">Задач пока нет. Они появятся после генерации протокола, если модель найдёт поручения.</p>
          )}
        </StepCard>

        {/* ⑤ Поделиться */}
        <StepCard
          n="5"
          title="Поделиться"
          state={stepState(5)}
          summaryText={shareSkipped ? 'пропущено' : null}
          open={openStep === 5}
          onToggle={() => toggleStep(5)}
          lockedHint="когда есть результат"
        >
          <div className="detail-export">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setIsExportOpen((value) => !value)}
              aria-expanded={isExportOpen}
            >
              Экспорт ▾
            </button>
            {isExportOpen ? (
              <div className="detail-export-menu" role="menu">
                <button type="button" onClick={() => { onCopyExport(recording); setIsExportOpen(false); }}>
                  Скопировать
                </button>
                {recording.downloadLocked ? (
                  <span className="muted-text detail-export-locked">Скачивание запрещено меткой записи</span>
                ) : (
                  <>
                    <button type="button" onClick={() => { onDownloadExport(recording); setIsExportOpen(false); }}>
                      Скачать .md
                    </button>
                    <button type="button" onClick={() => { onDownloadDocxExport(recording); setIsExportOpen(false); }}>
                      Скачать .docx
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <SendPanel sending={sending} sendConfig={sendConfig} canSend={canExport} onCopyShareLink={onCopyShareLink} onOpenSettings={onOpenSettings} />

          <div className="step-skip-row">
            <button
              className="link-button step-skip"
              type="button"
              onClick={() => {
                setShareSkipped(true);
                setOpenStep(null);
              }}
            >
              Пропустить этот шаг
            </button>
          </div>
        </StepCard>
      </div>

      {/* Служебное — свёрнуто, не мешает основному потоку. */}
      <details className="detail-extras">
        <summary>Служебное: файл, техжурнал, обратная связь</summary>

        <dl className="detail-grid">
          <div>
            <dt>Файл</dt>
            <dd>{recording.originalFilename || 'не прикреплен'}</dd>
          </div>
          <div>
            <dt>Размер</dt>
            <dd>{formatFileSize(recording.fileSizeBytes)}</dd>
          </div>
          <div>
            <dt>Источник</dt>
            <dd>{recording.source}</dd>
          </div>
          <div>
            <dt>Создана</dt>
            <dd>{formatDate(recording.createdAt)}</dd>
          </div>
        </dl>

        {!recording.storageKey ? (
          <section className="detail-section muted-section">
            <h3>Аудио</h3>
            <p>К этой записи пока не прикреплен файл.</p>
          </section>
        ) : null}

        {recording.source === 'meeting_bot' || recording.source === 'recorder_bot' ? (
          <BotConnectionLog recordingId={recording.id} status={recording.status} />
        ) : null}

        <FeedbackWidget recordingId={recording.id} setStatus={setStatus} />

        <JobsList jobs={recording.jobs} isCollapsed={isJobsCollapsed} onToggleCollapse={onToggleJobsCollapsed} />
      </details>
    </>
  );
}

export default RecordingDetail;
