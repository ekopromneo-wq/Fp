import { formatDate } from '../../lib/format.js';

const STATUS_LABELS = {
  ok: 'В порядке',
  insufficient: 'Баланс исчерпан',
  invalid_key: 'Ключ отклонён',
  not_configured: 'Не настроен',
  error: 'Не удалось проверить',
};

function formatMoney(value, unit) {
  return unit === 'USD' ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${unit}`;
}

function BalanceCard({ balance }) {
  const { amount } = balance;
  // Остаток ниже десятой части пополненного — повод заметить заранее, а не
  // упереться в отказ посреди расшифровки.
  const isLow = amount && amount.total > 0 && amount.remaining / amount.total < 0.1;
  const tone = balance.status === 'ok' ? (isLow ? 'low' : 'ok') : balance.status === 'not_configured' ? 'muted' : 'bad';

  return (
    <li className={`balance-card balance-${tone}`}>
      <div className="balance-card-head">
        <strong>{balance.label}</strong>
        <span className={`balance-status balance-status-${tone}`}>{STATUS_LABELS[balance.status] || balance.status}</span>
      </div>

      {amount ? (
        <div className="balance-amount">
          <span className="balance-remaining">{formatMoney(amount.remaining, amount.unit)}</span>
          <span className="muted-text">
            осталось из {formatMoney(amount.total, amount.unit)} · потрачено {formatMoney(amount.used, amount.unit)}
          </span>
        </div>
      ) : null}

      {balance.message ? <p className="balance-message">{balance.message}</p> : null}
      <p className="muted-text balance-note">{balance.note}</p>

      <a className="balance-link" href={balance.dashboardUrl} target="_blank" rel="noreferrer">
        Личный кабинет →
      </a>
    </li>
  );
}

/**
 * Баланс облачных сервисов на странице настроек. Числом его отдаёт только
 * OpenRouter — у Shopot и Speech2Text метода баланса в API нет, поэтому там
 * показывается состояние («хватает / исчерпан / ключ отклонён») и ссылка в
 * личный кабинет за точной цифрой.
 */
export default function BalancesPanel({ balances, isLoading, onRefresh, checkedAt }) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <div>
          <p className="eyebrow">Баланс</p>
          <h2>Счета облачных сервисов</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? 'Проверяем...' : 'Проверить'}
        </button>
      </div>

      {balances?.length ? (
        <ul className="balance-list">
          {balances.map((balance) => (
            <BalanceCard key={balance.service} balance={balance} />
          ))}
        </ul>
      ) : (
        <p className="muted-text">{isLoading ? 'Опрашиваем сервисы...' : 'Нажмите «Проверить», чтобы узнать балансы.'}</p>
      )}

      <p className="settings-note">
        Точную цифру по API отдаёт только OpenRouter. Shopot и Speech2Text баланс не публикуют — для них видно лишь,
        принимает ли сервис ключ и хватает ли средств; сколько именно осталось, смотрите в личном кабинете.
        {checkedAt ? ` Проверено: ${formatDate(checkedAt)}.` : ''}
      </p>
    </section>
  );
}
