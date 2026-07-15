import { useState } from 'react';
import { apiFetch } from '../lib/api.js';

const EMPTY_FILTERS = { search: '', status: '', projectId: '', dueFrom: '', dueTo: '' };

/**
 * Состояние страницы поиска задач (US-10.2): фильтры, результаты с бэкенда
 * (GET /api/tasks/search — текст/исполнитель + статус, проект, диапазон
 * сроков) и флаг «поиск уже выполнялся» для честного «ничего не найдено».
 */
export default function useTaskSearch(setStatus) {
  const [taskFilters, setTaskFilters] = useState(EMPTY_FILTERS);
  const [taskResults, setTaskResults] = useState([]);
  const [isSearchingTasks, setIsSearchingTasks] = useState(false);
  const [hasSearchedTasks, setHasSearchedTasks] = useState(false);

  async function searchTasks(nextFilters = taskFilters) {
    setIsSearchingTasks(true);

    try {
      const params = new URLSearchParams();

      Object.entries(nextFilters).forEach(([key, value]) => {
        if (value && String(value).trim()) {
          params.set(key, String(value).trim());
        }
      });

      const response = await apiFetch(`/api/tasks/search${params.toString() ? `?${params.toString()}` : ''}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Не удалось выполнить поиск задач');
      }

      setTaskResults(data.tasks || []);
      setHasSearchedTasks(true);
      setStatus('');
    } catch (error) {
      setStatus(error.message || 'Ошибка поиска задач');
    } finally {
      setIsSearchingTasks(false);
    }
  }

  function resetTaskSearch() {
    setTaskFilters(EMPTY_FILTERS);
    setTaskResults([]);
    setHasSearchedTasks(false);
  }

  return {
    taskFilters,
    setTaskFilters,
    taskResults,
    isSearchingTasks,
    hasSearchedTasks,
    searchTasks,
    resetTaskSearch,
  };
}
