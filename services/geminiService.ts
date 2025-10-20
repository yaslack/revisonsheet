import { RevisionSheetData, GenerationSettings, Section } from '../types';
import {
  RevisionSheetData,
  GenerationSettings,
  Section,
  SavedLesson,
  QuizQuestion,
  QuizOption,
  QuizQuestionType,
  QuizCategory,
  QuizClassifiableItem
} from '../types';
import { chunkText, normalizeText, trimForContext } from "../utils/textUtils";

const CHUNK_SIZE = 1800;
const MAX_CONCURRENT_REQUESTS = 5;
const MAX_FINAL_PROMPT_CHARS = 7500;
const MAX_CHUNK_ITEMS = 6;
const MAX_CHUNK_ITEM_LENGTH = 160;
const ENHANCEMENT_MAX_DOC_LENGTH = 12000;
const ENHANCEMENT_MAX_SUMMARY_LENGTH = 5000;
const MODEL_READY_TIMEOUT_MS = 120000;
const MODEL_READY_POLL_DELAY_MS = 1000;
const LOAD_RETRY_DELAY_MS = 2000;
const readyModels = new Set<string>();

const defaultBaseUrl = 'http://localhost:1234/v1';
const MAX_QUIZ_PROMPT_CHARS = 6200;
const MAX_QUIZ_SECTIONS_PER_LESSON = 4;
const MAX_QUIZ_SECTION_SUMMARY_LENGTH = 200;
const QUIZ_PROMPT_COMPRESSION_STEPS = [
  {
    promptLimit: MAX_QUIZ_PROMPT_CHARS,
    maxSections: MAX_QUIZ_SECTIONS_PER_LESSON,
    sectionSummaryLength: MAX_QUIZ_SECTION_SUMMARY_LENGTH,
    allowCategorize: true,
    enforceJsonResponse: true,
    minimalInstructions: false
  },
  {
    promptLimit: Math.floor(MAX_QUIZ_PROMPT_CHARS * 0.65),
    maxSections: Math.max(2, Math.floor(MAX_QUIZ_SECTIONS_PER_LESSON * 0.75)),
    sectionSummaryLength: 160,
    allowCategorize: true,
    enforceJsonResponse: true,
    minimalInstructions: false
  },
  {
    promptLimit: Math.floor(MAX_QUIZ_PROMPT_CHARS * 0.45),
    maxSections: 2,
    sectionSummaryLength: 140,
    allowCategorize: false,
    enforceJsonResponse: false,
    minimalInstructions: false
  },
  {
    promptLimit: Math.floor(MAX_QUIZ_PROMPT_CHARS * 0.28),
    maxSections: 1,
    sectionSummaryLength: 110,
    allowCategorize: false,
    enforceJsonResponse: false,
    minimalInstructions: true
  }
] as const;

const summarizeSectionContent = (content: string, limit = 360): string => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
};

const languageLabels: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ar: 'Arabic'
};

const getLanguageName = (code?: string) => languageLabels[code ?? ''] ?? code ?? 'English';

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
      .filter(Boolean);
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
      const placeholder = source.replace(new RegExp(`\b${keyword}\b`, 'i'), '_____');
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
      options: [
        {
          id: `fallback-generic-${lesson.id}-1`,
          text: lesson.sheetData.sections[0]?.title || lesson.title,
          explanation: `${explanationLabel}: ${lesson.sheetData.sections[0]?.title || lesson.title}`,
          isCorrect: true
        },
        ...(() => {
          const pool: string[] = lessons
            .filter(l => l.id !== lesson.id)
            .map(l => l.sheetData.sections[0]?.title || l.title);
          lesson.sheetData.sections.slice(1).forEach(section => {
            if (section.title) pool.push(section.title);
          });
          const options: QuizOption[] = [];
          let idxOpt = 0;
          while (options.length < 3 && idxOpt < pool.length) {
            const title = pool[idxOpt++];
            if (!title || title === lesson.sheetData.sections[0]?.title) continue;
            options.push({
              id: `fallback-generic-${lesson.id}-d-${options.length}`,
              text: title,
              explanation: `${explanationLabel}: ce thème est lié à ${title}.`,
              isCorrect: false
            });
          }
          while (options.length < 3) {
            options.push({
              id: `fallback-generic-${lesson.id}-placeholder-${options.length}`,
              text: `${lesson.title} (${options.length + 2})`,
              explanation: `${explanationLabel}: proposition générée hors-ligne.`,
              isCorrect: false
            });
          }
          return options;
        })()
      ],
      tags: [lesson.title.slice(0, 32), fallbackTag]
    });
  });

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

const callChatCompletion = async (
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
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
    body.response_format = { type: 'text' };
  }
  
  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : { Authorization: 'Bearer lm-studio' })
    },
    body: JSON.stringify(body)
  });
  
  if (!res.ok && res.status === 400) {
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
    if (code >= 0 && code < 0x20) { out += `\\u${code.toString(16).padStart(4,'0')}`; continue; }
    out += ch;
  }
  return out;
};

const extractAndParseJson = (raw: string) => {
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

type ProgressUpdater = (step: string, percentage: number) => void;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const normalizeModelId = (id: unknown): string =>
  typeof id === 'string' ? id.trim().toLowerCase() : '';

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
  const url = `${restBase}/models/load`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: modelId })
  });

  if (res.ok) return;

  const text = await res.text().catch(() => '');
  if (res.status === 409 || res.status === 202) {
    return;
  }

  let parsedMessage = '';
  try {
    const payload = JSON.parse(text);
    parsedMessage = payload?.error?.message ?? payload?.message ?? '';
  } catch {}

  if (res.status === 404 || /not\s+found/i.test(parsedMessage)) {
    const error = new Error(`Model "${modelId}" is not downloaded on this LM Studio server. Download it (e.g. via LM Studio or lms get) and try again.`);
    (error as any).code = 'model_not_found';
    throw error;
  }

  throw new Error(`Failed to trigger model load (${res.status} ${res.statusText} ${text})`);
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
      const restBase = deriveRestBaseUrl(baseUrl);
      const endpoint = `${restBase}/models`;
      const res = await fetch(endpoint, { headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } });
      if (res.ok) {
          const body = await res.json().catch(() => null);
          const models: any[] = body?.data ?? [];
          if (models.some(m => m.loaded)) {
              onProgress?.('Found a loaded model. Proceeding...', 18);
              return; // A model is loaded, proceed
          }
      }
      throw new Error('No specific model was selected, and no model appears to be loaded in LM Studio. Please load a model.');
  }
  if (readyModels.has(target)) return;

  const restBase = deriveRestBaseUrl(baseUrl);
  const endpoint = `${restBase}/models`;
  const deadline = Date.now() + MODEL_READY_TIMEOUT_MS;
  let attempt = 0;
  let loadAttempted = false;

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        }
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const models: any[] = body?.data ?? [];
        const isReady = models.some(entry => {
          const id = normalizeModelId(entry?.id);
          return id === target && entry.loaded;
        });
        if (isReady) {
          readyModels.add(target);
          return;
        }
      } else if (res.status === 404 || res.status === 503) {
        await sleep(MODEL_READY_POLL_DELAY_MS);
        loadAttempted = false;
        continue;
      } else {
        const text = await res.text().catch(() => '');
        throw new Error(`Failed to verify loaded models (${res.status} ${res.statusText} ${text})`);
      }
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!loadAttempted) {
      try {
        await triggerModelLoad(baseUrl, apiKey, modelId);
      } catch (err) {
        if ((err as any)?.code === 'model_not_found') {
          throw err;
        }
      }
      loadAttempted = true;
    }

    onProgress?.(
      `Waiting for LM Studio to finish loading "${modelId}" (attempt ${attempt}).`,
      Math.min(12 + attempt, 18)
    );
    await sleep(attempt === 1 ? MODEL_READY_POLL_DELAY_MS : LOAD_RETRY_DELAY_MS);
    loadAttempted = false;
  }

  throw new Error(`Timed out waiting for LM Studio to load "${modelId}". Ensure it is downloaded and loaded, then try again.`);
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

  const baseUrl = settings.baseUrl || defaultBaseUrl;
  const apiKey = settings.apiKey;
  const model = settings.model?.trim();
  const languageCode = settings.language ?? 'en';
  const languageName = getLanguageName(languageCode);

  await waitForModelReady(baseUrl, apiKey, model, onProgress);

  onProgress?.('Summarising lessons for quiz generation.', 18);

  let minQuestions: number, targetQuestions: number, maxQuestions: number;

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

  let lastError: unknown = null;

  const allTypeInfo: Record<QuizQuestionType, { desc: string; rule: string }> = {
    single_choice: {
      desc: '"single_choice": exactly one correct option.',
      rule: '- For "single_choice", provide exactly four answer options.'
    },
    multi_select: {
      desc: '"multi_select": at least two correct options.',
      rule: '- For "multi_select", mark at least two options with "isCorrect": true and provide exactly four answer options.'
    },
    true_false: {
      desc: '"true_false": a statement to be evaluated as true or false.',
      rule: '- For "true_false", provide exactly two options (True/False).'
    },
    fill_blank: {
      desc: '"fill_blank": the learner types a short answer.',
      rule: '- For "fill_blank", omit "options" and supply at least two entries in "acceptableAnswers".'
    },
    intruder: {
      desc: '"intruder": find the item that doesn\'t belong in a list of 4.',
      rule: '- For "intruder", the prompt should ask to find the odd one out. Provide four options and mark the single intruder option with "isCorrect": true.'
    },
    categorize: {
      desc: '"categorize": assign items to the correct category.',
      rule: '- For "categorize", omit "options", provide a "categories" array, and a "classifiableItems" array.'
    },
    sequence: {
      desc: '"sequence": place items in the correct order.',
      rule: '- For "sequence", omit "options", and provide a "sequenceItems" array.'
    }
  };

  const activeTypes = selectedQuizTypes.length > 0 ? selectedQuizTypes : Object.keys(allTypeInfo) as QuizQuestionType[];
  const typeDistribution = activeTypes.map(t => `- ${allTypeInfo[t].desc}`).join('\n');
  const formattingRules = activeTypes.map(t => allTypeInfo[t].rule).join('\n');

  for (let attempt = 0; attempt < QUIZ_PROMPT_COMPRESSION_STEPS.length; attempt++) {
    const config = QUIZ_PROMPT_COMPRESSION_STEPS[attempt];
    const { digest, wasTrimmed } = buildLessonDigest(
      lessons,
      config.maxSections,
      config.sectionSummaryLength,
      config.promptLimit
    );

    if (wasTrimmed) {
      const compressionMessage = attempt === 0
        ? 'Compacting lesson summaries to fit model context.'
        : 'Applying ultra-compact lesson digest for retry.';
      onProgress?.(compressionMessage, 38 + Math.min(attempt, 2));
    }

    const attemptLabel = attempt === 0
      ? 'Requesting adaptive quiz from model.'
      : `Requesting adaptive quiz with condensed context (attempt ${attempt + 1}).`;
    onProgress?.(attemptLabel, 42 + Math.min(attempt * 2, 48));

    const existingQuestionsDigest = existingQuestions.length > 0
      ? `Your most important task is to generate NEW and DIVERSE questions. The user's quiz bank already contains the questions listed below. Do NOT repeat them or ask the same thing in a slightly different way. Focus on different aspects of the lesson material that have not been tested yet.\n\nExisting questions to avoid:\n${existingQuestions.map((q, i) => `- ${q.prompt}`).join('\n')}`
      : '';

    const quizPrompt = `You are an expert instructor designing an adaptive study quiz in ${languageName}.
Generate between ${minQuestions} and ${maxQuestions} questions depending on the depth of the lessons provided. Aim for around ${targetQuestions} questions overall.

${existingQuestionsDigest}

Use ONLY the following question types, distributing them as evenly as possible:
${typeDistribution}

For every question:
- Set 