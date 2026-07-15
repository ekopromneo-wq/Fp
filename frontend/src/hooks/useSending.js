import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';

const EMPTY_DRAFT = {
  channel: 'email',
  payloadKind: 'protocol',
  recipients: '',
  chatId: '',
  cc: '',
  bcc: '',
  message: '',
  attachDocx: true,
};

/**
 * Отправка протокола/резюме/задач (эпик 11): черновик, журнал доставки,
 * подсказки получателей и ссылки на результат для одной выбранной записи.
 */
export default function useSending({ recordingId, sendConfig, setStatus, defaultRecipients = '' }) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [deliveries, setDeliveries] = useState([]);
  const [shareLinks, setShareLinks] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [preview, setPreview] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [failure, setFailure] = useState(null);

  // Настройки отправки — это дефолты черновика, а не жёсткие значения: канал и
  // вложение пользователь может поменять для конкретной отправки.
  useEffect(() => {
    setDraft((current) => ({
      ...current,
      channel: sendConfig?.defaultChannel || current.channel,
      attachDocx: sendConfig?.attachDocx ?? current.attachDocx,
    }));
  }, [sendConfig?.defaultChannel, sendConfig?.attachDocx]);

  const loadDeliveries = useCallback(async () => {
    if (!recordingId) return;

    try {
      const response = await apiFetch(`/api/recordings/${recordingId}/deliveries`);
      const data = await response.json();

      if (response.ok) {
        setDeliveries(data.deliveries || []);
      }
    } catch {
      // Журнал — справочная информация: молчим, чтобы не перебивать статус
      // основного действия.
    }
  }, [recordingId]);

  const loadShareLinks = useCallback(async () => {
    if (!recordingId) return;

    try {
      const response = await apiFetch(`/api/recordings/${recordingId}/share-links`);
      const data = await response.json();

      if (response.ok) {
        setShareLinks(data.shareLinks || []);
      }
    } catch {
      // см. loadDeliveries
    }
  }, [recordingId]);

  const loadSuggestions = useCallback(async (channel) => {
    try {
      const response = await apiFetch(`/api/recipient-suggestions?channel=${channel}`);
      const data = await response.json();

      if (response.ok) {
        setSuggestions(data.suggestions || []);
      }
    } catch {
      // подсказки необязательны
    }
  }, []);

  // Смена записи начинает отправку с чистого листа: получатели — почты спикеров
  // этой встречи, черновик прошлой записи не переносится.
  useEffect(() => {
    setDraft((current) => ({ ...current, recipients: defaultRecipients, cc: '', bcc: '', message: '' }));
    setPreview(null);
    setFailure(null);
    loadDeliveries();
    loadShareLinks();
  }, [recordingId, defaultRecipients, loadDeliveries, loadShareLinks]);

  // Ждём выбранную запись: хук живёт в App с самого старта, а до входа запрос
  // подсказок вернёт 401 и больше не повторится.
  useEffect(() => {
    if (!recordingId) {
      return;
    }

    loadSuggestions(draft.channel);
  }, [recordingId, draft.channel, loadSuggestions]);

  async function loadPreview() {
    if (!recordingId) return;

    const params = new URLSearchParams({ payloadKind: draft.payloadKind, message: draft.message });
    const response = await apiFetch(`/api/recordings/${recordingId}/send-preview?${params}`);
    const data = await response.json();

    if (response.ok) {
      setPreview(data.preview);
    } else {
      setStatus?.(data.error || 'Не удалось собрать предпросмотр');
    }
  }

  async function send() {
    if (!recordingId) return false;

    setIsSending(true);
    setFailure(null);
    setStatus?.('Отправляем...');

    try {
      const response = await apiFetch(`/api/recordings/${recordingId}/send`, {
        method: 'POST',
        body: JSON.stringify({
          channel: draft.channel,
          payloadKind: draft.payloadKind,
          message: draft.message,
          ...(draft.channel === 'email'
            ? { recipients: draft.recipients, cc: draft.cc, bcc: draft.bcc, attachDocx: draft.attachDocx }
            : { chatId: draft.chatId }),
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setFailure({
          error: data.error,
          attempts: data.attempts,
          suggestAlternativeChannel: data.suggestAlternativeChannel,
          alternativeChannels: data.alternativeChannels || [],
        });
        setStatus?.(data.error || 'Не удалось отправить');
        return false;
      }

      setStatus?.('Отправлено');
      setPreview(null);
      setDraft((current) => ({ ...current, message: '' }));
      return true;
    } catch (error) {
      setFailure({ error: error.message });
      setStatus?.(error.message || 'Ошибка отправки');
      return false;
    } finally {
      setIsSending(false);
      loadDeliveries();
      loadSuggestions(draft.channel);
    }
  }

  async function createShareLink(payloadKind) {
    const response = await apiFetch(`/api/recordings/${recordingId}/share-links`, {
      method: 'POST',
      body: JSON.stringify({ payloadKind }),
    });
    const data = await response.json();

    if (!response.ok) {
      setStatus?.(data.error || 'Не удалось создать ссылку');
      return null;
    }

    setStatus?.('Ссылка создана — действует неделю');
    loadShareLinks();
    return data.shareLink;
  }

  async function revokeShareLink(id) {
    const response = await apiFetch(`/api/share-links/${id}`, { method: 'DELETE' });
    const data = await response.json();

    if (!response.ok) {
      setStatus?.(data.error || 'Не удалось отозвать ссылку');
      return;
    }

    setStatus?.('Доступ по ссылке отозван');
    loadShareLinks();
  }

  return {
    draft,
    setDraft,
    deliveries,
    shareLinks,
    suggestions,
    preview,
    setPreview,
    loadPreview,
    isSending,
    failure,
    setFailure,
    send,
    createShareLink,
    revokeShareLink,
  };
}
