import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { formatDate } from '../lib/format.js';
import { PROTOCOL_SECTION_LABELS } from '../lib/exporters.js';
import { getTaskStatusLabel } from '../lib/statusLabels.js';

function protocolSectionLines(sectionKey, items) {
  if (sectionKey === 'decisions') {
    return (items || []).map((item) => (item?.disputed ? `⚠ ${item.text}` : item?.text)).filter(Boolean);
  }

  return (items || []).map((item) => String(item || '')).filter(Boolean);
}

/**
 * Страница по ссылке на результат (US-11.1). Живёт до входа в приложение:
 * получатель ссылки — внешний человек без аккаунта. Роутера в проекте нет,
 * поэтому страница включается по параметру `?share=<token>`.
 */
export default function SharePage({ token }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch(`/api/share/${encodeURIComponent(token)}`);
        const data = await response.json().catch(() => ({}));

        if (cancelled) return;

        setState(
          response.ok
            ? { status: 'ok', payload: data }
            : { status: 'error', message: data.error || 'Ссылка недоступна' },
        );
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: 'Не удалось открыть ссылку — проверьте подключение' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === 'loading') {
    return (
      <main className="app-shell share-page">
        <p className="muted-text">Открываем...</p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="app-shell share-page">
        <p className="eyebrow">Stenogram</p>
        <h1>Ссылка недоступна</h1>
        <p className="muted-text">{state.message}</p>
      </main>
    );
  }

  const { recording, expiresAt } = state.payload;
  const protocol = recording.summary?.protocol;
  const sections = recording.protocolTemplate?.sections || [];

  return (
    <main className="app-shell share-page">
      <p className="eyebrow">Stenogram</p>
      <h1>{recording.title}</h1>
      <p className="muted-text">
        {formatDate(recording.createdAt)}
        {recording.projects?.length ? ` · ${recording.projects.map((project) => project.name).join(', ')}` : ''}
      </p>

      {recording.summary?.executiveSummary ? (
        <section className="share-section">
          <h2>Executive summary</h2>
          <p>{recording.summary.executiveSummary}</p>
        </section>
      ) : null}

      {recording.summary?.summary ? (
        <section className="share-section">
          <h2>Резюме</h2>
          <p>{recording.summary.summary}</p>
        </section>
      ) : null}

      {protocol ? (
        <section className="share-section">
          <h2>Протокол</h2>
          {sections.map((key) => {
            const lines = protocolSectionLines(key, protocol[key]);

            return (
              <div key={key} className="share-protocol-section">
                <h3>{PROTOCOL_SECTION_LABELS[key] || key}</h3>
                {lines.length ? (
                  <ul>
                    {lines.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted-text">Не выделено.</p>
                )}
              </div>
            );
          })}
        </section>
      ) : null}

      {recording.tasks ? (
        <section className="share-section">
          <h2>Задачи</h2>
          {recording.tasks.length ? (
            <ul className="share-task-list">
              {recording.tasks.map((task, index) => (
                <li key={index}>
                  <strong>{task.assignee || 'не указан'}</strong>
                  <span className="muted-text">
                    {' '}
                    · {task.dueText || 'срок не указан'} · {getTaskStatusLabel(task.status)}
                  </span>
                  <div>{task.description}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-text">Задач нет.</p>
          )}
        </section>
      ) : null}

      <p className="muted-text share-footer">Ссылка действует до {formatDate(expiresAt)}.</p>
    </main>
  );
}
