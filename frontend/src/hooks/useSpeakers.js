import { useState } from 'react';
import { apiFetch } from '../lib/api.js';

/**
 * Owns the speakers section state for the currently open recording:
 * per-speaker edit drafts, Bitrix/contact matching, suggestion
 * accept/reject (epic 7) and merge. Mutations write back into the
 * recording via setSelectedRecording/setRecordings, exactly as the
 * pre-split App.jsx did.
 */
export default function useSpeakers({ selectedRecording, setSelectedRecording, setRecordings, setStatus }) {
  const [speakerDrafts, setSpeakerDrafts] = useState({});
  const [speakerMatches, setSpeakerMatches] = useState({});
  const [isLoadingSpeakerMatches, setIsLoadingSpeakerMatches] = useState(false);
  const [contactSpeakerMatches, setContactSpeakerMatches] = useState({});
  const [isLoadingContactMatches, setIsLoadingContactMatches] = useState(false);
  const [savingSpeakerLabel, setSavingSpeakerLabel] = useState(null);
  const [mergingSpeakerLabel, setMergingSpeakerLabel] = useState(null);

  function getSpeakerDraft(speaker) {
    return (
      speakerDrafts[speaker.label] || {
        displayName: speaker.displayName || '',
        contactName: speaker.contactName || '',
        contactEmail: speaker.contactEmail || '',
      }
    );
  }

  function updateSpeakerDraft(speaker, field, value) {
    setSpeakerDrafts((current) => ({
      ...current,
      [speaker.label]: {
        ...getSpeakerDraft(speaker),
        [field]: value,
      },
    }));
  }

  function applySpeakerUpdate(speaker) {
    setSelectedRecording((current) => {
      if (!current?.speakers) {
        return current;
      }

      const speakers = current.speakers.map((item) => (item.label === speaker.label ? speaker : item));

      return { ...current, speakers };
    });
  }

  function applySpeakerCandidate(speaker, candidate) {
    setSpeakerDrafts((current) => ({
      ...current,
      [speaker.label]: {
        ...getSpeakerDraft(speaker),
        contactName: candidate.name,
        contactEmail: candidate.email,
      },
    }));
  }

  async function handleMatchSpeakersToBitrix() {
    if (!selectedRecording) {
      return;
    }

    setIsLoadingSpeakerMatches(true);
    setStatus('Ищем совпадения спикеров в Битрикс24...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/bitrix-speaker-matches`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сопоставить спикеров с Битрикс24');
      }

      const matchesByLabel = Object.fromEntries((data.matches || []).map((match) => [match.label, match]));
      setSpeakerMatches(matchesByLabel);

      for (const speaker of selectedRecording.speakers || []) {
        const match = matchesByLabel[speaker.label];
        const draft = getSpeakerDraft(speaker);

        if (match?.autoMatch && !draft.contactEmail) {
          applySpeakerCandidate(speaker, match.autoMatch);
        }
      }

      setStatus('Спикеры сопоставлены с Битрикс24');
    } catch (error) {
      setStatus(error.message || 'Ошибка сопоставления спикеров с Битрикс24');
    } finally {
      setIsLoadingSpeakerMatches(false);
    }
  }

  async function handleMatchSpeakersToContacts() {
    if (!selectedRecording) {
      return;
    }

    setIsLoadingContactMatches(true);
    setStatus('Ищем совпадения спикеров в контактах...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/contact-speaker-matches`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сопоставить спикеров с контактами');
      }

      const matchesByLabel = Object.fromEntries((data.matches || []).map((match) => [match.label, match]));
      setContactSpeakerMatches(matchesByLabel);

      for (const speaker of selectedRecording.speakers || []) {
        const match = matchesByLabel[speaker.label];
        const draft = getSpeakerDraft(speaker);

        if (match?.autoMatch && !draft.contactEmail) {
          applySpeakerCandidate(speaker, match.autoMatch);
        }
      }

      setStatus('Спикеры сопоставлены с контактами');
    } catch (error) {
      setStatus(error.message || 'Ошибка сопоставления спикеров с контактами');
    } finally {
      setIsLoadingContactMatches(false);
    }
  }

  async function handleSaveSpeaker(speaker) {
    if (!selectedRecording) {
      return;
    }

    const draft = getSpeakerDraft(speaker);

    if (!draft.displayName.trim()) {
      setStatus('Заполни имя спикера');
      return;
    }

    setSavingSpeakerLabel(speaker.label);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/speakers/${encodeURIComponent(speaker.label)}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить спикера');
      }

      applySpeakerUpdate(data.speaker);
      setSpeakerDrafts((current) => {
        const next = { ...current };
        delete next[speaker.label];
        return next;
      });
      setStatus('Спикер сохранён');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения спикера');
    } finally {
      setSavingSpeakerLabel(null);
    }
  }

  async function handleSpeakerSuggestion(speaker, suggestionStatus) {
    if (!selectedRecording) {
      return;
    }

    setSavingSpeakerLabel(speaker.label);

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/speakers/${encodeURIComponent(speaker.label)}`, {
        method: 'PATCH',
        body: JSON.stringify({ suggestionStatus }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось обновить спикера');
      }

      applySpeakerUpdate(data.speaker);
      setStatus(suggestionStatus === 'accepted' ? 'Имя принято' : 'Предложение отклонено');
    } catch (error) {
      setStatus(error.message || 'Ошибка обновления спикера');
    } finally {
      setSavingSpeakerLabel(null);
    }
  }

  async function handleMergeSpeaker(sourceLabel, targetLabel) {
    if (!selectedRecording || !sourceLabel || !targetLabel) {
      return;
    }

    setMergingSpeakerLabel(sourceLabel);
    setStatus('Объединяем спикеров...');

    try {
      const response = await apiFetch(`/api/recordings/${selectedRecording.id}/speakers/merge`, {
        method: 'POST',
        body: JSON.stringify({ sourceLabel, targetLabel }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось объединить спикеров');
      }

      setSelectedRecording(data.recording);
      setRecordings((current) => current.map((item) => (item.id === data.recording.id ? data.recording : item)));
      setStatus('Спикеры объединены');
    } catch (error) {
      setStatus(error.message || 'Ошибка объединения спикеров');
    } finally {
      setMergingSpeakerLabel(null);
    }
  }

  return {
    speakerDrafts,
    speakerMatches,
    contactSpeakerMatches,
    isLoadingSpeakerMatches,
    isLoadingContactMatches,
    savingSpeakerLabel,
    mergingSpeakerLabel,
    getSpeakerDraft,
    updateSpeakerDraft,
    applySpeakerCandidate,
    handleMatchSpeakersToBitrix,
    handleMatchSpeakersToContacts,
    handleSaveSpeaker,
    handleSpeakerSuggestion,
    handleMergeSpeaker,
  };
}
