import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { formatDate } from '../lib/format.js';

// STG-003: «доступна предыдущая версия» — список снимков, сделанных перед
// каждой (пере)генерацией/восстановлением протокола (см. backend
// snapshotSummaryVersion). Само-содержащийся компонент по образцу
// BotConnectionLog.jsx — читает свою историю независимо, а восстановление
// делегирует родителю (он же обновляет summary/tasks в общем состоянии).
export default function SummaryVersionHistory({ recordingId, onRestore, setStatus }) {
  const [versions, setVersions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await apiFetch(`/api/recordings/${recordingId}/summary/versions`);

        if (!response.ok) {
          return;
        }

        const data = await response.json();

        if (!cancelled) {
          setVersions(data.versions || []);
          setLoaded(true);
        }
      } catch {
        // История версий — вспомогательная информация, её сбой не должен мешать протоколу.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordingId, refreshTick]);

  if (!loaded || versions.length === 0) {
    return null;
  }

  async function handleRestore(versionId) {
    if (!window.confirm('Восстановить эту версию протокола? Текущее состояние тоже сохранится в истории.')) {
      return;
    }

    setRestoringId(versionId);
    try {
      await onRestore(versionId);
      setRefreshTick((value) => value + 1);
    } catch (error) {
      setStatus?.(error.message || 'Не удалось восстановить версию');
    } finally {
      setRestoringId(null);
    }
  }

  function describeVersion(version) {
    if (version.instruction === 'restore') {
      return 'Восстановление предыдущей версии';
    }
    if (version.sectionsChanged?.length) {
      return `Раздел: ${version.sectionsChanged.join(', ')}`;
    }
    return version.instruction ? `Полная перегенерация — «${version.instruction}»` : 'Полная перегенерация';
  }

  return (
    <details className="summary-version-history">
      <summary>История изменений ({versions.length})</summary>
      <ul className="summary-version-list">
        {versions.map((version) => (
          <li key={version.id} className="summary-version-item">
            <span className="summary-version-time">{formatDate(version.createdAt)}</span>
            <span className="summary-version-label">{describeVersion(version)}</span>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => handleRestore(version.id)}
              disabled={restoringId !== null}
            >
              {restoringId === version.id ? 'Восстанавливаем...' : 'Восстановить'}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
