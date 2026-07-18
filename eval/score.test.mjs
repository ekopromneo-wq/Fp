#!/usr/bin/env node
/**
 * Self-test харнесса приёмки (eval/score.mjs). Без внешних зависимостей —
 * запуск: `node eval/score.test.mjs`. Проверяет математику метрик и правило
 * сопоставления на заранее посчитанных вручную примерах.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scoreDataset, matchTasks, pairScore, diceSimilarity } from './score.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function assert(label, cond, detail = '') {
  console.log(`  [${cond ? 'OK ' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed += 1;
}
const approx = (a, b) => a != null && Math.abs(a - b) < 1e-9;

// 1. Дайс: одинаковые множества = 1, непересекающиеся = 0, частичное.
assert('dice одинаковые = 1', diceSimilarity(['а', 'б'], ['б', 'а']) === 1);
assert('dice непересекающиеся = 0', diceSimilarity(['а'], ['б']) === 0);
assert('dice 3 из 4+4 = 0.75', approx(diceSimilarity(['а', 'б', 'в', 'г'], ['а', 'б', 'в', 'д']), 0.75));

// 2. Защита по исполнителю: одинаковое описание, разные исполнители → не совпадение.
assert(
  'разные исполнители → score 0',
  pairScore({ assignee: 'Иван', description: 'подготовить отчёт' }, { assignee: 'Пётр', description: 'подготовить отчёт' }) === 0,
);
assert(
  'исполнитель только у одного → сопоставляем по описанию',
  pairScore({ description: 'подготовить отчёт' }, { assignee: 'Пётр', description: 'подготовить отчёт' }) === 1,
);

// 3. Жадное сопоставление на маленьком наборе.
const r = matchTasks(
  [{ description: 'обновить прайс-лист поставщика' }],
  [{ description: 'обновить прайс-лист по поставщику' }, { description: 'забронировать переговорную' }],
  0.5,
);
assert('matchTasks: 1 TP', r.tp === 1, `tp=${r.tp}`);
assert('matchTasks: 1 FP (лишнее предсказание)', r.fp === 1, `fp=${r.fp}`);
assert('matchTasks: 0 FN', r.fn === 0, `fn=${r.fn}`);

// 4. Полный прогон фикстур: TP=3, FP=1, FN=1 → P=R=F1=0.75.
const gold = JSON.parse(readFileSync(path.join(dir, 'fixtures', 'gold.example.json'), 'utf8'));
const pred = JSON.parse(readFileSync(path.join(dir, 'fixtures', 'pred.example.json'), 'utf8'));
const res = scoreDataset(gold, pred, 0.5);
assert('фикстуры: TP=3', res.totals.tp === 3, `tp=${res.totals.tp}`);
assert('фикстуры: FP=1', res.totals.fp === 1, `fp=${res.totals.fp}`);
assert('фикстуры: FN=1', res.totals.fn === 1, `fn=${res.totals.fn}`);
assert('фикстуры: precision=0.75', approx(res.metrics.precision, 0.75), fmt(res.metrics.precision));
assert('фикстуры: recall=0.75', approx(res.metrics.recall, 0.75), fmt(res.metrics.recall));
assert('фикстуры: f1=0.75', approx(res.metrics.f1, 0.75), fmt(res.metrics.f1));
assert('фикстуры: приёмка НЕ пройдена (ниже целей)', res.pass.precision === false && res.pass.recall === false);

// 5. Предсказание для встречи вне эталона считается ложным срабатыванием.
const res2 = scoreDataset(
  { meetings: [{ id: 'x', tasks: [{ description: 'а б в' }] }] },
  { meetings: [{ id: 'x', tasks: [{ description: 'а б в' }] }, { id: 'нет-в-эталоне', tasks: [{ description: 'г д е' }] }] },
  0.5,
);
assert('встреча вне эталона → +FP', res2.totals.fp === 1, `fp=${res2.totals.fp}`);

function fmt(x) {
  return x == null ? 'н/д' : x.toFixed(3);
}

console.log(failed === 0 ? '\nВСЕ ТЕСТЫ ПРОШЛИ ✅' : `\nПРОВАЛОВ: ${failed} ❌`);
process.exit(failed === 0 ? 0 : 1);
