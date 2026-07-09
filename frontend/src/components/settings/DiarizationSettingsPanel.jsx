export default function DiarizationSettingsPanel({ draft, setDraft, onSubmit, isSaving, isSettingsLoading, hasShopotKey, hasSpeech2textKey }) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Диаризация</p>
          <h2>Способ разметки по спикерам</h2>
        </div>
        {isSettingsLoading ? <span className="muted-text">Загружаем...</span> : null}
      </div>

      <form className="settings-form" onSubmit={onSubmit}>
        <label>
          Способ
          <select value={draft.method} onChange={(event) => setDraft((current) => ({ ...current, method: event.target.value }))}>
            <option value="shopot">Shopot (облачная диаризация)</option>
            <option value="gemini">Gemini через OpenRouter (аудио + определение имён)</option>
            <option value="speech2text">Speech2Text (облачная диаризация)</option>
            <option value="kimi">Kimi через OpenRouter (ASR + текстовая разметка по спикерам)</option>
            <option value="off">Выключено (только текстовая разметка по стенограмме)</option>
          </select>
        </label>

        {draft.method === 'shopot' ? (
          <label>
            Shopot API-ключ
            <input
              value={draft.shopotApiKey}
              onChange={(event) => setDraft((current) => ({ ...current, shopotApiKey: event.target.value }))}
              type="password"
              placeholder={hasShopotKey ? 'Ключ сохранен, оставь пустым чтобы не менять' : 'shpt_...'}
            />
          </label>
        ) : null}

        {draft.method === 'gemini' ? (
          <label>
            Модель Gemini (через OpenRouter)
            <input
              value={draft.geminiModel}
              onChange={(event) => setDraft((current) => ({ ...current, geminiModel: event.target.value }))}
              placeholder="google/gemini-2.5-pro"
            />
          </label>
        ) : null}

        {draft.method === 'speech2text' ? (
          <label>
            Speech2Text API-ключ
            <input
              value={draft.speech2textApiKey}
              onChange={(event) => setDraft((current) => ({ ...current, speech2textApiKey: event.target.value }))}
              type="password"
              placeholder={hasSpeech2textKey ? 'Ключ сохранен, оставь пустым чтобы не менять' : 'API-ключ speech2text.ru'}
            />
          </label>
        ) : null}

        {draft.method === 'kimi' ? (
          <label>
            Модель Kimi (через OpenRouter)
            <input
              value={draft.kimiModel}
              onChange={(event) => setDraft((current) => ({ ...current, kimiModel: event.target.value }))}
              placeholder="moonshotai/kimi-k2.6"
            />
          </label>
        ) : null}

        <button className="button button-primary" type="submit" disabled={isSaving || isSettingsLoading}>
          {isSaving ? 'Сохраняем...' : 'Сохранить диаризацию'}
        </button>
      </form>

      <p className="settings-note">
        Shopot — специализированный сервис диаризации (быстро, точные таймкоды). Gemini — распознаёт спикеров и по
        возможности определяет их имена прямо по аудио, используя общий ключ OpenRouter (без отдельной настройки).
        Speech2Text — ещё один облачный сервис диаризации (только метки «Спикер N», без определения имён). Kimi не
        умеет слушать аудио сам, поэтому сначала делает обычную ASR-расшифровку, а затем раскладывает готовый текст по
        спикерам с определением имён — без таймкодов реплик. «Выключено» — только LLM-разметка по тексту стенограммы.
      </p>
    </section>
  );
}
