function LibraryControls({
  searchQuery,
  setSearchQuery,
  projectFilter,
  setProjectFilter,
  projectOptions,
  newProjectDraft,
  setNewProjectDraft,
  isCreatingProject,
  onCreateProject,
  meetingBotDraft,
  setMeetingBotDraft,
  isJoiningMeeting,
  onJoinMeeting,
}) {
  return (
    <section className="library-controls" aria-label="Фильтры библиотеки">
      <label>
        Поиск
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Название, файл, проект или текст стенограммы"
        />
      </label>

      <label>
        Проект
        <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
          <option value="">Все проекты</option>
          {projectOptions.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <form className="project-create-form" onSubmit={onCreateProject}>
        <input
          value={newProjectDraft.name}
          onChange={(event) => setNewProjectDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder="Новый проект"
        />
        <input
          className="project-color-input"
          value={newProjectDraft.color}
          onChange={(event) => setNewProjectDraft((current) => ({ ...current, color: event.target.value }))}
          type="color"
          aria-label="Цвет проекта"
        />
        <button className="button button-secondary" type="submit" disabled={isCreatingProject}>
          {isCreatingProject ? 'Создаём...' : 'Создать'}
        </button>
      </form>

      <form className="meeting-bot-form" onSubmit={onJoinMeeting}>
        <input
          value={meetingBotDraft.meetingUrl}
          onChange={(event) => setMeetingBotDraft((current) => ({ ...current, meetingUrl: event.target.value }))}
          placeholder="Ссылка на встречу (Zoom, Meet, Телемост...)"
        />
        <input
          value={meetingBotDraft.title}
          onChange={(event) => setMeetingBotDraft((current) => ({ ...current, title: event.target.value }))}
          placeholder="Название встречи (необязательно)"
        />
        <button className="button button-secondary" type="submit" disabled={isJoiningMeeting}>
          {isJoiningMeeting ? 'Отправляем...' : 'Пригласить бота'}
        </button>
      </form>
    </section>
  );
}

export default LibraryControls;
