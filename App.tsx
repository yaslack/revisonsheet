import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import FileUpload from './components/FileUpload';
import RevisionSheet from './components/RevisionSheet';
import ProgressBar from './components/ProgressBar';
import SettingsModal from './components/SettingsModal';
import { BrainCircuitIcon } from './components/icons/BrainCircuitIcon';
import { ErrorIcon } from './components/icons/ErrorIcon';
import { SettingsIcon } from './components/icons/SettingsIcon';
import { generateRevisionSheet, refineRevisionSheet, generateAdaptiveQuiz } from './services/geminiService';
import {
  GenerationSettings,
  QuizQuestion,
  QuizQuestionType,
  RevisionSheetData,
  SavedLesson,
  QuizSequenceItem
} from './types';

type AppState = 'idle' | 'parsing' | 'generating' | 'ready' | 'refining';
type ViewMode = 'upload' | 'sheet' | 'lessons' | 'quiz';

interface ProgressState {
  step: string;
  percentage: number;
}

const SETTINGS_KEY = 'revSheetSettings';
const LESSONS_KEY = 'revSheetLessons';

const sortLessonsByUpdated = (collection: SavedLesson[]) =>
  [...collection].sort((a, b) => b.updatedAt - a.updatedAt);

const questionKey = (question: QuizQuestion): string => {
  const base = question.id?.trim() || question.prompt?.trim() || '';
  return `${question.lessonId}::${base.toLowerCase().replace(/\s+/g, ' ')}`;
};

const mergeQuizBanks = (existing: QuizQuestion[] | undefined, incoming: QuizQuestion[]): QuizQuestion[] => {
  const map = new Map<string, QuizQuestion>();
  existing?.forEach(q => map.set(questionKey(q), q));
  incoming.forEach(q => map.set(questionKey(q), q));
  return Array.from(map.values());
};

const aggregateSelectedQuizQuestions = (lessons: SavedLesson[], selectedIds: string[]): QuizQuestion[] => {
  const pool: QuizQuestion[] = [];
  lessons.forEach(lesson => {
    if (selectedIds.includes(lesson.id) && lesson.quizBank?.length) {
      pool.push(...lesson.quizBank);
    }
  });
  return pool;
};

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Francais' },
  { value: 'es', label: 'Espanol' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Portugues' },
  { value: 'ar', label: 'Arabic' }
];

const typeMetadata: Record<QuizQuestionType, { label: string; instruction: string }> = {
    single_choice: { label: 'Choix unique', instruction: 'Sélectionnez la seule bonne réponse.' },
    multi_select: { label: 'Choix multiples', instruction: 'Sélectionnez toutes les bonnes réponses.' },
    true_false: { label: 'Vrai/Faux', instruction: 'Décidez si l\'affirmation est vraie ou fausse.' },
    fill_blank: { label: 'Texte à trous', instruction: 'Remplissez le texte manquant.' },
    categorize: { label: 'Catégorisation', instruction: 'Assignez chaque élément à la bonne catégorie.' },
    sequence: { label: 'Séquence', instruction: 'Mettez les éléments dans le bon ordre.' },
    intruder: { label: 'L\'intrus', instruction: 'Sélectionnez l\'élément qui ne correspond pas à la liste.' },
    spot_error: { label: 'Détection d\'erreur', instruction: 'Cliquez sur le mot incorrect dans la phrase.' }
};
const allQuizTypes = Object.keys(typeMetadata) as QuizQuestionType[];

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>('idle');
  const [progress, setProgress] = useState<ProgressState>({ step: '', percentage: 0 });
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [documentText, setDocumentText] = useState('');
  const [sheetData, setSheetData] = useState<RevisionSheetData | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [view, setView] = useState<ViewMode>('upload');

  const [lessons, setLessons] = useState<SavedLesson[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(LESSONS_KEY);
      if (!stored) return [];
      const parsed: SavedLesson[] = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return sortLessonsByUpdated(parsed.map(entry => ({
        ...entry,
        quizBank: Array.isArray(entry.quizBank) ? entry.quizBank : [],
        lastQuizGeneratedAt: typeof (entry as any).lastQuizGeneratedAt === 'number'
          ? (entry as any).lastQuizGeneratedAt
          : undefined
      })));
    } catch {
      return [];
    }
  });
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);
  const [currentLessonId, setCurrentLessonId] = useState<string | null>(null);
  const [refiningLessonId, setRefiningLessonId] = useState<string | null>(null);

  const [quizSelection, setQuizSelection] = useState<string[]>([]);
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[] | null>(null);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizScore, setQuizScore] = useState(0);
  const [quizSelectedOptions, setQuizSelectedOptions] = useState<string[]>([]);
  const [quizTextAnswer, setQuizTextAnswer] = useState('');
  const [quizCategoryAnswers, setQuizCategoryAnswers] = useState<Record<string, string>>({});
  const [quizSequenceAnswer, setQuizSequenceAnswer] = useState<QuizSequenceItem[]>([]);
  const [spotErrorSelection, setSpotErrorSelection] = useState<{ word: string; index: number } | null>(null);
  const [quizShowFeedback, setQuizShowFeedback] = useState(false);
  const [quizHintVisible, setQuizHintVisible] = useState(false);
  const [quizCompleted, setQuizCompleted] = useState(false);
  const [quizAnswerError, setQuizAnswerError] = useState('');
  const [quizStatus, setQuizStatus] = useState('');
  const [quizError, setQuizError] = useState('');
  const [isGeneratingQuiz, setIsGeneratingQuiz] = useState(false);
  const [quizSize, setQuizSize] = useState<'small' | 'medium' | 'complete'>('medium');
  const [selectedQuizTypes, setSelectedQuizTypes] = useState<QuizQuestionType[]>(allQuizTypes);

  const isMounted = useRef(false);

  const [settings, setSettings] = useState<GenerationSettings>(() => {
    if (typeof window === 'undefined') {
      return { model: '', baseUrl: 'http://127.0.0.1:7894/v1', language: 'en' };
    }
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          return {
            model: '',
            baseUrl: 'http://127.0.0.1:7894/v1',
            language: 'en',
            ...parsed
          };
        }
      }
    } catch {}
    return { model: '', baseUrl: 'http://127.0.0.1:7894/v1', language: 'en' };
  });

  useEffect(() => {
    isMounted.current = true;
  }, []);

  useEffect(() => {
    if (isMounted.current) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {}
    }
  }, [settings]);

  useEffect(() => {
    if (isMounted.current) {
        try {
            localStorage.setItem(LESSONS_KEY, JSON.stringify(lessons));
        } catch {}
    }
  }, [lessons]);

  useEffect(() => {
    if (quizQuestions && quizQuestions.length > 0) {
      const currentQuestion = quizQuestions[quizIndex];
      if (currentQuestion.type === 'sequence' && currentQuestion.sequenceItems) {
        const answerIds = new Set(quizSequenceAnswer.map(i => i.id));
        const questionIds = new Set(currentQuestion.sequenceItems.map(i => i.id));
        const setsAreEqual = (a: Set<any>, b: Set<any>) => a.size === b.size && [...a].every(value => b.has(value));

        if (!setsAreEqual(answerIds, questionIds)) {
          const shuffled = [...currentQuestion.sequenceItems].sort(() => Math.random() - 0.5);
          setQuizSequenceAnswer(shuffled);
        }
      } else if (quizSequenceAnswer.length > 0) {
        setQuizSequenceAnswer([]);
      }
    }
  }, [quizQuestions, quizIndex]);

  useEffect(() => {
    setQuizSelection(prev => prev.filter(id => lessons.some(lesson => lesson.id === id)));
  }, [lessons]);

  useEffect(() => {
    if (view !== 'lessons') return;
    if (!lessons.length) {
      setSelectedLessonId(null);
      return;
    }
    if (!selectedLessonId || !lessons.some(lesson => lesson.id === selectedLessonId)) {
      setSelectedLessonId(lessons[0].id);
    }
  }, [view, lessons, selectedLessonId]);
  const handleProgress = useCallback((step: string, percentage: number) => {
    setProgress({ step, percentage });
  }, []);

  const resetQuizWorkingState = useCallback(() => {
    setQuizIndex(0);
    setQuizScore(0);
    setQuizSelectedOptions([]);
    setQuizTextAnswer('');
    setQuizCategoryAnswers({});
    setQuizSequenceAnswer([]);
    setSpotErrorSelection(null);
    setQuizShowFeedback(false);
    setQuizHintVisible(false);
    setQuizCompleted(false);
    setQuizAnswerError('');
  }, []);

  const handleMoveSequenceItem = useCallback((index: number, direction: 'up' | 'down') => {
    if (quizShowFeedback) return;
    setQuizSequenceAnswer(prev => {
      const newAnswer = [...prev];
      const item = newAnswer[index];
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= newAnswer.length) return prev;
      newAnswer[index] = newAnswer[swapIndex];
      newAnswer[swapIndex] = item;
      return newAnswer;
    });
  }, [quizShowFeedback]);

  const upsertLesson = useCallback((lesson: SavedLesson) => {
    setLessons(prev => {
      const index = prev.findIndex(item => item.id === lesson.id);
      if (index === -1) {
        return sortLessonsByUpdated([lesson, ...prev]);
      }
      const copy = [...prev];
      copy[index] = lesson;
      return sortLessonsByUpdated(copy);
    });
  }, []);

  const updateLesson = useCallback((lessonId: string, patch: Partial<SavedLesson>) => {
    setLessons(prev => {
      const index = prev.findIndex(item => item.id === lessonId);
      if (index === -1) return prev;
      const updated: SavedLesson = {
        ...prev[index],
        ...patch,
        sheetData: patch.sheetData ?? prev[index].sheetData
      };
      const copy = [...prev];
      copy[index] = updated;
      return sortLessonsByUpdated(copy);
    });
  }, []);

  const createLesson = useCallback((sheet: RevisionSheetData, sourceDocument: string, sourceFile?: string) => {
    const timestamp = Date.now();
    const id = `lesson-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const lesson: SavedLesson = {
      id,
      title: sheet.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      sheetData: sheet,
      documentText: sourceDocument,
      fileName: sourceFile,
      language: settings.language,
      quizBank: [],
      lastQuizGeneratedAt: undefined
    };
    upsertLesson(lesson);
    setCurrentLessonId(id);
    setSelectedLessonId(id);
    return id;
  }, [settings.language, upsertLesson]);

  const deleteLesson = useCallback((lessonId: string) => {
    setLessons(prev => prev.filter(lesson => lesson.id !== lessonId));
    setCurrentLessonId(prev => (prev === lessonId ? null : prev));
    setSelectedLessonId(prev => (prev === lessonId ? null : prev));
    setQuizSelection(prev => prev.filter(id => id !== lessonId));
  }, []);

  const openLessonInWorkspace = useCallback((lesson: SavedLesson) => {
    setSheetData(lesson.sheetData);
    setDocumentText(lesson.documentText);
    setFileName(lesson.fileName ?? '');
    setCurrentLessonId(lesson.id);
    setError('');
    setProgress({ step: '', percentage: 0 });
    setView('sheet');
    setAppState('ready');
  }, []);

  const handleFileSelect = useCallback((content: string, name: string) => {
    setDocumentText(content);
    setFileName(name);
    setError('');
    if (!content) {
      setAppState('idle');
    }
  }, []);

  const handleParseStart = useCallback(() => {
    setAppState('parsing');
    setProgress({ step: 'Parsing document', percentage: 10 });
    setError('');
  }, []);

  const handleParseEnd = useCallback(() => {
    setAppState(prev => prev === 'parsing' ? 'idle' : prev);
    setProgress(prev => prev.step ? prev : { step: '', percentage: 0 });
  }, []);
  const handleGenerateSheet = useCallback(async () => {
    if (!documentText.trim()) {
      setError('Upload or paste a document before generating a revision sheet.');
      return;
    }
    if (!settings.model && settings.model.trim()) {
      setError('Please choose a model in Settings.');
      setIsSettingsOpen(true);
      return;
    }
    setAppState('generating');
    setError('');
    setProgress({ step: 'Preparing request', percentage: 12 });

    try {
      const sheet = await generateRevisionSheet(documentText, settings, handleProgress);
      setSheetData(sheet);
      setAppState('ready');
      createLesson(sheet, documentText, fileName);
    } catch (err: any) {
      console.error('Generation failed:', err);
      setError(err?.message || 'Failed to generate the revision sheet. Please try again.');
      setAppState('idle');
    } finally {
      setProgress({ step: '', percentage: 0 });
    }
  }, [documentText, settings, handleProgress, createLesson, fileName]);

  const handleRefineCurrentSheet = useCallback(async () => {
    if (!sheetData || !documentText) return;
    const refinementPrompt = window.prompt(
      "How should I refine the sheet? (e.g., 'make it more concise', 'add more detail to the first section', 'focus on definitions')"
    );
    if (!refinementPrompt) return;
    if (!settings.model && settings.model.trim()) {
      setError('Please choose a model in Settings.');
      setIsSettingsOpen(true);
      return;
    }
    setAppState('refining');
    setError('');
    try {
      const refined = await refineRevisionSheet(sheetData, refinementPrompt, documentText, settings);
      setSheetData(refined);
      if (currentLessonId) {
        updateLesson(currentLessonId, {
          sheetData: refined,
          title: refined.title,
          updatedAt: Date.now()
        });
      }
    } catch (err: any) {
      console.error('Refinement failed:', err);
      const message = err?.message?.toLowerCase().includes('json')
        ? 'The AI returned an invalid format during refinement. Please try again.'
        : err?.message || 'Failed to refine the revision sheet. Please try again.';
      setError(message);
    } finally {
      setAppState('ready');
    }
  }, [sheetData, documentText, settings, currentLessonId, updateLesson]);

  const handleRefineStoredLesson = useCallback(async (lessonId: string) => {
    const lesson = lessons.find(item => item.id === lessonId);
    if (!lesson) return;
    if (!settings.model && settings.model.trim()) {
      setError('Please choose a model in Settings.');
      setIsSettingsOpen(true);
      return;
    }
    const refinementPrompt = window.prompt(
      "How should I refine the sheet? (e.g., 'make it more concise', 'add more detail to the first section', 'focus on definitions')"
    );
    if (!refinementPrompt) return;
    setRefiningLessonId(lessonId);
    setError('');
    try {
      const refined = await refineRevisionSheet(lesson.sheetData, refinementPrompt, lesson.documentText, settings);
      updateLesson(lessonId, {
        sheetData: refined,
        title: refined.title,
        updatedAt: Date.now()
      });
      if (currentLessonId === lessonId) {
        setSheetData(refined);
      }
    } catch (err: any) {
      console.error('Refinement failed:', err);
      const message = err?.message?.toLowerCase().includes('json')
        ? 'The AI returned an invalid format during refinement. Please try again.'
        : err?.message || 'Failed to refine the revision sheet. Please try again.';
      setError(message);
    } finally {
      setRefiningLessonId(null);
    }
  }, [lessons, settings, currentLessonId, updateLesson]);

  const handleGenerateQuiz = useCallback(async () => {
    if (!quizSelection.length) {
      setQuizError('Select at least one lesson to generate a quiz.');
      return;
    }
    if (selectedQuizTypes.length === 0) {
      setQuizError('Please select at least one question type.');
      return;
    }
    const selectedLessons = lessons.filter(lesson => quizSelection.includes(lesson.id));
    if (!selectedLessons.length) {
      setQuizError('The selected lessons could not be found.');
      return;
    }

    const existingQuestions = selectedLessons.reduce((acc: QuizQuestion[], lesson) => {
      return acc.concat(lesson.quizBank ?? []);
    }, []);

    setIsGeneratingQuiz(true);
    setQuizStatus('Preparing quiz...');
    setQuizError('');
    try {
      const questions = await generateAdaptiveQuiz(
        selectedLessons,
        settings,
        step => setQuizStatus(step),
        existingQuestions,
        quizSize,
        selectedQuizTypes
      );
      const questionsByLesson = new Map<string, QuizQuestion[]>();
      questions.forEach(question => {
        const list = questionsByLesson.get(question.lessonId) ?? [];
        list.push(question);
        questionsByLesson.set(question.lessonId, list);
      });

      const generationTimestamp = Date.now();
      
      setLessons(prevLessons => {
        const updatedLessons = prevLessons.map(lesson => {
          const lessonQuestions = questionsByLesson.get(lesson.id);
          if (!lessonQuestions || !lessonQuestions.length) {
            return lesson;
          }
          return {
            ...lesson,
            quizBank: mergeQuizBanks(lesson.quizBank, lessonQuestions),
            lastQuizGeneratedAt: generationTimestamp,
            updatedAt: Math.max(lesson.updatedAt, generationTimestamp)
          };
        });
        return sortLessonsByUpdated(updatedLessons);
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      
      const merged = aggregateSelectedQuizQuestions(
        lessons.map(lesson => {
          const lessonQuestions = questionsByLesson.get(lesson.id);
          if (!lessonQuestions || !lessonQuestions.length) {
            return lesson;
          }
          return {
            ...lesson,
            quizBank: mergeQuizBanks(lesson.quizBank, lessonQuestions)
          };
        }),
        quizSelection
      );

      setQuizQuestions(merged.length ? merged : questions);
      resetQuizWorkingState();
    } catch (err: any) {
      console.error('Quiz generation failed:', err);
      setQuizError(err?.message || 'Failed to generate the quiz. Please try again.');
    } finally {
      setIsGeneratingQuiz(false);
      setQuizStatus('');
    }
  }, [quizSelection, lessons, settings, resetQuizWorkingState, quizSize, selectedQuizTypes]);

  const handleLoadSavedQuiz = useCallback(() => {
    if (!quizSelection.length) {
      setQuizError('Select at least one lesson to load a saved quiz.');
      return;
    }
    const stored = aggregateSelectedQuizQuestions(lessons, quizSelection);
    if (!stored.length) {
      setQuizError('No saved quiz exists for the selected lessons yet. Generate one first.');
      return;
    }
    setQuizQuestions(stored);
    resetQuizWorkingState();
    setQuizError('');
  }, [lessons, quizSelection, resetQuizWorkingState]);

  const handleDeleteQuiz = useCallback(() => {
    if (!quizSelection.length) {
      setQuizError('Select at least one lesson to delete its quiz.');
      return;
    }
    if (typeof window === 'undefined' || !window.confirm('Are you sure you want to delete the saved quiz for the selected lessons? This cannot be undone.')) {
      return;
    }
    setLessons(prev => {
      const updated = prev.map(lesson => {
        if (quizSelection.includes(lesson.id)) {
          return { ...lesson, quizBank: [], lastQuizGeneratedAt: undefined };
        }
        return lesson;
      });
      return sortLessonsByUpdated(updated);
    });
    setQuizQuestions(null);
    resetQuizWorkingState();
    setQuizError('');
  }, [quizSelection, resetQuizWorkingState]);

  const toggleQuizLesson = useCallback((lessonId: string) => {
    setQuizSelection(prev => prev.includes(lessonId)
      ? prev.filter(id => id !== lessonId)
      : [...prev, lessonId]);
  }, []);

  const clearQuizSelection = useCallback(() => {
    setQuizSelection([]);
    resetQuizWorkingState();
    setQuizQuestions(null);
    setQuizStatus('');
    setQuizError('');
  }, [resetQuizWorkingState]);

  const handleRevealHint = useCallback(() => {
    setQuizHintVisible(true);
  }, []);

  const handleSubmitQuizAnswer = useCallback(() => {
    if (!quizQuestions) return;
    const question = quizQuestions[quizIndex];
    if (!question) return;

    if (question.type === 'spot_error') {
        if (!spotErrorSelection) {
            setQuizAnswerError('Please select a word.');
            return;
        }
        if (spotErrorSelection.word === question.errorWord) {
            setQuizScore(prev => prev + 1);
        }
    } else if (question.type === 'fill_blank') {
      const answer = quizTextAnswer.trim();
      if (!answer) {
        setQuizAnswerError('Enter your answer before checking.');
        return;
      }
      const acceptable = (question.acceptableAnswers ?? [])
        .map(entry => entry.trim())
        .filter(Boolean);
      const normalized = answer.toLocaleLowerCase();
      const matched = acceptable.some(entry =>
        entry.toLocaleLowerCase() === normalized ||
        entry.localeCompare(answer, undefined, { sensitivity: 'base' }) === 0
      );
      if (matched) {
        setQuizScore(prev => prev + 1);
      }
    } else if (question.type === 'categorize') {
      const items = question.classifiableItems ?? [];
      if (!items.length || !question.categories?.length) {
        setQuizAnswerError('This classification question is missing its categories.');
        return;
      }
      const allAnswered = items.every(item => quizCategoryAnswers[item.id]);
      if (!allAnswered) {
        setQuizAnswerError('Assign each item to a category before checking your answer.');
        return;
      }
      const allCorrect = items.every(item => quizCategoryAnswers[item.id] === item.correctCategoryId);
      if (allCorrect) {
        setQuizScore(prev => prev + 1);
      }
    } else if (question.type === 'sequence') {
      const isCorrect = quizSequenceAnswer.every((item, index) => item.correctOrder === index);
      if (isCorrect) {
        setQuizScore(prev => prev + 1);
      }
    } else {
      const options = question.options ?? [];
      if (!options.length) {
        setQuizAnswerError('This question is missing answer options.');
        return;
      }
      if (!quizSelectedOptions.length) {
        setQuizAnswerError('Select at least one option before checking your answer.');
        return;
      }
      const correctIds = options.filter(option => option.isCorrect).map(option => option.id);
      if (!correctIds.length) {
        setQuizAnswerError('This question has no correct options configured.');
        return;
      }
      let answeredCorrectly = false;
      if (question.type === 'multi_select') {
        const chosenSorted = [...new Set(quizSelectedOptions)].sort();
        const correctSorted = [...new Set(correctIds)].sort();
        answeredCorrectly = correctSorted.length === chosenSorted.length &&
          correctSorted.every((id, idx) => id === chosenSorted[idx]);
      } else {
        answeredCorrectly = quizSelectedOptions.length === 1 && correctIds.includes(quizSelectedOptions[0]);
      }
      if (answeredCorrectly) {
        setQuizScore(prev => prev + 1);
      }
    }

    setQuizShowFeedback(true);
    setQuizAnswerError('');
  }, [quizQuestions, quizIndex, quizTextAnswer, quizSelectedOptions, quizCategoryAnswers, quizSequenceAnswer, spotErrorSelection]);

  const handleNextQuestion = useCallback(() => {
    if (!quizQuestions) return;
    const nextIndex = quizIndex + 1;
    if (nextIndex >= quizQuestions.length) {
      setQuizCompleted(true);
    } else {
      setQuizIndex(nextIndex);
    }
    setQuizShowFeedback(false);
    setQuizSelectedOptions([]);
    setQuizTextAnswer('');
    setQuizCategoryAnswers({});
    setSpotErrorSelection(null);
    setQuizHintVisible(false);
    setQuizAnswerError('');
  }, [quizQuestions, quizIndex]);

  const handleRestartQuiz = useCallback(() => {
    resetQuizWorkingState();
  }, [resetQuizWorkingState]);

  const handleExitQuiz = useCallback(() => {
    resetQuizWorkingState();
    setQuizQuestions(null);
    setQuizSelection([]);
    setQuizStatus('');
    setQuizError('');
    setIsGeneratingQuiz(false);
  }, [resetQuizWorkingState]);

  const handleToggleOption = useCallback((optionId: string) => {
    if (!quizQuestions) return;
    const question = quizQuestions[quizIndex];
    if (!question || quizShowFeedback) return;
    if (question.type === 'multi_select') {
      setQuizSelectedOptions(prev => prev.includes(optionId)
        ? prev.filter(id => id !== optionId)
        : [...prev, optionId]);
    } else {
      setQuizSelectedOptions([optionId]);
    }
    setQuizAnswerError('');
  }, [quizQuestions, quizIndex, quizShowFeedback]);

  const handleCategorizeSelection = useCallback((itemId: string, categoryId: string) => {
    setQuizCategoryAnswers(prev => ({ ...prev, [itemId]: categoryId }));
    setQuizAnswerError('');
  }, []);

  const handleQuizTypeToggle = (quizType: QuizQuestionType) => {
    setSelectedQuizTypes(prev =>
      prev.includes(quizType)
        ? prev.filter(t => t !== quizType)
        : [...prev, quizType]
    );
  };
  
  const handleSpotErrorSelection = (word: string, index: number) => {
    if (quizShowFeedback) return;
    setSpotErrorSelection({ word, index });
    setQuizAnswerError('');
  };

  const selectAllQuizTypes = () => setSelectedQuizTypes(allQuizTypes);
  const unselectAllQuizTypes = () => setSelectedQuizTypes([]);

  const selectedLesson = useMemo(
    () => lessons.find(lesson => lesson.id === selectedLessonId) ?? null,
    [lessons, selectedLessonId]
  );

  const quizHasStoredQuestions = useMemo(() => {
    if (!quizSelection.length) return false;
    return aggregateSelectedQuizQuestions(lessons, quizSelection).length > 0;
  }, [lessons, quizSelection]);

  const renderUploadContent = () => {
    const isProcessing = appState === 'parsing' || appState === 'generating';

    return (
      <div className="w-full max-w-2xl mx-auto flex flex-col items-center gap-6">
        <FileUpload
          onFileSelect={handleFileSelect}
          onProgress={handleProgress}
          onParseStart={handleParseStart}
          onParseEnd={handleParseEnd}
          disabled={isProcessing}
          fileName={fileName}
        />
        {isProcessing && <ProgressBar step={progress.step} percentage={progress.percentage} />}
        {error && !isProcessing && (
          <div className="w-full bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-center gap-3">
            <ErrorIcon className="h-5 w-5 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}
        <div className="w-full flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={handleGenerateSheet}
            disabled={isProcessing || !documentText.trim()}
            className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${documentText.trim() && !isProcessing
                ? 'bg-sky-500 text-white hover:bg-sky-600'
                : 'bg-slate-700 text-slate-500 cursor-not-allowed'
            }`}
          >
            Generate revision sheet
          </button>
          <button
            type="button"
            onClick={() => setView('lessons')}
            disabled={!lessons.length}
            className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${lessons.length
                ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                : 'bg-slate-700 text-slate-500 cursor-not-allowed'
            }`}
          >
            View saved lessons ({lessons.length})
          </button>
        </div>
      </div>
    );
  };

  const renderSheetContent = () => {
    if (!sheetData) {
      return (
        <div className="w-full max-w-3xl mx-auto text-center bg-slate-800/40 border border-slate-700 rounded-2xl p-10">
          <p className="text-lg text-slate-300">No active sheet yet.</p>
          <p className="text-sm text-slate-500 mt-2">Upload a document to generate your first revision sheet.</p>
          <button
            type="button"
            onClick={() => setView('upload')}
            className="mt-6 inline-flex items-center justify-center px-5 py-2.5 rounded-full bg-sky-500 text-white font-semibold hover:bg-sky-600 transition-colors"
          >
            Go to upload
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-center gap-3">
            <ErrorIcon className="h-5 w-5 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleRefineCurrentSheet}
            className="px-5 py-2.5 rounded-full bg-sky-500 text-white font-semibold hover:bg-sky-600 transition-colors"
          >
            Refine sheet
          </button>
          <button
            type="button"
            onClick={() => setView('lessons')}
            className="px-5 py-2.5 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Manage lessons
          </button>
        </div>
        <RevisionSheet
          sheetData={sheetData}
          onRefine={handleRefineCurrentSheet}
          isRefining={appState === 'refining'}
        />
      </div>
    );
  };
  const renderLessonsContent = () => {
    if (!lessons.length) {
      return (
        <div className="w-full max-w-3xl mx-auto text-center bg-slate-800/40 border border-slate-700 rounded-2xl p-10">
          <p className="text-lg text-slate-300">No lessons saved yet.</p>
          <p className="text-sm text-slate-500 mt-2">Create a sheet from the Upload tab to see it here.</p>
          <button
            type="button"
            onClick={() => setView('upload')}
            className="mt-6 inline-flex items-center justify-center px-5 py-2.5 rounded-full bg-sky-500 text-white font-semibold hover:bg-sky-600 transition-colors"
          >
            Create a new sheet
          </button>
        </div>
      );
    }

    const activeLesson = selectedLesson ?? lessons[0];

    const formatDate = (timestamp: number) => {
      try {
        return new Date(timestamp).toLocaleString();
      } catch {
        return '';
      }
    };

    return (
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-slate-100">Saved lessons</h2>
          <div className="flex flex-col gap-3">
            {lessons.map(lesson => {
              const isActive = activeLesson && lesson.id === activeLesson.id;
              return (
                <div
                  key={lesson.id}
                  className={`rounded-2xl border ${isActive ? 'border-sky-500 bg-slate-800/60' : 'border-slate-700 bg-slate-800/40'} shadow-sm transition-colors`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedLessonId(lesson.id)}
                    className="w-full text-left px-5 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-slate-200 line-clamp-1">{lesson.title}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">{formatDate(lesson.updatedAt)}</span>
                    </div>
                    {lesson.fileName && (
                      <p className="text-xs text-slate-500 mt-1 truncate">Source: {lesson.fileName}</p>
                    )}
                  </button>
                  <div className="flex items-center justify-end gap-2 px-5 pb-4">
                    <button
                      type="button"
                      onClick={() => openLessonInWorkspace(lesson)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-full bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 transition-colors"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRefineStoredLesson(lesson.id)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-full bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors"
                    >
                      Refine
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (typeof window === 'undefined' || window.confirm('Delete this lesson?')) {
                          deleteLesson(lesson.id);
                        }
                      }}
                      className="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="space-y-4">
          {activeLesson ? (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-slate-100">{activeLesson.title}</h3>
                  <p className="text-xs text-slate-400">
                    Last updated: {formatDate(activeLesson.updatedAt)}
                    {activeLesson.fileName ? `  Source: ${activeLesson.fileName}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openLessonInWorkspace(activeLesson)}
                  className="px-4 py-2 rounded-md text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 transition-colors"
                >
                  Open in sheet tab
                </button>
              </div>
              {error && (
                <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-center gap-3">
                  <ErrorIcon className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
              )}
              <RevisionSheet
                sheetData={activeLesson.sheetData}
                onRefine={() => handleRefineStoredLesson(activeLesson.id)}
                isRefining={refiningLessonId === activeLesson.id}
              />
            </>
          ) : (
            <div className="bg-slate-800/40 border border-slate-700 rounded-2xl p-8 text-slate-300 text-center">
              Select a lesson from the list to display it.
            </div>
          )}
        </section>
      </div>
    );
  };
  const renderCategorizeQuestion = (question: QuizQuestion) => {
    const categories = question.categories ?? [];
    const items = question.classifiableItems ?? [];
    return (
      <div className="space-y-4">
        {items.map(item => (
          <div key={item.id} className="flex flex-col sm:flex-row sm:items-center gap-3 bg-slate-900/40 border border-slate-800 rounded-xl px-4 py-3">
            <div className="flex-1 text-sm text-slate-200">{item.label}</div>
            <select
              value={quizCategoryAnswers[item.id] ?? ''}
              disabled={quizShowFeedback}
              onChange={e => handleCategorizeSelection(item.id, e.target.value)}
              className="sm:w-64 bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            >
              <option value="">Select category…</option>
              {categories.map(category => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
            {quizShowFeedback && (
              <div className={`text-xs px-3 py-2 rounded-md border ${quizCategoryAnswers[item.id] === item.correctCategoryId
                  ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
                  : 'border-red-500 text-red-300 bg-red-500/10'}`}>
                {item.explanation || (
                  quizCategoryAnswers[item.id] === item.correctCategoryId
                    ? 'Correct classification.'
                    : 'Incorrect category.'
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderSequenceQuestion = (question: QuizQuestion) => {
    const items = quizSequenceAnswer;
    return (
      <div className="space-y-3">
        {items.map((item, index) => (
          <div key={item.id} className="flex items-center gap-4 p-3 border border-slate-700 bg-slate-800/40 rounded-xl">
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => handleMoveSequenceItem(index, 'up')}
                disabled={index === 0 || quizShowFeedback}
                className="p-1 rounded-md disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 hover:bg-slate-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
              </button>
              <button
                type="button"
                onClick={() => handleMoveSequenceItem(index, 'down')}
                disabled={index === items.length - 1 || quizShowFeedback}
                className="p-1 rounded-md disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 hover:bg-slate-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
            </div>
            <div className="flex-1 text-sm text-slate-200">{item.label}</div>
            {quizShowFeedback && (
              <div className={`text-xs px-3 py-2 rounded-md border ${item.correctOrder === index
                  ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
                  : 'border-red-500 text-red-300 bg-red-500/10'}`}>
                {item.explanation || (item.correctOrder === index ? 'Correct position' : `Should be #${item.correctOrder + 1}`)}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };
  
  const renderSpotErrorQuestion = (question: QuizQuestion) => {
    const words = question.prompt.split(/(\s+)/g);
    return (
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 leading-relaxed">
        {words.map((word, index) => {
          if (!word.trim()) {
            return <span key={index}>{word}</span>;
          }
          const isSelected = spotErrorSelection?.index === index;
          const isCorrect = quizShowFeedback && word === question.errorWord;
          const isIncorrectSelection = quizShowFeedback && isSelected && word !== question.errorWord;

          let wordClasses = 'px-2 py-1 rounded-md transition-colors cursor-pointer';
          if (quizShowFeedback) {
            if (isCorrect) {
              wordClasses += ' bg-green-500/30 text-green-300 border border-green-500';
            } else if (isIncorrectSelection) {
              wordClasses += ' bg-red-500/30 text-red-300 border border-red-500 line-through';
            } else {
              wordClasses += ' text-slate-300';
            }
          } else {
            if (isSelected) {
              wordClasses += ' bg-sky-500/30 text-sky-300 border border-sky-500';
            } else {
              wordClasses += ' bg-slate-800/50 hover:bg-slate-700/50';
            }
          }

          return (
            <button
              key={index}
              type="button"
              disabled={quizShowFeedback}
              onClick={() => handleSpotErrorSelection(word, index)}
              className={wordClasses}
            >
              {word}
            </button>
          );
        })}
      </div>
    );
  };

  const renderQuizQuestion = () => {
    if (!quizQuestions || !quizQuestions.length) {
      return (
        <div className="w-full max-w-3xl mx-auto text-center bg-slate-800/40 border border-slate-700 rounded-2xl p-10">
          <p className="text-lg text-slate-300">No questions yet.</p>
          <p className="text-sm text-slate-500 mt-2">Generate a quiz to start practicing.</p>
        </div>
      );
    }

    const question = quizQuestions[quizIndex];
    const lessonSource = lessons.find(lesson => lesson.id === question.lessonId)?.title || question.lessonId;
    const optionList = question.options ?? [];
    const normalizedAnswers = (question.acceptableAnswers ?? []).map(ans => ans.trim()).filter(Boolean);
    const userAnswerTrim = quizTextAnswer.trim();
    const correctOptionIds = optionList.filter(option => option.isCorrect).map(option => option.id);
    const isSelectionQuestion = question.type !== 'fill_blank' && question.type !== 'categorize' && question.type !== 'sequence' && question.type !== 'spot_error';
    const isMultiSelect = question.type === 'multi_select';
    
    let isAnswerCorrect = false;
    if (quizShowFeedback) {
        if (question.type === 'spot_error') {
            isAnswerCorrect = spotErrorSelection?.word === question.errorWord;
        } else if (question.type === 'sequence') {
            isAnswerCorrect = quizSequenceAnswer.every((item, index) => item.correctOrder === index);
        } else if (question.type === 'categorize') {
            isAnswerCorrect = (question.classifiableItems ?? []).every(item => quizCategoryAnswers[item.id] && quizCategoryAnswers[item.id] === item.correctCategoryId);
        } else if (question.type === 'fill_blank') {
            isAnswerCorrect = normalizedAnswers.some(ans => ans.toLocaleLowerCase() === userAnswerTrim.toLocaleLowerCase() || ans.localeCompare(userAnswerTrim, undefined, { sensitivity: 'base' }) === 0);
        } else {
            const hasPerfectSelection = isMultiSelect
                ? correctOptionIds.every(id => quizSelectedOptions.includes(id)) && quizSelectedOptions.every(id => correctOptionIds.includes(id)) && correctOptionIds.length === quizSelectedOptions.length
                : quizSelectedOptions.length === 1 && correctOptionIds.includes(quizSelectedOptions[0]);
            isAnswerCorrect = hasPerfectSelection;
        }
    }

    const disableCheck = question.type === 'spot_error'
      ? !spotErrorSelection
      : question.type === 'fill_blank'
        ? quizTextAnswer.trim().length === 0
        : question.type === 'categorize'
          ? (question.classifiableItems ?? []).some(item => !quizCategoryAnswers[item.id])
          : question.type === 'sequence'
            ? false
            : quizSelectedOptions.length === 0;

    
    const typeInfo = typeMetadata[question.type] ?? typeMetadata.single_choice;
    const difficultyLabel = question.difficulty ? question.difficulty.trim() : '';
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>Question {quizIndex + 1} of {quizQuestions.length}</span>
          <span>Score: {quizScore}</span>
        </div>
        <div className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 space-y-6">
          <div className="space-y-2">
            <div className="space-y-1">
              <p className="text-lg font-semibold text-slate-100">{question.type !== 'spot_error' && question.prompt}</p>
              <p className="text-xs text-slate-500">Lesson source: {lessonSource}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-slate-700 bg-slate-900/40">
                {typeInfo.label}
              </span>
              {difficultyLabel && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-slate-700 bg-slate-900/40">
                  Difficulty: {difficultyLabel}
                </span>
              )}
              {question.tags?.map((tag, idx) => (
                <span
                  key={`${tag || 'tag'}-${idx}`}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-slate-700 bg-slate-900/40"
                >
                  {tag}
                </span>
              ))}
            </div>
            <p className="text-xs text-slate-500">{typeInfo.instruction}</p>
            {question.hint && !quizShowFeedback && (
              <button
                type="button"
                onClick={handleRevealHint}
                disabled={quizHintVisible}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${quizHintVisible ? 'border-slate-700 text-slate-500 cursor-not-allowed' : 'border-sky-500 text-sky-300 hover:bg-sky-500/10'}`}
              >
                {quizHintVisible ? 'Hint shown' : 'Show hint'}
              </button>
            )}
            {quizHintVisible && question.hint && (
              <div className="text-sm text-slate-200 bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3">
                {question.hint}
              </div>
            )}
          </div>
          {question.type === 'spot_error' ? (
            renderSpotErrorQuestion(question)
          ) : question.type === 'sequence' ? (
            renderSequenceQuestion(question)
          ) : question.type === 'categorize' ? (
            renderCategorizeQuestion(question)
          ) : question.type === 'fill_blank' ? (
            <div className="space-y-4">
              <input
                type="text"
                value={quizTextAnswer}
                onChange={e => setQuizTextAnswer(e.target.value)}
                disabled={quizShowFeedback}
                placeholder="Type the missing text..."
                className="w-full px-4 py-3 rounded-xl border border-slate-700 bg-slate-800/40 text-slate-100 focus:outline-none focus:border-sky-500 focus:bg-slate-800/60 transition-colors"
              />
            </div>
          ) : (
            <div className="space-y-3">
              {optionList.map((option, optionIndex) => {
                const letter = String.fromCharCode(65 + optionIndex);
                const isSelected = quizSelectedOptions.includes(option.id);
                const isCorrect = option.isCorrect;
                let optionClasses = 'w-full text-left px-4 py-3 border rounded-xl transition-colors';
                if (quizShowFeedback) {
                  if (isCorrect) {
                    optionClasses += ' border-green-500 bg-green-500/10';
                  } else if (isSelected) {
                    optionClasses += ' border-red-500 bg-red-500/10';
                  } else {
                    optionClasses += ' border-slate-700 bg-slate-800/40';
                  }
                } else if (isSelected) {
                  optionClasses += ' border-sky-500 bg-slate-800/60';
                } else {
                  optionClasses += ' border-slate-700 bg-slate-800/40 hover:border-sky-500';
                }
                return (
                  <div key={option.id} className="space-y-2">
                    <button
                      type="button"
                      disabled={quizShowFeedback}
                      onClick={() => handleToggleOption(option.id)}
                      className={optionClasses}
                    >
                      <span className="font-semibold text-slate-100">{letter}. {option.text}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {!quizShowFeedback && quizAnswerError && (
            <div className="text-xs text-red-400 pl-1">{quizAnswerError}</div>
          )}
          {quizShowFeedback && (
            <div className="text-sm text-slate-300">
              {isAnswerCorrect ? 'Correct! Great job.' : 'That was not the right answer. Review the explanations above before continuing.'}
            </div>
          )}
          {quizShowFeedback && question.explanation && (
            <div className="text-sm text-slate-200 bg-slate-800/40 border border-slate-700 rounded-lg px-3 py-2">
              {question.explanation}
            </div>
          )}
          <div className="flex justify-end gap-3">
            {!quizShowFeedback ? (
              <button
                type="button"
                onClick={handleSubmitQuizAnswer}
                className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${disableCheck ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-sky-500 text-white hover:bg-sky-600'}`}
                disabled={disableCheck}
              >
                Check answer
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNextQuestion}
                className="px-5 py-2.5 rounded-full text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 transition-colors"
              >
                {quizIndex === quizQuestions.length - 1 ? 'Finish quiz' : 'Next question'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };
  const renderQuizContent = () => {
    if (!lessons.length) {
      return (
        <div className="w-full max-w-3xl mx-auto text-center bg-slate-800/40 border border-slate-700 rounded-2xl p-10">
          <p className="text-lg text-slate-300">No lessons available yet.</p>
          <p className="text-sm text-slate-500 mt-2">Generate a revision sheet from the Upload tab, then come back here to build a quiz.</p>
          <button
            type="button"
            onClick={() => setView('upload')}
            className="mt-6 inline-flex items-center justify-center px-5 py-2.5 rounded-full bg-sky-500 text-white font-semibold hover:bg-sky-600 transition-colors"
          >
            Go to Upload
          </button>
        </div>
      );
    }

    if (!quizQuestions) {
      return (
        <div className="space-y-6">
          <div className="bg-slate-800/40 border border-slate-700 rounded-2xl p-5 text-sm text-slate-300">
            {quizSelection.length === 0
              ? 'Select the lessons you want to include in your next quiz.'
              : `${quizSelection.length} lesson(s) selected.`}
          </div>
          <div className="space-y-3">
            {lessons.map(lesson => {
              const checked = quizSelection.includes(lesson.id);
              let formatted = '';
              try {
                formatted = new Date(lesson.updatedAt).toLocaleString();
              } catch {}
              return (
                <label
                  key={lesson.id}
                  className={`flex items-center justify-between gap-4 px-5 py-3 rounded-2xl border ${checked ? 'border-sky-500 bg-slate-800/60' : 'border-slate-700 bg-slate-800/40'} transition-colors`}
                >
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-100">{lesson.title}</p>
                    {formatted && (<p className="text-xs text-slate-500">Updated {formatted}</p>)}
                    {lesson.fileName && (<p className="text-xs text-slate-500">Source: {lesson.fileName}</p>)}
                    {lesson.quizBank?.length ? (
                      <p className="text-xs text-emerald-400">Saved questions: {lesson.quizBank.length}</p>
                    ) : null}
                  </div>
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-sky-500"
                    checked={checked}
                    onChange={() => toggleQuizLesson(lesson.id)}
                  />
                </label>
              );
            })}
          </div>
          <div className="bg-slate-800/40 border border-slate-700 rounded-2xl p-5 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Quiz Size</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuizSize('small')}
                  className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${quizSize === 'small' ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  Small
                </button>
                <button
                  type="button"
                  onClick={() => setQuizSize('medium')}
                  className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${quizSize === 'medium' ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  Medium
                </button>
                <button
                  type="button"
                  onClick={() => setQuizSize('complete')}
                  className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${quizSize === 'complete' ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  Complete
                </button>
              </div>
            </div>
          </div>
          <div className="bg-slate-800/40 border border-slate-700 rounded-2xl p-5 space-y-4">
            <h3 className="text-lg font-semibold text-slate-200">Question Types</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {allQuizTypes.map(quizType => (
                <label key={quizType} className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-sky-500"
                    checked={selectedQuizTypes.includes(quizType)}
                    onChange={() => handleQuizTypeToggle(quizType)}
                  />
                  {typeMetadata[quizType].label}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button type="button" onClick={selectAllQuizTypes} className="text-xs font-semibold text-sky-400 hover:text-sky-300">
                Select All
              </button>
              <button type="button" onClick={unselectAllQuizTypes} className="text-xs font-semibold text-slate-400 hover:text-slate-300">
                Unselect All
              </button>
            </div>
          </div>
          {quizError && (
            <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg text-sm">
              {quizError}
            </div>
          )}
          {isGeneratingQuiz ? (
            <div className="px-5 py-3 rounded-2xl border border-slate-700 bg-slate-800/40 text-slate-300 text-sm">
              {quizStatus || 'Generating quiz...'}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleGenerateQuiz}
                disabled={quizSelection.length === 0 || isGeneratingQuiz}
                className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${quizSelection.length === 0 || isGeneratingQuiz ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-sky-500 text-white hover:bg-sky-600'}`}
              >
                Generate quiz (adds new questions)
              </button>
              <button
                type="button"
                onClick={handleLoadSavedQuiz}
                disabled={!quizHasStoredQuestions}
                className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${quizHasStoredQuestions ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-700 text-slate-500 cursor-not-allowed'}`}
              >
                Load saved quiz
              </button>
              <button
                type="button"
                onClick={handleDeleteQuiz}
                disabled={!quizHasStoredQuestions}
                className={`px-5 py-2.5 rounded-full text-sm font-semibold transition-colors ${quizHasStoredQuestions ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-slate-700 text-slate-500 cursor-not-allowed'}`}
              >
                Delete saved quiz
              </button>
              {quizSelection.length > 0 && (
                <button
                  type="button"
                  onClick={clearQuizSelection}
                  className="px-4 py-2 rounded-md bg-slate-800 border border-slate-600 text-slate-200 text-sm hover:bg-slate-700 transition-colors"
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
    if (quizCompleted) {
      return (
        <div className="max-w-3xl mx-auto space-y-6 text-center">
          <div className="bg-slate-800/40 border border-slate-700 rounded-2xl p-8 space-y-4">
            <h2 className="text-2xl font-semibold text-slate-100">Quiz complete!</h2>
            <p className="text-slate-300">You answered {quizScore} out of {quizQuestions.length} question(s) correctly.</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleRestartQuiz}
              className="px-5 py-2.5 rounded-full bg-sky-500 text-white font-semibold hover:bg-sky-600 transition-colors"
            >
              Restart quiz
            </button>
            <button
              type="button"
              onClick={handleExitQuiz}
              className="px-4 py-2 rounded-md bg-slate-800 border border-slate-600 text-slate-200 text-sm hover:bg-slate-700 transition-colors"
            >
              Back to selection
            </button>
          </div>
        </div>
      );
    }

    return renderQuizQuestion();
  };

  const hasActiveSheet = Boolean(sheetData);
  const navButtonClasses = (target: ViewMode, disabled = false) => {
    const base = 'px-5 py-2.5 rounded-full text-sm font-semibold transition-colors';
    if (disabled) {
      return `${base} bg-slate-700 text-slate-500 cursor-not-allowed`;
    }
    return view === target
      ? `${base} bg-sky-500 text-white shadow-lg shadow-sky-500/30`
      : `${base} bg-slate-800 text-slate-300 hover:bg-slate-700`;
  };
  return (
    <div className="bg-slate-900 text-slate-200 min-h-screen font-sans">
      <main className="container mx-auto px-4 py-8 sm:py-12">
        <header className="mb-8 relative">
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex justify-center items-center gap-3">
              <BrainCircuitIcon className="w-12 h-12 text-sky-400" />
              <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight">
                AI Revision Sheet <span className="bg-gradient-to-r from-sky-400 to-cyan-400 text-transparent bg-clip-text">Generator</span>
              </h1>
            </div>
            <p className="max-w-3xl text-lg text-slate-400">
              Upload your notes, generate structured revision sheets, and access every lesson in one place.
            </p>
            <nav className="flex flex-wrap items-center justify-center gap-3">
              <button type="button" onClick={() => setView('upload')} className={navButtonClasses('upload')}>
                Upload
              </button>
              <button
                type="button"
                onClick={() => hasActiveSheet && setView('sheet')}
                className={navButtonClasses('sheet', !hasActiveSheet)}
                disabled={!hasActiveSheet}
              >
                Active sheet
              </button>
              <button
                type="button"
                onClick={() => setView('quiz')}
                className={navButtonClasses('quiz', lessons.length === 0)}
                disabled={lessons.length === 0}
              >
                Quiz
              </button>
              <button
                type="button"
                onClick={() => setView('lessons')}
                className={navButtonClasses('lessons')}
              >
                Lessons ({lessons.length})
              </button>
            </nav>
          </div>
          <div className="absolute top-0 right-0 sm:top-2 sm:right-2">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors"
              aria-label="Open settings"
            >
              <SettingsIcon className="w-6 h-6 text-slate-400" />
            </button>
          </div>
        </header>

        {view === 'upload' && (
          <div className="w-full max-w-2xl mx-auto mb-8">
            <label htmlFor="language-select" className="block text-sm font-medium text-slate-300 mb-2">
              Generation language
            </label>
            <select
              id="language-select"
              value={settings.language ?? 'en'}
              onChange={e => setSettings(prev => ({ ...prev, language: e.target.value }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            >
              {languageOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">All generated sheets and quizzes will use this language.</p>
          </div>
        )}

        {view === 'upload' && renderUploadContent()}
        {view === 'sheet' && renderSheetContent()}
        {view === 'quiz' && renderQuizContent()}
        {view === 'lessons' && renderLessonsContent()}
      </main>
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
      />
    </div>
  );
};

export default App;