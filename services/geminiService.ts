import {
  RevisionSheetData,
  GenerationSettings,
  Section,
  SavedLesson,
  QuizQuestion,
  QuizOption,
  QuizQuestionType,
  QuizCategory,
  QuizClassifiableItem,
  QuizSequenceItem
} from '../types';
import { chunkText, normalizeText, trimForContext } from '../utils/textUtils';

const CHUNK_SIZE = 1800;
const MAX_FINAL_PROMPT_CHARS = 7500;
const ENHANCEMENT_MAX_DOC_LENGTH = 12000;
const ENHANCEMENT_MAX_SUMMARY_LENGTH = 5000;
const MAX_CHUNK_ITEMS = 6;
const MAX_CHUNK_ITEM_LENGTH = 160;
const MODEL_READY_TIMEOUT_MS = 120000;
const MODEL_READY_POLL_DELAY_MS = 1000;
const LOAD_RETRY_DELAY_MS = 2000;
const defaultBaseUrl = 'http://localhost:1234/v1';

const MAX_QUIZ_PROMPT_CHARS = 6200;
const MAX_QUIZ_SECTIONS_PER_LESSON = 4;
const MAX_QUIZ_SECTION_SUMMARY_LENGTH = 200;

const readyModels = new Set<string>();

type ProgressUpdater = (step: string, percentage: number) => void;
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type JsonLike = Record<string, any> | any[];

const languageLabels: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ar: 'Arabic'
};

const allowedQuizTypes: QuizQuestionType[] = [
  'single_choice',
  'multi_select',
  'true_false',
  'fill_blank',
  'categorize',
  'sequence',
  'intruder'
];

const getLanguageName = (code?: string) => languageLabels[code ?? ''] ?? code ?? 'English';

const summarizeSectionContent = (content: string, limit = 360): string => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
};

const pickKeyword = (text: string): string | null => {
  const words = text
    .replace(/[\r\n]+/g, ' ')
    .split(/\s+/)
    .map(word => word.replace(/[^a-zA-ZÀ-ÿ0-9'-]/g, ''))
    .filter(Boolean);
  const sorted = words
    .filter(word => word.length >= 6)
    .sort((a, b) => b.length - a.length);
  return sorted[0] ?? words.find(word => word.length >= 4) ?? null;
};

const stripFences = (text: string): string => text
  .replace(/^```json\s*/i, '')
  .replace(/^```\s*/i, '')
  .replace(/\s*```\s*$/i, '')
  .trim();

const sanitizeJsonString = (s: string): string => {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      if (ch === '"') { inStr = true; out += ch; }
      else { out += ch; }
      continue;
    }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { out += ch; inStr = false; continue; }
    const code = ch.charCodeAt(0);
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    if (code >= 0 && code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += ch;
  }
  return out;
};

const extractAndParseJson = (raw: string): JsonLike => {
  let txt = stripFences(raw);
  try {
    return JSON.parse(txt);
  } catch (_) {
    const start = txt.indexOf('{');
    const end = txt.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      txt = txt.slice(start, end + 1);
    }
    const sanitized = sanitizeJsonString(txt);
    return JSON.parse(sanitized);
  }
};

const coerceString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const callChatCompletion = async (
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  temperature = 0.3,
  jsonObjectResponse = false
): Promise<string> => {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const body: any = {
    messages,
    temperature,
    stream: false
  };

  if (model) {
    body.model = model;
  }

  if (jsonObjectResponse) {
    body.response_format = { type: 'json_object' };
  }

  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : { Authorization: 'Bearer lm-studio' })
    },
    body: JSON.stringify(body)
  });

  if (!res.ok && res.status === 400 && !apiKey) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/context length/i.test(text) || /context\s+.*\soverflow/i.test(text)) {
      throw new Error('The request exceeded the selected model context window. Try a shorter document, enable compact mode, or pick a model with a larger context length.');
    }
    let parsedMessage = '';
    let errorCode = '';
    try {
      const payload = JSON.parse(text);
      parsedMessage = payload?.error?.message ?? '';
      errorCode = payload?.error?.code ?? '';
    } catch {}
    if (
      res.status === 404 &&
      (/model[_-]?not[_-]?found/i.test(errorCode) || /Model does not exist/i.test(parsedMessage))
    ) {
      const modelError = new Error(`Model "${model}" is not available on the LM Studio server. Load it in LM Studio or choose a different model in Settings.`);
      (modelError as any).code = 'model_not_found';
      throw modelError;
    }
    throw new Error(`LM Studio request failed: ${res.status} ${res.statusText}. URL: ${url}. Model: ${model}. ${text}`);
  }
  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from model');
  return content as string;
};

const isContextWindowError = (err: unknown): boolean => {
  if (!err) return false;
  const message =
    typeof err === 'string'
      ? err
      : typeof err === 'object' && err !== null && 'message' in err
        ? (err as { message?: string }).message
        : undefined;
  return typeof message === 'string' && /context window|context length|context limit/i.test(message);
};

const shouldRetryQuizRequest = (err: unknown): boolean => {
  if (!err) return false;
  const message =
    typeof err === 'string'
      ? err
      : typeof err === 'object' && err !== null && 'message' in err
        ? (err as { message?: string }).message
        : undefined;
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes('context window') ||
    normalized.includes('context length') ||
    normalized.includes('context limit') ||
    normalized.includes('too large') ||
    /lm studio request failed:\s*(400|413)/i.test(message) ||
    normalized.includes('bad request')
  );
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const normalizeModelId = (id: unknown): string =>
  typeof id === 'string' ? id.trim().toLowerCase() : '';

const expandModelIdVariants = (id: string): string[] => {
  const normalized = normalizeModelId(id);
  if (!normalized) return [];
  const variants = new Set<string>();
  const push = (value: string) => {
    const normalizedValue = normalizeModelId(value);
    if (normalizedValue) variants.add(normalizedValue);
  };

  const appendVariants = (value: string) => {
    if (!value) return;
    push(value);
    push(value.split(':')[0]);
    push(value.split('@')[0]);
  };

  appendVariants(normalized);
  const segments = normalized.split('/');
  const lastSegment = segments[segments.length - 1] ?? '';
  appendVariants(lastSegment);

  return Array.from(variants);
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const deriveRestBaseUrl = (baseUrl: string): string => {
  try {
    const parsed = new URL(baseUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    const hasVersionSuffix = /\/v\d+$/i.test(path);
    const trimmedPath = hasVersionSuffix ? path.replace(/\/v\d+$/i, '') : path;
    parsed.pathname = `${trimmedPath}/api/v1`.replace(/\/{2,}/g, '/');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return `${baseUrl.replace(/\/v\d*$/i, '')}/api/v1`.replace(/\/{2,}/g, '/');
  }
};

const triggerModelLoad = async (
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string
) => {
  const restBase = deriveRestBaseUrl(baseUrl);
  const baseWithoutVersion = trimTrailingSlash(baseUrl);
  const candidateEndpoints = [
    `${restBase}/models/load`,
    `${baseWithoutVersion}/models/load`
  ].filter((value, index, self) => self.indexOf(value) === index);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : { Authorization: 'Bearer lm-studio' })
  };

  let lastError: Error | null = null;

  for (const endpoint of candidateEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId })
      });

      if (res.ok || res.status === 202 || res.status === 409) {
        return;
      }

      const text = await res.text().catch(() => '');
      if (res.status === 404) {
        if (/not\s+found/i.test(text)) {
          const error = new Error(`Model "${modelId}" is not downloaded on this LM Studio server. Download it (e.g. via LM Studio or lms get) and try again.`);
          (error as any).code = 'model_not_found';
          throw error;
        }
        continue;
      }

      let parsedMessage = '';
      try {
        const payload = JSON.parse(text);
        parsedMessage = payload?.error?.message ?? payload?.message ?? '';
      } catch {}

      if (/not\s+found/i.test(parsedMessage)) {
        const error = new Error(`Model "${modelId}" is not downloaded on this LM Studio server. Download it (e.g. via LM Studio or lms get) and try again.`);
        (error as any).code = 'model_not_found';
        throw error;
      }

      lastError = new Error(`Failed to trigger model load (${res.status} ${res.statusText} ${text})`);
    } catch (err) {
      if ((err as any)?.code === 'model_not_found') {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastError) {
    throw lastError;
  }
};

type ModelInventoryResult = {
  entries: any[];
  hadSuccessfulRequest: boolean;
};

const fetchModelInventory = async (
  baseUrl: string,
  apiKey: string | undefined
): Promise<ModelInventoryResult> => {
  const restBase = deriveRestBaseUrl(baseUrl);
  const baseWithoutVersion = trimTrailingSlash(baseUrl);
  const candidateEndpoints = [
    `${restBase}/models`,
    `${baseWithoutVersion}/models`
  ].filter((value, index, self) => self.indexOf(value) === index);

  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : { Authorization: 'Bearer lm-studio' };

  const aggregated: any[] = [];
  let hadSuccessfulRequest = false;
  let lastError: Error | null = null;

  for (const endpoint of candidateEndpoints) {
    try {
      const res = await fetch(endpoint, { method: 'GET', headers });
      if (res.status === 404 || res.status === 405 || res.status === 503) {
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastError = new Error(`Failed to verify loaded models (${res.status} ${res.statusText} ${text})`);
        continue;
      }

      hadSuccessfulRequest = true;
      const body = await res.json().catch(() => null);
      const entries = gatherModelEntries(body);
      if (entries.length) {
        aggregated.push(...entries);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!hadSuccessfulRequest && lastError) {
    throw lastError;
  }

  return { entries: aggregated, hadSuccessfulRequest };
};

const normalizeStatusValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isTruthyFlag = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = normalizeStatusValue(value);
    return normalized === 'true' || normalized === '1' || normalized === 'loaded' || normalized === 'ready';
  }
  return false;
};

const extractStatusStrings = (value: unknown): string[] => {
  if (!value) return [];
  if (typeof value === 'string') return [normalizeStatusValue(value)];
  if (typeof value === 'object') {
    const entries: unknown[] = Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>);
    return entries.flatMap(item => extractStatusStrings(item));
  }
  return [];
};

const collectIdentifierStrings = (value: unknown, depth = 0): string[] => {
  if (!value || depth > 2) return [];
  if (typeof value === 'string') {
    const normalized = normalizeModelId(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectIdentifierStrings(item, depth + 1));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const relevantKeys = keys.filter(key => /id|name|path|repo|model/i.test(key));
    const direct = relevantKeys.flatMap(key => collectIdentifierStrings(obj[key], depth + 1));
    if (direct.length) {
      return direct;
    }
    if (depth === 0) {
      return Object.values(obj).flatMap(item => collectIdentifierStrings(item, depth + 1));
    }
  }
  return [];
};

const matchesModelIdentifier = (entry: any, target: string): boolean => {
  const targetVariants = expandModelIdVariants(target);
  if (!targetVariants.length) return false;

  const identifierValues = collectIdentifierStrings(entry);
  if (!identifierValues.length) return false;

  const identifierVariants = identifierValues.flatMap(value => expandModelIdVariants(value));
  if (!identifierVariants.length) return false;

  return identifierVariants.some(identifier =>
    targetVariants.some(targetVariant =>
      identifier === targetVariant ||
      identifier.endsWith(`/${targetVariant}`) ||
      targetVariant.endsWith(`/${identifier}`)
    )
  );
};

const gatherModelEntries = (payload: any): any[] => {
  if (!payload) return [];
  const results: any[] = [];
  const visited = new WeakSet<object>();

  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item));
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (visited.has(obj)) return;
      visited.add(obj);
      const keys = Object.keys(obj);
      const resemblesModelEntry = keys.some(key => /id|model|name|path|repo/i.test(key));
      if (resemblesModelEntry) {
        results.push(obj);
      }
      Object.values(obj).forEach(item => visit(item));
    }
  };

  visit(payload);
  return results;
};

const isModelEntryReady = (entry: any): boolean => {
  if (!entry) return false;
  if (isTruthyFlag(entry.loaded) || isTruthyFlag(entry.isLoaded) || isTruthyFlag(entry.ready)) {
    return true;
  }
  const inference = entry.inference ?? entry.runtime ?? entry.engine;
  if (isTruthyFlag(inference?.loaded) || isTruthyFlag(inference?.ready)) {
    return true;
  }
  const statusCandidates = [entry.status, entry.state, entry.phase, entry.stage, inference?.status];
  const statuses = statusCandidates.flatMap(candidate => extractStatusStrings(candidate));
  const readyTokens = ['loaded', 'ready', 'active', 'ok', 'success', 'running', 'online', 'idle', 'available', 'complete', 'completed'];
  return statuses.some(status => readyTokens.some(token => status === token || status.includes(token)));
};

const waitForModelReady = async (
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  onProgress?: ProgressUpdater
) => {
  const target = normalizeModelId(modelId);
  if (!target) {
    onProgress?.('No model specified. Checking for any loaded model...', 15);
    const { entries } = await fetchModelInventory(baseUrl, apiKey);
    if (entries.some(entry => isModelEntryReady(entry))) {
      onProgress?.('Found a loaded model. Proceeding...', 18);
      return;
    }
    throw new Error('No specific model was selected, and no model appears to be loaded in LM Studio. Please load a model.');
  }
  if (readyModels.has(target)) return;

  const deadline = Date.now() + MODEL_READY_TIMEOUT_MS;
  let attempt = 0;
  let loadAttempted = false;

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const { entries, hadSuccessfulRequest } = await fetchModelInventory(baseUrl, apiKey);
      const isReady = entries.some(entry =>
        matchesModelIdentifier(entry, target) && isModelEntryReady(entry)
      );
      if (isReady) {
        readyModels.add(target);
        return;
      }
      if (!hadSuccessfulRequest) {
        await sleep(MODEL_READY_POLL_DELAY_MS);
        loadAttempted = false;
        continue;
      }
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!loadAttempted) {
      try {
        await triggerModelLoad(baseUrl, apiKey, modelId);
        loadAttempted = true;
      } catch (err) {
        if ((err as any)?.code === 'model_not_found') {
          throw err;
        }
        loadAttempted = false;
      }
    }

    onProgress?.(
      `Waiting for LM Studio to finish loading "${modelId}" (attempt ${attempt}).`,
      Math.min(12 + attempt, 18)
    );
    await sleep(attempt === 1 ? MODEL_READY_POLL_DELAY_MS : LOAD_RETRY_DELAY_MS);
  }

  throw new Error(`Timed out waiting for LM Studio to load "${modelId}". Ensure it is downloaded and loaded, then try again.`);
};

const buildFallbackQuiz = (lessons: SavedLesson[], languageName: string): QuizQuestion[] => {
  if (!lessons.length) return [];

  const normalizedLanguage = (languageName || 'English').toLowerCase();
  const hintLabel = normalizedLanguage.startsWith('fr') ? 'Indice' : 'Hint';
  const explanationLabel = normalizedLanguage.startsWith('fr') ? 'Explication' : 'Explanation';
  const fallbackTag = normalizedLanguage.startsWith('fr') ? 'hors-ligne' : 'offline';

  const questions: QuizQuestion[] = [];

  lessons.forEach((lesson, lessonIndex) => {
    const primarySection = lesson.sheetData.sections[0];
    if (!primarySection) return;

    const descriptor = primarySection.title || lesson.title;
    const distractors: string[] = [];
    let offset = 1;
    while (distractors.length < 3 && offset <= lessons.length) {
      const candidate = lessons[(lessonIndex + offset) % lessons.length];
      if (candidate.id !== lesson.id && !distractors.includes(candidate.title)) {
        distractors.push(candidate.title);
      }
      offset++;
    }
    const extraTitles = lesson.sheetData.sections
      .slice(1)
      .map(section => section.title)
      .filter(Boolean) as string[];
    let extraIdx = 0;
    while (distractors.length < 3 && extraIdx < extraTitles.length) {
      const candidate = extraTitles[extraIdx++];
      if (!distractors.includes(candidate)) {
        distractors.push(candidate);
      }
    }
    while (distractors.length < 3) {
      distractors.push(`${lesson.title} (${distractors.length + 2})`);
    }

    const options: QuizOption[] = [
      {
        id: `fallback-${lesson.id}-correct`,
        text: lesson.title,
        explanation: `${explanationLabel}: ${lesson.title} couvre "${descriptor}".`,
        isCorrect: true
      },
      ...distractors.map((title, idx) => ({
        id: `fallback-${lesson.id}-distractor-${idx + 1}`,
        text: title,
        explanation: `${explanationLabel}: ce titre ne correspond pas à "${descriptor}".`,
        isCorrect: false
      }))
    ];

    questions.push({
      id: `fallback-${lesson.id}`,
      type: 'single_choice',
      prompt: normalizedLanguage.startsWith('fr')
        ? `Quelle leçon correspond à "${descriptor}" ?`
        : `Which lesson matches "${descriptor}"?`,
      lessonId: lesson.id,
      difficulty: 'easy',
      hint: `${hintLabel}: ${lesson.title}`,
      explanation: `${explanationLabel}: ${lesson.title} est associé au thème "${descriptor}".`,
      options,
      tags: [descriptor.slice(0, 32), fallbackTag]
    });
  });

  const ensureFillBlank = () => {
    lessons.forEach((lesson, lessonIndex) => {
      if (questions.length >= 7) return;
      const section = lesson.sheetData.sections[Math.min(1, lesson.sheetData.sections.length - 1)];
      const source = section?.content || lesson.sheetData.sections[0]?.content || lesson.title;
      if (!source) return;
      const keyword = pickKeyword(source);
      if (!keyword) return;
      const placeholder = source.replace(new RegExp(`\\b${keyword}\\b`, 'i'), '_____');
      questions.push({
        id: `fallback-fill-${lesson.id}-${lessonIndex}`,
        type: 'fill_blank',
        prompt: normalizedLanguage.startsWith('fr')
          ? `Complétez la définition suivante : ${placeholder}`
          : `Complete the following definition: ${placeholder}`,
        lessonId: lesson.id,
        difficulty: 'medium',
        hint: `${hintLabel}: ${keyword[0]}...`,
        explanation: `${explanationLabel}: ${keyword}`,
        acceptableAnswers: [keyword, keyword.toLowerCase()],
        tags: [lesson.title.slice(0, 32), fallbackTag]
      });
    });
  };

  const ensureTrueFalse = () => {
    lessons.forEach((lesson, lessonIndex) => {
      if (questions.length >= 8) return;
      const section = lesson.sheetData.sections[lesson.sheetData.sections.length - 1];
      const statement = section?.content?.split(/[\r\n]+/).find(line => line.trim().length > 40);
      if (!statement) return;
      const prompt = normalizedLanguage.startsWith('fr')
        ? `Vrai ou Faux: ${statement}`
        : `True or False: ${statement}`;

      questions.push({
        id: `fallback-tf-${lesson.id}-${lessonIndex}`,
        type: 'true_false',
        prompt,
        lessonId: lesson.id,
        difficulty: 'medium',
        hint: `${hintLabel}: ${lesson.title}`,
        explanation: `${explanationLabel}: ${statement}`,
        options: [
          {
            id: `tf-${lesson.id}-${lessonIndex}-true`,
            text: normalizedLanguage.startsWith('fr') ? 'Vrai' : 'True',
            explanation: `${explanationLabel}: ${statement}`,
            isCorrect: true
          },
          {
            id: `tf-${lesson.id}-${lessonIndex}-false`,
            text: normalizedLanguage.startsWith('fr') ? 'Faux' : 'False',
            explanation: `${explanationLabel}: ${statement}`,
            isCorrect: false
          }
        ],
        tags: [lesson.title.slice(0, 32), fallbackTag]
      });
    });
  };

  ensureFillBlank();
  ensureTrueFalse();

  if (questions.length < 5) {
    lessons.forEach((lesson, idx) => {
      if (questions.length >= 5) return;
      const options: QuizOption[] = [
        {
          id: `fallback-generic-${lesson.id}-1`,
          text: lesson.sheetData.sections[0]?.title || lesson.title,
          explanation: `${explanationLabel}: ${lesson.sheetData.sections[0]?.title || lesson.title}`,
          isCorrect: true
        }
      ];

      const pool: string[] = lessons
        .filter(l => l.id !== lesson.id)
        .map(l => l.sheetData.sections[0]?.title || l.title);
      lesson.sheetData.sections.slice(1).forEach(section => {
        if (section.title) pool.push(section.title);
      });
      let idxOpt = 0;
      while (options.length < 4 && idxOpt < pool.length) {
        const title = pool[idxOpt++];
        if (!title || title === lesson.sheetData.sections[0]?.title) continue;
        options.push({
          id: `fallback-generic-${lesson.id}-d-${options.length}`,
          text: title,
          explanation: `${explanationLabel}: ce thème est lié à ${title}.`,
          isCorrect: false
        });
      }
      while (options.length < 4) {
        options.push({
          id: `fallback-generic-${lesson.id}-placeholder-${options.length}`,
          text: `${lesson.title} (${options.length + 1})`,
          explanation: `${explanationLabel}: proposition générée hors-ligne.`,
          isCorrect: false
        });
      }

      questions.push({
        id: `fallback-generic-${lesson.id}-${idx}`,
        type: 'single_choice',
        prompt: normalizedLanguage.startsWith('fr')
          ? `Quel est le thème principal de "${lesson.title}" ?`
          : `What is the main theme of "${lesson.title}"?`,
        lessonId: lesson.id,
        difficulty: 'easy',
        hint: `${hintLabel}: ${lesson.sheetData.sections[0]?.title || lesson.title}`,
        explanation: `${explanationLabel}: ${lesson.sheetData.sections[0]?.title || lesson.title}`,
        options,
        tags: [lesson.title.slice(0, 32), fallbackTag]
      });
    });
  }

  return questions.slice(0, Math.max(5, Math.min(questions.length, 8)));
};

const buildLessonDigest = (
  lessons: SavedLesson[],
  maxSections: number,
  sectionSummaryLength: number,
  promptLimit: number
) => {
  const rawDigest = lessons.map((lesson, index) => {
    const sectionSummaries = lesson.sheetData.sections
      .slice(0, Math.max(1, maxSections))
      .map(section => {
        const summary = summarizeSectionContent(section.content, sectionSummaryLength);
        return `- ${section.title}: ${summary}`;
      }).join('\n');
    return `Lesson ${index + 1}\nlessonId: ${lesson.id}\nTitle: ${lesson.title}\nHighlights:\n${sectionSummaries || '- No detailed content provided.'}\n`;
  }).join('\n\n');

  const trimmedDigest = rawDigest.length > promptLimit
    ? trimForContext(rawDigest, promptLimit)
    : rawDigest;

  return {
    digest: trimmedDigest,
    wasTrimmed: rawDigest.length > promptLimit,
    originalLength: rawDigest.length
  };
};

const getSystemInstruction = (languageCode: string, isForChunks: boolean = false) => {
  const targetLanguage = getLanguageName(languageCode);
  if (isForChunks) {
    return `You are an expert academic assistant. Your task is to extract and summarize the key information from this text chunk.\n- Identify the main topics, definitions, and important points.\n- Output a concise summary in plain text. Do not use JSON.\n- Focus only on the content provided in this chunk.\n- Respond in ${targetLanguage}.`;
  }
  return `You are an expert academic assistant. Your task is to create a comprehensive and well-structured revision sheet from the provided text, which consists of several summarized chunks.\n- The output must be a JSON object with shape: { "title": string, "sections": [{ "title": string, "content": string }] }.\n- The 'title' should be a concise and relevant title for the entire document.\n- The 'sections' array should synthesize the chunk summaries into logical, distinct topics.\n- Each section 'title' should be clear and descriptive.\n- Each section 'content' should be a detailed summary of that topic, written in Markdown.\n- Use Markdown for formatting: headings, bold, italics, lists, etc.\n- IMPORTANT: Use custom tags for special content:\n    - !def[content] for definitions.\n    - !imp[content] for important facts or key takeaways.\n    - !formula[content] for formulas or code blocks.\n- Ensure the content is accurate and reflects the source material. Do not introduce new information.\n- Return only valid JSON, no backticks or explanations.\n- IMPORTANT: In JSON string values, escape newlines as \\n, tabs as \\t, carriage returns as \\r, and backslashes as \\\\.\n- Every human-readable string (title, section titles, content) must be written in ${targetLanguage}.`;
};

const formatChunkSummaries = (summaries: string[]): string => {
  const formatted = summaries.map((summary, index) => {
    const normalized = summary.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    const sentences = normalized.split(/(?<=[.!?])\s+/).slice(0, MAX_CHUNK_ITEMS);
    const bulletPoints = sentences
      .map(sentence => sentence.slice(0, MAX_CHUNK_ITEM_LENGTH).trim())
      .filter(Boolean)
      .map(sentence => `- ${sentence}`)
      .join('\n');
    return `Chunk ${index + 1}:\n${bulletPoints}`;
  }).filter(Boolean);

  const joined = formatted.join('\n\n');
  return joined.length > MAX_FINAL_PROMPT_CHARS
    ? trimForContext(joined, MAX_FINAL_PROMPT_CHARS)
    : joined;
};

const sanitizeSections = (sections: any[], languageName: string, fallbackSummaries: string[]): Section[] => {
  const safeSections: Section[] = [];
  sections.forEach((section, index) => {
    if (!section || typeof section !== 'object') return;
    const title = coerceString((section as any).title) ?? `${languageName} Section ${index + 1}`;
    const content = coerceString((section as any).content);
    if (!content) return;
    safeSections.push({
      id: `section-${index + 1}`,
      title,
      content
    });
  });

  if (!safeSections.length) {
    fallbackSummaries.forEach((summary, idx) => {
      const content = summary.trim();
      if (!content) return;
      safeSections.push({
        id: `fallback-${idx + 1}`,
        title: `${languageName} Summary ${idx + 1}`,
        content
      });
    });
  }

  if (!safeSections.length) {
    safeSections.push({
      id: 'section-1',
      title: `${languageName} Summary`,
      content: 'No structured content could be extracted.'
    });
  }

  return safeSections;
};

const parseRevisionSheet = (
  rawResponse: string,
  languageName: string,
  fallbackSummaries: string[]
): RevisionSheetData => {
  let parsed: JsonLike;
  try {
    parsed = extractAndParseJson(rawResponse);
  } catch (err) {
    throw new Error('The AI returned an invalid JSON response. Please try again with a shorter document or different prompt.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The AI response did not include the expected JSON structure.');
  }

  const title = coerceString((parsed as any).title) ?? `${languageName} Revision Sheet`;
  const sectionsInput = Array.isArray((parsed as any).sections) ? (parsed as any).sections : [];
  const sections = sanitizeSections(sectionsInput, languageName, fallbackSummaries);

  return {
    title,
    sections
  };
};

const sanitizeQuizOptions = (options: any[]): QuizOption[] => {
  const sanitized: QuizOption[] = [];
  options.forEach((option, index) => {
    if (!option || typeof option !== 'object') return;
    const text = coerceString((option as any).text);
    if (!text) return;
    const isCorrect = Boolean((option as any).isCorrect);
    sanitized.push({
      id: coerceString((option as any).id) ?? `option-${index + 1}`,
      text,
      explanation: coerceString((option as any).explanation) ?? undefined,
      isCorrect
    });
  });
  return sanitized;
};

const resolveLessonId = (value: unknown, lessons: SavedLesson[]): string => {
  const str = coerceString(value);
  if (str) {
    const exact = lessons.find(lesson => lesson.id === str);
    if (exact) return exact.id;
    const byTitle = lessons.find(lesson => lesson.title.toLowerCase() === str.toLowerCase());
    if (byTitle) return byTitle.id;
  }
  return lessons[0]?.id ?? 'lesson-1';
};

const sanitizeQuizQuestion = (
  raw: any,
  index: number,
  lessons: SavedLesson[],
  languageName: string
): QuizQuestion | null => {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = coerceString(raw.prompt);
  if (!prompt) return null;
  const typeRaw = coerceString(raw.type) ?? 'single_choice';
  const type = allowedQuizTypes.includes(typeRaw as QuizQuestionType)
    ? typeRaw as QuizQuestionType
    : 'single_choice';
  const lessonId = resolveLessonId((raw as any).lessonId ?? (raw as any).lesson_id ?? (raw as any).lessonTitle, lessons);
  const difficulty = coerceString(raw.difficulty) ?? 'medium';

  const base: QuizQuestion = {
    id: coerceString(raw.id) ?? `generated-${Date.now()}-${index}`,
    type,
    prompt,
    lessonId,
    difficulty,
    hint: coerceString(raw.hint) ?? undefined,
    explanation: coerceString(raw.explanation) ?? undefined,
    tags: Array.isArray(raw.tags)
      ? (raw.tags.map(coerceString).filter(Boolean) as string[])
      : undefined
  };

  if (type === 'single_choice' || type === 'multi_select' || type === 'true_false' || type === 'intruder') {
    const options = sanitizeQuizOptions(Array.isArray(raw.options) ? raw.options : []);
    if (!options.length) return null;
    base.options = options;
  } else if (type === 'fill_blank') {
    const answers = Array.isArray(raw.acceptableAnswers)
      ? (raw.acceptableAnswers.map(coerceString).filter(Boolean) as string[])
      : [];
    if (!answers.length) return null;
    base.acceptableAnswers = answers;
  } else if (type === 'categorize') {
    const categories: QuizCategory[] = Array.isArray(raw.categories)
      ? raw.categories.map((cat: any, idx: number) => ({
        id: coerceString(cat?.id) ?? `category-${idx + 1}`,
        name: coerceString(cat?.name) ?? `${languageName} Category ${idx + 1}`
      })).filter(cat => cat.name)
      : [];
    const classifiableItems: QuizClassifiableItem[] = Array.isArray(raw.classifiableItems)
      ? raw.classifiableItems.map((item: any, idx: number) => ({
        id: coerceString(item?.id) ?? `item-${idx + 1}`,
        label: coerceString(item?.label) ?? `${languageName} Item ${idx + 1}`,
        correctCategoryId: coerceString(item?.correctCategoryId) ?? categories[0]?.id ?? `category-${idx + 1}`,
        explanation: coerceString(item?.explanation) ?? undefined
      })).filter(item => item.label)
      : [];
    if (!categories.length || !classifiableItems.length) return null;
    base.categories = categories;
    base.classifiableItems = classifiableItems;
  } else if (type === 'sequence') {
    const sequenceItems: QuizSequenceItem[] = Array.isArray(raw.sequenceItems)
      ? raw.sequenceItems.map((item: any, idx: number) => ({
        id: coerceString(item?.id) ?? `sequence-${idx + 1}`,
        label: coerceString(item?.label) ?? `${languageName} Step ${idx + 1}`,
        correctOrder: typeof item?.correctOrder === 'number' ? item.correctOrder : idx + 1,
        explanation: coerceString(item?.explanation) ?? undefined
      })).filter(item => item.label)
      : [];
    if (!sequenceItems.length) return null;
    base.sequenceItems = sequenceItems;
  }

  return base;
};

const parseQuizQuestions = (
  rawResponse: string,
  lessons: SavedLesson[],
  languageName: string
): QuizQuestion[] => {
  let parsed: JsonLike;
  try {
    parsed = extractAndParseJson(rawResponse);
  } catch (err) {
    throw new Error('The AI returned an invalid JSON response for the quiz.');
  }

  const entries = Array.isArray((parsed as any)?.questions)
    ? (parsed as any).questions
    : Array.isArray(parsed)
      ? parsed
      : [];

  if (!entries.length) {
    throw new Error('No quiz questions were generated by the AI response.');
  }

  const sanitized = entries
    .map((entry, index) => sanitizeQuizQuestion(entry, index, lessons, languageName))
    .filter((question): question is QuizQuestion => Boolean(question));

  if (!sanitized.length) {
    throw new Error('The AI response did not contain any usable quiz questions.');
  }

  return sanitized;
};

const summarizeChunks = async (
  chunks: string[],
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  languageCode: string,
  onProgress?: ProgressUpdater
): Promise<string[]> => {
  const summaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onProgress?.(`Summarising chunk ${i + 1} of ${chunks.length}`, 18 + Math.min(12, Math.round((i / Math.max(1, chunks.length)) * 20)));
    const response = await callChatCompletion(
      baseUrl,
      apiKey,
      model,
      [
        { role: 'system', content: getSystemInstruction(languageCode, true) },
        { role: 'user', content: chunk }
      ],
      0.2,
      false
    );
    summaries.push(response.trim());
  }
  return summaries;
};

const buildRevisionPrompt = (
  summaries: string[],
  languageCode: string
): ChatMessage[] => {
  const formatted = formatChunkSummaries(summaries);
  return [
    { role: 'system', content: getSystemInstruction(languageCode) },
    {
      role: 'user',
      content: `The following summaries were generated from the source document. Combine them into a single, coherent revision sheet.\n\n${formatted}`
    }
  ];
};

const ensureModelAndBaseUrl = (settings: GenerationSettings) => {
  const model = settings.model?.trim();
  if (!model) {
    throw new Error('Please select a model in Settings before generating content.');
  }
  const baseUrl = settings.baseUrl?.trim() || defaultBaseUrl;
  return { model, baseUrl };
};

const buildRevisionSheetFromModel = async (
  normalizedText: string,
  settings: GenerationSettings,
  onProgress?: ProgressUpdater
): Promise<RevisionSheetData> => {
  const { model, baseUrl } = ensureModelAndBaseUrl(settings);
  const apiKey = settings.apiKey?.trim() || undefined;
  const languageCode = settings.language ?? 'en';
  const languageName = getLanguageName(languageCode);

  await waitForModelReady(baseUrl, apiKey, model, onProgress);

  const chunks = chunkText(normalizedText, CHUNK_SIZE);
  if (!chunks.length) {
    throw new Error('The processed document does not contain any readable text.');
  }

  onProgress?.('Summarising document chunks', 18);
  const chunkSummaries = await summarizeChunks(chunks, baseUrl, apiKey, model, languageCode, onProgress);

  onProgress?.('Assembling final revision sheet', 42);
  const messages = buildRevisionPrompt(chunkSummaries, languageCode);
  const rawResponse = await callChatCompletion(baseUrl, apiKey, model, messages, 0.25, true);

  return parseRevisionSheet(rawResponse, languageName, chunkSummaries);
};

const refineRevisionSheetWithModel = async (
  currentSheet: RevisionSheetData,
  refinementPrompt: string,
  documentText: string,
  settings: GenerationSettings
): Promise<RevisionSheetData> => {
  const { model, baseUrl } = ensureModelAndBaseUrl(settings);
  const apiKey = settings.apiKey?.trim() || undefined;
  const languageCode = settings.language ?? 'en';
  const languageName = getLanguageName(languageCode);

  await waitForModelReady(baseUrl, apiKey, model);

  const trimmedDocument = trimForContext(normalizeText(documentText), ENHANCEMENT_MAX_DOC_LENGTH);
  const trimmedSheet = trimForContext(JSON.stringify(currentSheet), ENHANCEMENT_MAX_SUMMARY_LENGTH);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You revise existing revision sheets in ${languageName}. Return a JSON object with the same structure { "title": string, "sections": [{ "title": string, "content": string }] }. Preserve helpful structure while applying the requested refinement.`
    },
    {
      role: 'user',
      content: `Current revision sheet (JSON):\n${trimmedSheet}\n\nDocument context (trimmed):\n${trimmedDocument}\n\nRefinement request: ${refinementPrompt}`
    }
  ];

  const rawResponse = await callChatCompletion(baseUrl, apiKey, model, messages, 0.25, true);
  const fallbackSummaries = currentSheet.sections.map(section => section.content);
  return parseRevisionSheet(rawResponse, languageName, fallbackSummaries);
};

const buildQuizPrompt = (
  lessons: SavedLesson[],
  languageName: string,
  targetQuestions: number,
  minQuestions: number,
  maxQuestions: number,
  allowCategorize: boolean,
  enforceJsonResponse: boolean
) => {
  const { digest, wasTrimmed } = buildLessonDigest(
    lessons,
    allowCategorize ? MAX_QUIZ_SECTIONS_PER_LESSON : Math.max(1, MAX_QUIZ_SECTIONS_PER_LESSON - 1),
    allowCategorize ? MAX_QUIZ_SECTION_SUMMARY_LENGTH : Math.max(120, MAX_QUIZ_SECTION_SUMMARY_LENGTH - 40),
    MAX_QUIZ_PROMPT_CHARS
  );

  const typeList = allowedQuizTypes
    .filter(type => allowCategorize || (type !== 'categorize'))
    .map(type => `- ${type}`)
    .join('\n');

  const instructions = enforceJsonResponse
    ? 'Return ONLY valid JSON with shape { "questions": QuizQuestion[] }.'
    : 'Prefer valid JSON. If that is not possible, return a parsable JSON array of questions.';

  return `You are an expert instructor designing an adaptive study quiz in ${languageName}. Generate between ${minQuestions} and ${maxQuestions} questions depending on the depth of the lessons provided. Aim for around ${targetQuestions} questions overall.\n\nUse ONLY the following question types (distribute them evenly):\n${typeList}\n\n${instructions}\nEach question must include:\n- "id" (string)\n- "type" (one of the allowed question types)\n- "prompt" (string)\n- "lessonId" (must match one of the lessonId values below)\n- "difficulty" (easy, medium, or hard)\n- Formatting rules based on the type (e.g. options for choice questions, acceptableAnswers for fill_blank, categories/classifiableItems for categorize, sequenceItems for sequence).\n\nLesson digest:${wasTrimmed ? ' (trimmed for context)' : ''}\n${digest}`;
};

const sanitizeQuizResult = (
  rawResponse: string,
  lessons: SavedLesson[],
  languageName: string,
  fallbackCount: number
): QuizQuestion[] => {
  const parsedQuestions = parseQuizQuestions(rawResponse, lessons, languageName);
  if (parsedQuestions.length < fallbackCount) {
    throw new Error('The AI response did not provide enough quiz questions.');
  }
  return parsedQuestions;
};

const generateQuizWithRetries = async (
  lessons: SavedLesson[],
  settings: GenerationSettings,
  onProgress: ProgressUpdater | undefined,
  minQuestions: number,
  targetQuestions: number,
  maxQuestions: number,
  languageName: string,
  attempts = 2
): Promise<QuizQuestion[]> => {
  const { model, baseUrl } = ensureModelAndBaseUrl(settings);
  const apiKey = settings.apiKey?.trim() || undefined;

  await waitForModelReady(baseUrl, apiKey, model, onProgress);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const allowCategorize = attempt === 0;
    const enforceJson = attempt === 0;
    const prompt = buildQuizPrompt(lessons, languageName, targetQuestions, minQuestions, maxQuestions, allowCategorize, enforceJson);
    onProgress?.(`Requesting adaptive quiz${attempt ? ' (retry)' : ''}`, 44 + attempt * 6);
    try {
      const rawResponse = await callChatCompletion(
        baseUrl,
        apiKey,
        model,
        [
          { role: 'system', content: `You generate quizzes in ${languageName}.` },
          { role: 'user', content: prompt }
        ],
        0.35,
        enforceJson
      );
      const questions = sanitizeQuizResult(rawResponse, lessons, languageName, minQuestions);
      if (questions.length > maxQuestions) {
        return questions.slice(0, maxQuestions);
      }
      return questions;
    } catch (err) {
      lastError = err;
      if (!shouldRetryQuizRequest(err)) {
        break;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Quiz generation failed for an unknown reason.');
};

export const generateRevisionSheet = async (
  documentText: string,
  settings: GenerationSettings,
  onProgress?: ProgressUpdater
): Promise<RevisionSheetData> => {
  const normalizedText = normalizeText(documentText);
  if (!normalizedText) {
    throw new Error('The document appears to be empty after preprocessing.');
  }

  try {
    return await buildRevisionSheetFromModel(normalizedText, settings, onProgress);
  } catch (err) {
    if (isContextWindowError(err)) {
      throw new Error('The document is too large for the selected model. Try enabling compact mode, removing sections, or choosing a model with a larger context window.');
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
};

export const refineRevisionSheet = async (
  currentSheet: RevisionSheetData,
  refinementPrompt: string,
  documentText: string,
  settings: GenerationSettings
): Promise<RevisionSheetData> => {
  if (!refinementPrompt.trim()) {
    throw new Error('Provide a refinement instruction before requesting an update.');
  }
  try {
    return await refineRevisionSheetWithModel(currentSheet, refinementPrompt, documentText, settings);
  } catch (err) {
    if (isContextWindowError(err)) {
      throw new Error('The refinement request exceeded the model context window. Try shortening the document or requesting a smaller change.');
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
};

export const generateAdaptiveQuiz = async (
  lessons: SavedLesson[],
  settings: GenerationSettings,
  onProgress?: ProgressUpdater,
  existingQuestions: QuizQuestion[] = [],
  quizSize: 'small' | 'medium' | 'complete' = 'medium',
  selectedQuizTypes: QuizQuestionType[] = []
): Promise<QuizQuestion[]> => {
  if (!lessons.length) {
    throw new Error('Select at least one lesson to generate a quiz.');
  }

  const languageCode = settings.language ?? lessons[0]?.language ?? 'en';
  const languageName = getLanguageName(languageCode);

  let minQuestions: number;
  let targetQuestions: number;
  let maxQuestions: number;

  switch (quizSize) {
    case 'small':
      minQuestions = 5;
      targetQuestions = 6;
      maxQuestions = 7;
      break;
    case 'complete':
      minQuestions = 15;
      targetQuestions = 18;
      maxQuestions = 20;
      break;
    case 'medium':
    default:
      minQuestions = 8;
      targetQuestions = 10;
      maxQuestions = 12;
      break;
  }

  try {
    const questions = await generateQuizWithRetries(
      lessons,
      settings,
      onProgress,
      minQuestions,
      targetQuestions,
      maxQuestions,
      languageName
    );

    const filteredQuestions = selectedQuizTypes.length
      ? questions.filter(question => selectedQuizTypes.includes(question.type))
      : questions;

    const deduplicated = filteredQuestions.filter(question => {
      return !existingQuestions.some(existing => existing.prompt.trim() === question.prompt.trim());
    });

    if (!deduplicated.length) {
      throw new Error('The AI generated questions that already exist in your quiz bank.');
    }

    return deduplicated;
  } catch (err) {
    if (isContextWindowError(err)) {
      throw new Error('The quiz request exceeded the model context window. Try selecting fewer lessons or a smaller quiz size.');
    }

    // Fall back to deterministic quiz generation so the user still receives content.
    const fallback = buildFallbackQuiz(lessons, languageName);
    if (fallback.length) {
      return fallback;
    }

    throw err instanceof Error ? err : new Error(String(err));
  }
};
