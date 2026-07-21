import { useState } from 'react';

function ContactRow({ contact, draft, isSaving, isDeleting, onDraftChange, onSave, onDelete }) {
  return (
    <div className="contact-row">
      <label>
        Имя
        <input value={draft.name} onChange={(event) => onDraftChange(contact, 'name', event.target.value)} placeholder="Имя контакта" />
      </label>
      <label>
        Организация
        <input
          value={draft.organization}
          onChange={(event) => onDraftChange(contact, 'organization', event.target.value)}
          placeholder="Компания"
        />
      </label>
      <label>
        Должность
        <input value={draft.position} onChange={(event) => onDraftChange(contact, 'position', event.target.value)} placeholder="Должность" />
      </label>
      <label>
        Email
        <input value={draft.email} onChange={(event) => onDraftChange(contact, 'email', event.target.value)} placeholder="name@example.com" />
      </label>
      <label>
        Телефон
        <input value={draft.phone} onChange={(event) => onDraftChange(contact, 'phone', event.target.value)} placeholder="+7..." />
      </label>
      <label>
        Telegram chat ID
        <input
          value={draft.telegramChatId}
          onChange={(event) => onDraftChange(contact, 'telegramChatId', event.target.value)}
          placeholder="Например: 123456789"
          title="Контакт должен запустить вашего бота; его chat id покажет, например, @userinfobot"
        />
      </label>
      <div className="contact-row-actions">
        <span className="contact-source-badge">{contact.source}</span>
        <button className="button button-secondary" type="button" onClick={() => onSave(contact)} disabled={isSaving}>
          {isSaving ? 'Сохраняем...' : 'Сохранить'}
        </button>
        <button className="button button-danger" type="button" onClick={() => onDelete(contact)} disabled={isDeleting}>
          {isDeleting ? 'Удаляем...' : 'Удалить'}
        </button>
      </div>
    </div>
  );
}

export default function ContactsPage({
  contacts,
  isLoadingContacts,
  contactDraft,
  setContactDraft,
  isCreatingContact,
  contactDuplicate,
  onCreateContact,
  onResolveContactDuplicate,
  onCancelContactDuplicate,
  getContactDraft,
  onContactDraftChange,
  savingContactId,
  deletingContactId,
  onSaveContact,
  onDeleteContact,
  isImportingContacts,
  contactImportSummary,
  onImportFile,
  onImportBitrix,
}) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <section className="contacts-page" aria-label="Контакты">
      <section className="contacts-panel">
        <button
          className="button button-primary add-toggle"
          type="button"
          onClick={() => setShowCreate((current) => !current)}
          aria-expanded={showCreate}
        >
          {showCreate ? 'Свернуть' : '＋ Новый контакт'}
        </button>

        {showCreate ? (
        <>
        <form className="contact-form" onSubmit={onCreateContact}>
          <label>
            Имя
            <input
              value={contactDraft.name}
              onChange={(event) => setContactDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Имя контакта"
              required
            />
          </label>
          <label>
            Организация
            <input
              value={contactDraft.organization}
              onChange={(event) => setContactDraft((current) => ({ ...current, organization: event.target.value }))}
              placeholder="Компания"
            />
          </label>
          <label>
            Должность
            <input
              value={contactDraft.position}
              onChange={(event) => setContactDraft((current) => ({ ...current, position: event.target.value }))}
              placeholder="Должность"
            />
          </label>
          <label>
            Email
            <input
              value={contactDraft.email}
              onChange={(event) => setContactDraft((current) => ({ ...current, email: event.target.value }))}
              placeholder="name@example.com"
            />
          </label>
          <label>
            Телефон
            <input
              value={contactDraft.phone}
              onChange={(event) => setContactDraft((current) => ({ ...current, phone: event.target.value }))}
              placeholder="+7..."
            />
          </label>
          <label>
            Telegram chat ID
            <input
              value={contactDraft.telegramChatId}
              onChange={(event) => setContactDraft((current) => ({ ...current, telegramChatId: event.target.value }))}
              placeholder="Например: 123456789"
              title="Контакт должен запустить вашего бота; его chat id покажет, например, @userinfobot"
            />
          </label>
          <button className="button button-primary" type="submit" disabled={isCreatingContact}>
            {isCreatingContact ? 'Сохраняем...' : 'Добавить контакт'}
          </button>
        </form>

        {contactDuplicate ? (
          <div className="contact-duplicate-hint">
            <p>
              Похоже, уже есть <strong>{contactDuplicate.name}</strong> — объединить с ним или создать отдельный контакт?
            </p>
            <div className="contact-duplicate-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => onResolveContactDuplicate(contactDuplicate.id)}
                disabled={isCreatingContact}
              >
                Объединить
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => onResolveContactDuplicate(null)}
                disabled={isCreatingContact}
              >
                Создать отдельно
              </button>
              <button className="button button-secondary" type="button" onClick={onCancelContactDuplicate} disabled={isCreatingContact}>
                Отмена
              </button>
            </div>
          </div>
        ) : null}
        </>
        ) : null}
      </section>

      <section className="contacts-panel">
        <h2>Импорт</h2>
        <div className="contact-import-actions">
          <label className="button button-secondary">
            Импорт из CSV
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              disabled={isImportingContacts}
              onChange={(event) => {
                const file = event.target.files?.[0];
                onImportFile(file, 'csv');
                event.target.value = '';
              }}
            />
          </label>
          <label className="button button-secondary">
            Импорт из vCard
            <input
              type="file"
              accept=".vcf,text/vcard"
              hidden
              disabled={isImportingContacts}
              onChange={(event) => {
                const file = event.target.files?.[0];
                onImportFile(file, 'vcard');
                event.target.value = '';
              }}
            />
          </label>
          <button className="button button-secondary" type="button" onClick={onImportBitrix} disabled={isImportingContacts}>
            Импортировать из Bitrix24
          </button>
        </div>

        {contactImportSummary ? (
          <div className="contact-import-summary">
            <p>
              Добавлено: {contactImportSummary.imported}
              {typeof contactImportSummary.skipped === 'number' ? `, пропущено: ${contactImportSummary.skipped}` : null}
              {typeof contactImportSummary.updated === 'number' ? `, обновлено: ${contactImportSummary.updated}` : null}
            </p>
            {contactImportSummary.ambiguous?.length ? (
              <div className="contact-import-ambiguous">
                <p>Требуют внимания (похожи на существующие контакты, но email не совпал):</p>
                <ul>
                  {contactImportSummary.ambiguous.map((item, index) => (
                    <li key={`${item.parsed.name}-${index}`}>
                      {item.parsed.name} — похож на {item.existing.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="contacts-panel contacts-list-panel">
        <h2>Контакты{isLoadingContacts ? ' (загрузка...)' : ` (${contacts.length})`}</h2>
        {contacts.length === 0 && !isLoadingContacts ? (
          <p className="muted-text">Контактов пока нет. Добавь вручную или импортируй CSV/vCard/Bitrix24.</p>
        ) : (
          <div className="contacts-list">
            {contacts.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                draft={getContactDraft(contact)}
                isSaving={savingContactId === contact.id}
                isDeleting={deletingContactId === contact.id}
                onDraftChange={onContactDraftChange}
                onSave={onSaveContact}
                onDelete={onDeleteContact}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
