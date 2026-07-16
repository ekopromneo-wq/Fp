import JobsList from './JobsList.jsx';
import FeedbackWidget from './FeedbackWidget.jsx';
import SpeakerRow from './SpeakerRow.jsx';
import TaskForm from './TaskForm.jsx';
import TaskRow from './TaskRow.jsx';
import ProtocolView from './ProtocolView.jsx';
import SendPanel from './SendPanel.jsx';
import TranscriptView from './TranscriptView.jsx';
import TranscribingProgress from './TranscribingProgress.jsx';
import { getAudioUrl, isProcessingStatus } from '../lib/api.js';
import { MEETING_TYPE_OPTIONS } from '../lib/exporters.js';
import { formatDate, formatFileSize } from '../lib/format.js';
import { getStatusLabel } from '../lib/statusLabels.js';

/**
 * The right-hand detail panel for one recording: status, actions, metadata
 * editing, sending (SendPanel), transcript, speakers, protocol, tasks and
 * job history. `tasks`, `speakers` and `sending` are the whole hook results
 * - the sections consume so much of each that itemizing every field as its
 * own prop would just restate the hook's return shape.
 */
function RecordingDetail({
  recording,
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
  setStatus,
  tasks,
  speakers,
  isJobsCollapsed,
  onToggleJobsCollapsed,
}) {
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

      <div className="detail-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={() => onProcess(recording)}
          disabled={!canProcess}
        >
          {processingId === recording.id
            ? 'Запускаем...'
            : recording.status === 'failed'
              ? 'Перезапустить обработку'
              : 'Запустить обработку'}
        </button>
        {/* Обычная обработка переиспользует готовую стенограмму (пересобирает
            только протокол). Чтобы применить другой метод диаризации или
            переделать неудачную расшифровку, нужен явный запуск с нуля. */}
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
        <div className="summary-length-toggle" role="group" aria-label="Длина резюме">
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
        <button
          className="button button-secondary"
          type="button"
          onClick={() => onSummarize(recording)}
          disabled={!recording.transcript || isSummarizing}
        >
          {isSummarizing ? 'Готовим...' : 'Сделать протокол'}
        </button>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => onCopyExport(recording)}
          disabled={!canExport}
        >
          Скопировать
        </button>
        {/* US-16.4: запрет скачивания прячет выгрузку файлов. */}
        {recording.downloadLocked ? (
          <span className="muted-text download-locked-note">Скачивание запрещено меткой записи</span>
        ) : (
          <>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => onDownloadExport(recording)}
              disabled={!canExport}
            >
              Скачать .md
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => onDownloadDocxExport(recording)}
              disabled={!canExport}
            >
              Скачать .docx
            </button>
          </>
        )}
      </div>

      {/* US-16.4: метка «конфиденциально» и запрет скачивания. */}
      <section className="detail-section recording-protection">
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
      </section>

      <section className="recording-edit-panel" aria-label="Редактирование записи">
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

      <SendPanel sending={sending} sendConfig={sendConfig} canSend={canExport} onCopyShareLink={onCopyShareLink} />

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

      <section className="detail-section detail-section-wide">
        <h3>Стенограмма</h3>
        <TranscriptView
          recording={recording}
          audioUrl={getAudioUrl(recording)}
          onUpdateTranscript={onUpdateTranscript}
          setStatus={setStatus}
        />
      </section>

      <section className="detail-section">
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
      </section>

      <section className="detail-section detail-section-wide protocol-print-area">
        <h3>Протокол</h3>
        <ProtocolView
          recording={recording}
          onUpdateProtocol={onUpdateProtocol}
          onGenerateProtocol={(options) => onSummarize(recording, options)}
          onDictate={onDictate}
          setStatus={setStatus}
        />
      </section>

      <section className="detail-section detail-section-wide">
        <h3>Задачи</h3>
        <form className="task-row task-create-form" onSubmit={tasks.handleAddTask}>
          <div className="task-row-header">
            <strong>Новая задача</strong>
          </div>

          <TaskForm draft={tasks.newTaskDraft} onFieldChange={tasks.updateNewTaskDraft} onDictate={onDictate} setStatus={setStatus} />

          <button className="button button-primary" type="submit" disabled={tasks.isAddingTask}>
            {tasks.isAddingTask ? 'Добавляем...' : 'Добавить задачу'}
          </button>
        </form>

        {/* US-17.1: протокол готов, но задач нет — «задачи извлечь не удалось». */}
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
      </section>

      <FeedbackWidget recordingId={recording.id} setStatus={setStatus} />

      <JobsList
        jobs={recording.jobs}
        isCollapsed={isJobsCollapsed}
        onToggleCollapse={onToggleJobsCollapsed}
      />
    </>
  );
}

export default RecordingDetail;
