import { formatDate } from '../lib/format.js';

const PAYLOAD_LABELS = {
  protocol: 'Протокол целиком',
  summary: 'Краткое резюме',
  tasks: 'Только задачи',
};

const CHANNEL_LABELS = {
  email: 'Email',
  telegram: 'Telegram',
};

function DeliveryRow({ delivery }) {
  const recipients = delivery.recipients?.length ? delivery.recipients.join(', ') : '—';

  return (
    <li className={`delivery-row delivery-${delivery.status}`}>
      <div className="delivery-row-head">
        <strong>{CHANNEL_LABELS[delivery.channel] || delivery.channel}</strong>
        <span className={`delivery-status delivery-status-${delivery.status}`}>
          {delivery.status === 'sent' ? 'доставлено' : 'ошибка'}
        </span>
        <span className="delivery-date">{formatDate(delivery.createdAt)}</span>
      </div>
      <span className="muted-text">
        {PAYLOAD_LABELS[delivery.payloadKind] || delivery.payloadKind} · {recipients}
        {delivery.attempts > 1 ? ` · попыток: ${delivery.attempts}` : ''}
      </span>
      {delivery.lastError ? <span className="delivery-error">{delivery.lastError}</span> : null}
    </li>
  );
}

function ShareLinkRow({ link, onRevoke, onCopy }) {
  return (
    <li className={`share-link-row ${link.isActive ? '' : 'is-inactive'}`}>
      <div className="share-link-head">
        <strong>{PAYLOAD_LABELS[link.payloadKind] || link.payloadKind}</strong>
        <span className="muted-text">
          {link.revokedAt
            ? `отозвана ${formatDate(link.revokedAt)}`
            : link.isActive
              ? `действует до ${formatDate(link.expiresAt)}`
              : `истекла ${formatDate(link.expiresAt)}`}
        </span>
      </div>

      {link.isActive ? (
        <div className="share-link-actions">
          <input value={link.url} readOnly onFocus={(event) => event.target.select()} />
          <button className="button button-secondary" type="button" onClick={() => onCopy(link.url)}>
            Скопировать
          </button>
          <button className="button button-danger" type="button" onClick={() => onRevoke(link.id)}>
            Отозвать
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Единая отправка результатов встречи (US-11.1/11.2): канал, что именно шлём,
 * получатели, предпросмотр, журнал доставки и ссылки на результат.
 */
export default function SendPanel({
  sending,
  sendConfig,
  canSend,
  onCopyShareLink,
}) {
  const { draft, setDraft, deliveries, shareLinks, suggestions, preview, loadPreview, isSending, failure, send, createShareLink, revokeShareLink } =
    sending;
  const isEmail = draft.channel === 'email';

  async function handleSubmit(event) {
    event.preventDefault();

    // Предпросмотр по настройке (US-11.1): пока пользователь не увидел, что
    // именно уйдёт, отправку не выполняем — сначала показываем текст.
    if (sendConfig?.preview && !preview) {
      await loadPreview();
      return;
    }

    await send();
  }

  return (
    <section className="detail-section detail-section-wide send-panel">
      <h3>Отправить</h3>

      <form className="send-form" onSubmit={handleSubmit}>
        <div className="send-form-row">
          <label>
            Канал
            <select
              value={draft.channel}
              onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value }))}
            >
              <option value="email">Email</option>
              <option value="telegram">Telegram</option>
            </select>
          </label>

          <label>
            Что отправляем
            <select
              value={draft.payloadKind}
              onChange={(event) => setDraft((current) => ({ ...current, payloadKind: event.target.value }))}
            >
              {Object.entries(PAYLOAD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isEmail ? (
          <>
            <label>
              Получатели
              <input
                value={draft.recipients}
                onChange={(event) => setDraft((current) => ({ ...current, recipients: event.target.value }))}
                placeholder="name@example.com, team@example.com"
                list="recipient-suggestions"
              />
            </label>

            {/* US-11.1: получателей предлагаем по истории отправок. */}
            <datalist id="recipient-suggestions">
              {suggestions.map((item) => (
                <option key={item.recipient} value={item.recipient} />
              ))}
            </datalist>

            {suggestions.length ? (
              <div className="recipient-suggestions">
                <span className="muted-text">Недавние:</span>
                {suggestions.slice(0, 5).map((item) => (
                  <button
                    key={item.recipient}
                    type="button"
                    className="recipient-suggestion"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        recipients: current.recipients
                          .split(/[,\n;]/)
                          .map((part) => part.trim())
                          .filter(Boolean)
                          .concat(item.recipient)
                          .filter((value, index, all) => all.indexOf(value) === index)
                          .join(', '),
                      }))
                    }
                  >
                    {item.recipient}
                  </button>
                ))}
              </div>
            ) : null}

            <label>
              Копия (CC)
              <input
                value={draft.cc}
                onChange={(event) => setDraft((current) => ({ ...current, cc: event.target.value }))}
                placeholder="необязательно"
              />
            </label>

            <label className="send-checkbox">
              <input
                type="checkbox"
                checked={draft.attachDocx}
                onChange={(event) => setDraft((current) => ({ ...current, attachDocx: event.target.checked }))}
              />
              Приложить Word-файл
            </label>
          </>
        ) : (
          <label>
            Chat ID
            <input
              value={draft.chatId}
              onChange={(event) => setDraft((current) => ({ ...current, chatId: event.target.value }))}
              placeholder="По умолчанию из настроек"
            />
          </label>
        )}

        <label>
          Комментарий
          <textarea
            value={draft.message}
            onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
            rows={2}
            placeholder="Короткое сопроводительное сообщение"
          />
        </label>

        {preview ? (
          <div className="send-preview">
            <strong>Предпросмотр — {preview.subject}</strong>
            <pre>{preview.text}</pre>
            <span className="muted-text">Проверьте текст и нажмите «Отправить» ещё раз.</span>
          </div>
        ) : null}

        {failure ? (
          <div className="send-failure" role="alert">
            <strong>{failure.error}</strong>
            {failure.attempts > 1 ? <span className="muted-text">Попыток: {failure.attempts}</span> : null}
            {failure.suggestAlternativeChannel && failure.alternativeChannels?.length ? (
              <div className="send-failure-actions">
                <span>Попробовать другой канал:</span>
                {failure.alternativeChannels.map((item) => (
                  <button
                    key={item.channel}
                    type="button"
                    className="button button-secondary"
                    onClick={() => setDraft((current) => ({ ...current, channel: item.channel }))}
                  >
                    {CHANNEL_LABELS[item.channel] || item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <button className="button button-primary" type="submit" disabled={!canSend || isSending}>
          {isSending ? 'Отправляем...' : sendConfig?.preview && !preview ? 'Предпросмотр' : 'Отправить'}
        </button>
      </form>

      <div className="share-links">
        <h4>Ссылка на результат</h4>
        <p className="muted-text">Открывается без пароля, действует неделю, доступ можно отозвать.</p>

        <div className="share-links-create">
          <button className="button button-secondary" type="button" onClick={() => createShareLink(draft.payloadKind)} disabled={!canSend}>
            Создать ссылку: {PAYLOAD_LABELS[draft.payloadKind]}
          </button>
        </div>

        {shareLinks.length ? (
          <ul className="share-link-list">
            {shareLinks.map((link) => (
              <ShareLinkRow key={link.id} link={link} onRevoke={revokeShareLink} onCopy={onCopyShareLink} />
            ))}
          </ul>
        ) : (
          <p className="muted-text">Ссылок пока нет.</p>
        )}
      </div>

      <div className="delivery-journal">
        <h4>Журнал доставки</h4>
        {deliveries.length ? (
          <ul className="delivery-list">
            {deliveries.map((delivery) => (
              <DeliveryRow key={delivery.id} delivery={delivery} />
            ))}
          </ul>
        ) : (
          <p className="muted-text">Отправок пока не было.</p>
        )}
      </div>
    </section>
  );
}
