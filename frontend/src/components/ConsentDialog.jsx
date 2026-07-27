import { apiFetch } from '../lib/api.js';
import useEscapeKey from '../hooks/useEscapeKey.js';

/**
 * US-16.3 (152-ФЗ): предупреждение о согласии участников перед КАЖДОЙ записью
 * с веткой отказа участника. Показывается только перед записью с микрофона
 * (App.jsx: единственный вызывающий — startRecordingWithConsent). Исходы:
 *   - «Все согласны»            → mode=consented, запись начинается
 *   - «Записать несмотря на отказ» → mode=override, запись начинается (после доп. подтверждения — STG-037)
 *   - «Отменить»                → decline, запись не начинается
 * STG-048/DECISION 8.5: пункт «Записать без отказавшегося участника» убран -
 * одним микрофоном голос конкретного человека физически не исключить, а этот
 * диалог используется только для локальной (mic) записи. Если/когда согласие
 * появится и на стороне бота-участника (отдельная запись через recorder-bot),
 * для той механики нужен свой текст, не этот.
 *
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
    // STG-037: раньше клик по «Записать несмотря на отказ» сразу запускал
    // запись — самое чувствительное решение в диалоге не имело даже одного
    // лишнего подтверждения, в отличие от остальных деструктивных действий
    // в приложении.
    if (mode === 'override' && !window.confirm('Вы точно хотите начать запись, несмотря на отказ участника?')) {
      return;
    }
    await logConsent({ mode, declined: false });
    onProceed(mode);
  }

  async function decline() {
    await logConsent({ mode: 'consented', declined: true });
    onCancel();
  }

  useEscapeKey(decline);

  return (
    <div className="consent-overlay" role="dialog" aria-modal="true" aria-labelledby="consent-title" onClick={decline}>
      <div className="consent-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={decline} aria-label="Закрыть">
          ✕
        </button>
        <h2 id="consent-title">Согласие на запись</h2>
        <p className="consent-notice">{NOTICE_TEXT}</p>

        <div className="consent-actions">
          <button className="button button-primary" type="button" onClick={() => proceed('consented')}>
            Все участники согласны — начать
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
