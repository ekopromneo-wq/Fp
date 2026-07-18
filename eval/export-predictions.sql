-- Выгрузка предсказаний системы в формат харнесса приёмки (eval/pred.json).
-- Берёт задачи (recording_tasks) по каждой готовой записи и группирует их по
-- встрече = записи (id записи используется как id встречи; тот же id должен быть
-- в gold.json). Даёт ровно форму { "meetings": [ { id, title, tasks:[...] } ] }.
--
-- Запуск (read-only, на сервере):
--   ssh root@<host> "docker exec -i voxmate-server-db-1 \
--     psql -U postgres -d voxmate -tA -f -" < eval/export-predictions.sql > pred.json
--
-- Ограничить набором датасета: заменить `where r.status = 'done'` на
--   `where r.id = any('{<id1>,<id2>,...}'::uuid[])`.

with meetings as (
  select
    r.id,
    r.title,
    coalesce((
      select json_agg(
        json_build_object(
          'assignee', rt.assignee,
          'description', rt.description,
          'dueText', rt.due_text
        )
        order by rt.created_at
      )
      from recording_tasks rt
      where rt.recording_id = r.id and rt.status <> 'dismissed'
    ), '[]'::json) as tasks
  from recordings r
  where r.status = 'done'
  order by r.created_at
)
select json_build_object(
  'meetings',
  coalesce(json_agg(json_build_object('id', id, 'title', title, 'tasks', tasks)), '[]'::json)
)
from meetings;
