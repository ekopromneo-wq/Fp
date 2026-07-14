import { useState } from 'react';
import { apiFetch } from '../lib/api.js';

/**
 * Owns the contacts page state: the list, the create form (with its
 * interactive duplicate-resolution flow), per-contact edit drafts, and the
 * CSV/vCard/Bitrix imports. Extracted verbatim from App.jsx.
 */
export default function useContacts(setStatus) {
  const [contacts, setContacts] = useState([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [contactDraft, setContactDraft] = useState({ name: '', organization: '', position: '', email: '', phone: '' });
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  const [contactDuplicate, setContactDuplicate] = useState(null);
  const [contactEditDrafts, setContactEditDrafts] = useState({});
  const [savingContactId, setSavingContactId] = useState(null);
  const [deletingContactId, setDeletingContactId] = useState(null);
  const [isImportingContacts, setIsImportingContacts] = useState(false);
  const [contactImportSummary, setContactImportSummary] = useState(null);

  async function loadContacts() {
    setIsLoadingContacts(true);

    try {
      const response = await apiFetch('/api/contacts');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось загрузить контакты');
      }

      setContacts(data.contacts || []);
    } catch (error) {
      setStatus(error.message || 'Ошибка загрузки контактов');
    } finally {
      setIsLoadingContacts(false);
    }
  }

  async function submitContact(input) {
    const response = await apiFetch('/api/contacts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Не удалось сохранить контакт');
    }

    return data;
  }

  async function handleCreateContact(event) {
    event.preventDefault();

    if (!contactDraft.name.trim()) {
      setStatus('Заполни имя контакта');
      return;
    }

    setIsCreatingContact(true);
    setStatus('Сохраняем контакт...');

    try {
      const data = await submitContact(contactDraft);

      if (data.duplicate) {
        setContactDuplicate(data.duplicate);
        setStatus(`Похоже, уже есть ${data.duplicate.name} — объединить?`);
        return;
      }

      setContacts((current) => [...current, data.contact].sort((a, b) => a.name.localeCompare(b.name)));
      setContactDraft({ name: '', organization: '', position: '', email: '', phone: '' });
      setContactDuplicate(null);
      setStatus('Контакт добавлен');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения контакта');
    } finally {
      setIsCreatingContact(false);
    }
  }

  function handleCancelContactDuplicate() {
    setContactDuplicate(null);
    setStatus('');
  }

  async function handleResolveContactDuplicate(mergeIntoId) {
    setIsCreatingContact(true);
    setStatus(mergeIntoId ? 'Объединяем контакт...' : 'Создаём отдельный контакт...');

    try {
      const data = await submitContact({
        ...contactDraft,
        mergeIntoId: mergeIntoId || undefined,
        confirmDuplicate: mergeIntoId ? undefined : true,
      });

      if (mergeIntoId) {
        setContacts((current) => current.map((item) => (item.id === data.contact.id ? data.contact : item)));
      } else {
        setContacts((current) => [...current, data.contact].sort((a, b) => a.name.localeCompare(b.name)));
      }

      setContactDraft({ name: '', organization: '', position: '', email: '', phone: '' });
      setContactDuplicate(null);
      setStatus(mergeIntoId ? 'Контакт объединён' : 'Контакт добавлен');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения контакта');
    } finally {
      setIsCreatingContact(false);
    }
  }

  function getContactDraft(contact) {
    return (
      contactEditDrafts[contact.id] || {
        name: contact.name || '',
        organization: contact.organization || '',
        position: contact.position || '',
        email: contact.email || '',
        phone: contact.phone || '',
      }
    );
  }

  function handleContactDraftChange(contact, field, value) {
    setContactEditDrafts((current) => ({
      ...current,
      [contact.id]: { ...getContactDraft(contact), [field]: value },
    }));
  }

  async function handleSaveContact(contact) {
    const draft = getContactDraft(contact);

    if (!draft.name.trim()) {
      setStatus('Заполни имя контакта');
      return;
    }

    setSavingContactId(contact.id);

    try {
      const response = await apiFetch(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось сохранить контакт');
      }

      setContacts((current) => current.map((item) => (item.id === contact.id ? data.contact : item)).sort((a, b) => a.name.localeCompare(b.name)));
      setContactEditDrafts((current) => {
        const next = { ...current };
        delete next[contact.id];
        return next;
      });
      setStatus('Контакт сохранён');
    } catch (error) {
      setStatus(error.message || 'Ошибка сохранения контакта');
    } finally {
      setSavingContactId(null);
    }
  }

  async function handleDeleteContact(contact) {
    const confirmed = window.confirm(`Удалить контакт "${contact.name}"?`);

    if (!confirmed) {
      return;
    }

    setDeletingContactId(contact.id);

    try {
      const response = await apiFetch(`/api/contacts/${contact.id}`, { method: 'DELETE' });

      if (!response.ok) {
        throw new Error('Не удалось удалить контакт');
      }

      setContacts((current) => current.filter((item) => item.id !== contact.id));
      setStatus(`Контакт "${contact.name}" удалён`);
    } catch (error) {
      setStatus(error.message || 'Ошибка удаления контакта');
    } finally {
      setDeletingContactId(null);
    }
  }

  async function handleImportContactsFile(file, kind) {
    if (!file) {
      return;
    }

    setIsImportingContacts(true);
    setContactImportSummary(null);
    setStatus(kind === 'csv' ? 'Импортируем CSV...' : 'Импортируем vCard...');

    try {
      const text = await file.text();
      const response = await apiFetch(`/api/contacts/import/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось выполнить импорт');
      }

      setContactImportSummary({ source: kind, ...data });
      setStatus(`Импорт завершён: добавлено ${data.imported}, пропущено ${data.skipped}, требует внимания ${data.ambiguous?.length || 0}`);
      await loadContacts();
    } catch (error) {
      setStatus(error.message || 'Ошибка импорта контактов');
    } finally {
      setIsImportingContacts(false);
    }
  }

  async function handleImportContactsFromBitrix() {
    setIsImportingContacts(true);
    setContactImportSummary(null);
    setStatus('Импортируем из Битрикс24...');

    try {
      const response = await apiFetch('/api/contacts/import/bitrix', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось выполнить импорт из Битрикс24');
      }

      setContactImportSummary({ source: 'bitrix', ...data });
      setStatus(`Импорт из Битрикс24 завершён: добавлено ${data.imported}, обновлено ${data.updated}`);
      await loadContacts();
    } catch (error) {
      setStatus(error.message || 'Ошибка импорта из Битрикс24');
    } finally {
      setIsImportingContacts(false);
    }
  }

  return {
    contacts,
    isLoadingContacts,
    contactDraft,
    setContactDraft,
    isCreatingContact,
    contactDuplicate,
    savingContactId,
    deletingContactId,
    isImportingContacts,
    contactImportSummary,
    loadContacts,
    handleCreateContact,
    handleCancelContactDuplicate,
    handleResolveContactDuplicate,
    getContactDraft,
    handleContactDraftChange,
    handleSaveContact,
    handleDeleteContact,
    handleImportContactsFile,
    handleImportContactsFromBitrix,
  };
}
