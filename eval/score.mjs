#!/usr/bin/env node
/**
 * Харнесс приёмки качества извлечения задач (Gate §6.5 / NFR §5, ADR-031/032).
 *
 * Считает precision / recall / F1 предсказанных задач против эталонной разметки.
 * Цели (утверждены, ADR-031): precision ≥ 0.90, recall ≥ 0.85, F1 ≥ 0.87,
 * приоритет precision («хуже создать ложную задачу»).
 *
 * Запуск:
 *   node eval/score.mjs --gold <gold.json> --pred <pred.json> [--threshold 0.5] [--json]
 *
 * Формат обоих файлов (см. eval/README.md):
 *   { "meetings": [ { "id": "m1", "tasks": [ { "assignee": "...", "description": "...", "dueText": "..." } ] } ] }
 *
 * Сопоставление (правило приёмки — прозрачное и калибруемое; для спорных случаев
 * ADR-032 предусматривает 2 разметчиков + арбитра, здесь — детерминированный
 * базовый матчер, который арбитр может заменить/дополнить LLM-судьёй, см. README):
 *   - похожесть описаний = коэффициент Дайса по нормализованным токенам;
 *   - защита по исполнителю: если у ОБЕИХ задач указан исполнитель и они разные —
 *     пара не считается совпадением (задача на другого человека — не та же задача);
 *   - жадное уникальное сопоставление пар со скорингом ≥ threshold.
 */

import { readFileSync } from 'node:fs';

const TARGETS = { precision: 0.9, recall: 0.85, f1: 0.87 };
const RUSSIAN_STOPWORDS = new Set(['и', 'в', 'на', 'по', 'с', 'со', 'о', 'об', 'за', 'до', 'к', 'у', 'из', 'от', 'для', 'а', 'но']);

export function normalizeTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !RUSSIAN_STOPWORDS.has(t));
}

function normalizeAssignee(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Коэффициент Дайса по множествам токенов: 2|A∩B| / (|A|+|B|).
export function diceSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

// Скоринг пары gold↔pred. 0 = не совпадение (в т.ч. конфликт исполнителя).
export function pairScore(goldTask, predTask) {
  const ga = normalizeAssignee(goldTask.assignee);
  const pa = normalizeAssignee(predTask.assignee);
  if (ga && pa && ga !== pa) return 0; // защита по исполнителю
  return diceSimilarity(normalizeTokens(goldTask.description), normalizeTokens(predTask.description));
}

// Жадное уникальное сопоставление: все пары со скорингом ≥ threshold, по убыванию.
export function matchTasks(goldTasks, predTasks, threshold) {
  const pairs = [];
  goldTasks.forEach((g, gi) => {
    predTasks.forEach((p, pi) => {
      const s = pairScore(g, p);
      if (s >= threshold) pairs.push({ gi, pi, s });
    });
  });
  pairs.sort((x, y) => y.s - x.s);

  const usedGold = new Set();
  const usedPred = new Set();
  const matches = [];
  for (const { gi, pi, s } of pairs) {
    if (usedGold.has(gi) || usedPred.has(pi)) continue;
    usedGold.add(gi);
    usedPred.add(pi);
    matches.push({ gi, pi, s });
  }

  return {
    tp: matches.length,
    fp: predTasks.length - usedPred.size,
    fn: goldTasks.length - usedGold.size,
    matches,
    unmatchedGold: goldTasks.filter((_, i) => !usedGold.has(i)),
    unmatchedPred: predTasks.filter((_, i) => !usedPred.has(i)),
  };
}

function prf1(tp, fp, fn) {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision && recall && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : precision === null || recall === null ? null : 0;
  return { precision, recall, f1 };
}

export function scoreDataset(gold, pred, threshold = 0.5) {
  const predById = new Map((pred.meetings || []).map((m) => [m.id, m.tasks || []]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const perMeeting = [];

  for (const meeting of gold.meetings || []) {
    const goldTasks = meeting.tasks || [];
    const predTasks = predById.get(meeting.id) || [];
    const r = matchTasks(goldTasks, predTasks, threshold);
    tp += r.tp;
    fp += r.fp;
    fn += r.fn;
    perMeeting.push({
      id: meeting.id,
      goldCount: goldTasks.length,
      predCount: predTasks.length,
      ...r,
      metrics: prf1(r.tp, r.fp, r.fn),
    });
  }

  // Предсказания для встреч, которых нет в эталоне, — тоже ложные срабатывания.
  const goldIds = new Set((gold.meetings || []).map((m) => m.id));
  for (const meeting of pred.meetings || []) {
    if (!goldIds.has(meeting.id)) fp += (meeting.tasks || []).length;
  }

  const metrics = prf1(tp, fp, fn);
  return {
    threshold,
    totals: { tp, fp, fn, goldTasks: tp + fn, predTasks: tp + fp },
    metrics,
    targets: TARGETS,
    pass: {
      precision: metrics.precision != null && metrics.precision >= TARGETS.precision,
      recall: metrics.recall != null && metrics.recall >= TARGETS.recall,
      f1: metrics.f1 != null && metrics.f1 >= TARGETS.f1,
    },
    perMeeting,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--gold') args.gold = argv[++i];
    else if (a === '--pred') args.pred = argv[++i];
    else if (a === '--threshold') args.threshold = Number(argv[++i]);
    else if (a === '--json') args.json = true;
  }
  return args;
}

function fmt(x) {
  return x == null ? 'н/д' : x.toFixed(3);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.gold || !args.pred) {
    console.error('Использование: node eval/score.mjs --gold <gold.json> --pred <pred.json> [--threshold 0.5] [--json]');
    process.exit(2);
  }

  const gold = JSON.parse(readFileSync(args.gold, 'utf8'));
  const pred = JSON.parse(readFileSync(args.pred, 'utf8'));
  const result = scoreDataset(gold, pred, Number.isFinite(args.threshold) ? args.threshold : 0.5);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass.precision && result.pass.recall && result.pass.f1 ? 0 : 1);
  }

  const { totals: t, metrics: m, pass } = result;
  const mark = (ok) => (ok ? '✅' : '❌');
  console.log('Приёмка извлечения задач (порог сходства %s)', result.threshold);
  console.log('  Встреч: %d, эталонных задач: %d, предсказанных: %d', result.perMeeting.length, t.goldTasks, t.predTasks);
  console.log('  TP=%d  FP=%d  FN=%d', t.tp, t.fp, t.fn);
  console.log('  Precision: %s  (цель ≥ %s)  %s', fmt(m.precision), TARGETS.precision, mark(pass.precision));
  console.log('  Recall:    %s  (цель ≥ %s)  %s', fmt(m.recall), TARGETS.recall, mark(pass.recall));
  console.log('  F1:        %s  (цель ≥ %s)  %s', fmt(m.f1), TARGETS.f1, mark(pass.f1));
  console.log('  ИТОГ: %s', pass.precision && pass.recall && pass.f1 ? 'ПРИЁМКА ПРОЙДЕНА ✅' : 'НЕ ПРОЙДЕНА ❌');

  process.exit(pass.precision && pass.recall && pass.f1 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('score.mjs')) {
  main();
}
