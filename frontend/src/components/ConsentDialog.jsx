import { apiFetch } from '../lib/api.js';

/**
 * US-16.3 (152-ФЗ): предупреждение о согласии участников перед КАЖДОЙ записью
 * с веткой отказа участника. Три исхода:
 *   - «Все согласны»            → mode=consented, запись начинается
 *   - «Записать без участника»  → mode=excluded,  запись начинается
 *   - «Записать несмотря на отказ» → mode=override, запись начинается
 *   - «Отменить»                → decline, запись не начинается
 * В любом исходе, кроме простого закрытия крестиком, шлём доказательство на
 * /api/consent/recording-start (снимок текста хранится на сервере).
 *
 * Текст предупреждения — заготовка (см. backend/consentTexts.js), требует
 * вычитки юристом. Здесь дублируется для показа; каноничный снимок берёт сервер.
 */
const NOTICE_TEXT =
  'Запись встречи затрагивает персональные данные участников (152-ФЗ). ' +
  'Убедитесь, что все участники предупреждены о записи и согласны на неё. ' +
  'Продолжая, вы подтверждаете, что уведомили участников о записи.';

async function logConsent({ mode, declined }) {
  try {
    await apiFetch('/api/consent/recording-start', {
      method: 'POST',
      body: JSON.stringify({ mode, declined: Boolean(declined) }),
    });
  } catch {
    // Доказательство лучше записать, но недоступность сети не должна блокировать
    // запись — офлайн-first. Согласие пользователь уже выразил действием.
  }
}

export default function ConsentDialog({ onProceed, onCancel }) {
  async function proceed(mode) {
    await logConsent({ mode, declined: false });
    onProceed(mode);
  }

  async function decline() {
    await logConsent({ mode: 'consented', declined: true });
    onCancel();
  }

  return (
    <div className="consent-overlay" role="dialog" aria-modal="true" aria-labelledby="consent-title" onClick={decline}>
      <div className="consent-dialog" onClick={(event) => event.stopPropagation()}>
        <h2 id="consent-title">Согласие на запись</h2>
        <p className="consent-notice">{NOTICE_TEXT}</p>

        <div className="consent-actions">
          <button className="button button-primary" type="button" onClick={() => proceed('consented')}>
            Все участники согласны — начать
          </button>
          <button className="button" type="button" onClick={() => proceed('excluded')}>
            Записать без отказавшегося участника
          </button>
          <button className="button" type="button" onClick={() => proceed('override')}>
            Записать несмотря на отказ
          </button>
          <button className="link-button" type="button" onClick={decline}>
            Отменить запись
          </button>
        </div>
      </div>
    </div>
  );
}
